/**
 * Portal engagement core — the stage machine, the matcher and the
 * next-action engine behind the Margin Defense desk.
 *
 * Why this module exists: the landing page closes the deal, Vertebra runs
 * the audit, and the desk is where money becomes work. Everything the desk
 * renders about *what to do next* derives from here, so the webhook route,
 * the PATCH route and the UI can never disagree about the contract.
 *
 * Pure logic only: no DB, no React. Stage guards mirror the schema comment.
 */

// --------------------------------------------------------------------------- //
// Stage machine
// --------------------------------------------------------------------------- //

export const ENGAGEMENT_STAGES = [
  "paid", // money arrived — nothing worked yet
  "intake", // contacts + quote volume confirmed with the client
  "forensics", // legacy documents collected and parsed
  "verdict", // leakage modeled; the $10k guarantee decision recorded
  "delivered", // audit deliverable sent
  "sow", // converted to the enterprise SOW
  "closed", // terminal
] as const;

export type EngagementStage = (typeof ENGAGEMENT_STAGES)[number];

/**
 * Adjacent moves the desk may make. Forward-only with one-step back before
 * the commitment point (delivered) — forgiving, but the ledger records every
 * move. `delivered` is one-way: the deliverable left the building.
 */
export const STAGE_TRANSITIONS: Record<EngagementStage, EngagementStage[]> = {
  paid: ["intake"],
  intake: ["paid", "forensics"],
  forensics: ["intake", "verdict"],
  verdict: ["forensics", "delivered"],
  delivered: ["sow", "closed"],
  sow: ["closed"],
  closed: [],
};

export function isEngagementStage(v: string): v is EngagementStage {
  return (ENGAGEMENT_STAGES as readonly string[]).includes(v);
}

/** True when the engagement may legally move `from` → `to`. */
export function canTransition(from: string, to: string): boolean {
  if (!isEngagementStage(from) || !isEngagementStage(to)) return false;
  return STAGE_TRANSITIONS[from].includes(to);
}

/** Human label per stage — desk chips, queue rows, event trail. */
export const STAGE_LABELS: Record<EngagementStage, string> = {
  paid: "Paid",
  intake: "Intake",
  forensics: "Forensics",
  verdict: "Verdict",
  delivered: "Delivered",
  sow: "SOW",
  closed: "Closed",
};

// --------------------------------------------------------------------------- //
// Next-action engine — the desk's purpose in one function
// --------------------------------------------------------------------------- //

/** Minimal shape the engine needs — satisfied by both DB rows and snapshot rows. */
export interface EngagementLike {
  status: string;
  contactName: string | null;
  contactEmail: string | null;
  intakeRfqPerMonth: number | null;
  intakeLineItems: number | null;
  documentCount?: number;
  guaranteeCleared?: boolean | null;
  confirmedLeakageUsd?: number | null;
  deliverableUrl?: string | null;
}

export interface NextAction {
  /** Plain-words imperative — the queue renders this verbatim. */
  action: string;
  /** Stable key for chips and keyboard hints. */
  key:
    | "run_intake"
    | "collect_docs"
    | "model_leakage"
    | "record_verdict"
    | "generate_deliverable"
    | "convert_or_close"
    | "awaiting_sow"
    | "done";
}

/**
 * What the operator should do with this engagement right now. The desk never
 * makes the operator reconstruct state from chips — this is the single source
 * of "next".
 */
export function nextActionFor(e: EngagementLike): NextAction {
  switch (e.status) {
    case "paid":
      return e.contactName && e.contactEmail
        ? { action: "Confirm quote volume, then open intake", key: "run_intake" }
        : { action: "Run intake — confirm contacts & quote volume", key: "run_intake" };
    case "intake": {
      const volume = e.intakeRfqPerMonth != null && e.intakeLineItems != null;
      return volume
        ? { action: "Collect legacy documents — drop quote PDFs & cost sheets", key: "collect_docs" }
        : { action: "Record monthly RFQ volume & avg line items", key: "run_intake" };
    }
    case "forensics": {
      const docs = e.documentCount ?? 0;
      return docs === 0
        ? { action: "Drop the first legacy document to begin forensics", key: "collect_docs" }
        : { action: `Model leakage — ${docs} document${docs === 1 ? "" : "s"} on file`, key: "model_leakage" };
    }
    case "verdict":
      return e.guaranteeCleared != null && e.confirmedLeakageUsd != null
        ? { action: "Generate & send the audit deliverable", key: "generate_deliverable" }
        : { action: "Record verdict — does confirmed leakage clear the $10,000 floor?", key: "record_verdict" };
    case "delivered":
      return { action: "Convert to SOW or close the engagement", key: "convert_or_close" };
    case "sow":
      return { action: "SOW live — engagement tracked to recovery ops", key: "awaiting_sow" };
    case "closed":
      return { action: "Engagement closed", key: "done" };
    default:
      return { action: "Review engagement state", key: "done" };
  }
}

// --------------------------------------------------------------------------- //
// Client matching — paid client → existing prospect, zero re-entry
// --------------------------------------------------------------------------- //

/** "https://www.GulfCoastValve.com/quote" → "gulfcoastvalve.com" */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0];
  if (!s || !s.includes(".") || s.includes(" ") || s.length > 253) return null;
  return s;
}

/** "Gulf Coast Valve & Fitting Co." → "gulf coast valve fitting co" */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Name-token overlap ≥ 2 meaningful words — the honest fallback match. */
export function namesLikelySame(a: string, b: string): boolean {
  const STOP = new Set(["the", "and", "co", "company", "inc", "llc", "ltd", "group", "of", "supply", "industrial"]);
  const ta = normalizeName(a).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  const tb = new Set(normalizeName(b).split(" "));
  const hits = ta.filter((w) => tb.has(w));
  return hits.length >= 2;
}

export interface MatchCandidate {
  id: string;
  name: string;
  domain: string | null;
}

export interface MatchResult {
  prospectId: string | null;
  /** How the match was made — recorded on the ledger event. */
  via: "domain" | "name" | null;
}

/**
 * Auto-match a paid client onto the existing book. Domain first (exact,
 * case-insensitive, normalized); then a conservative name-token fallback.
 * Returns null via null when the client is a stranger — the desk then offers
 * to create the prospect instead of guessing.
 */
export function matchClient(candidates: MatchCandidate[], clientName: string, clientDomain?: string | null): MatchResult {
  const dom = normalizeDomain(clientDomain);
  if (dom) {
    const hit = candidates.find((c) => normalizeDomain(c.domain) === dom);
    if (hit) return { prospectId: hit.id, via: "domain" };
  }
  if (clientName && normalizeName(clientName).length >= 4) {
    const hit = candidates.find((c) => namesLikelySame(clientName, c.name));
    if (hit) return { prospectId: hit.id, via: "name" };
  }
  return { prospectId: null, via: null };
}

// --------------------------------------------------------------------------- //
// Money & SLA — desk readouts
// --------------------------------------------------------------------------- //

export function ageDays(paidAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - paidAtMs) / 86_400_000));
}

/**
 * Queue weight — money waiting × urgency. The desk sorts by this: a $3,500
 * engagement sitting 12 days outranks a fresh one; an undecided guarantee
 * (exposure on the contract) outranks a decided one at equal age.
 */
export function queueWeight(e: EngagementLike & { amountUsd: number; paidAtMs: number; ageBias?: number }, nowMs: number): number {
  const age = ageDays(e.paidAtMs, nowMs);
  const undecided = e.status === "verdict" && e.guaranteeCleared == null ? 1.25 : 1;
  const active = e.status === "closed" ? 0.1 : 1;
  return e.amountUsd * (1 + age / 30) * undecided * active;
}
