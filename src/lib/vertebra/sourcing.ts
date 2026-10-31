/**
 * Sourcing spoke — the "WHO do we email" brain.
 *
 * The contact resolver answers "what is the email of a contact the enclave
 * already believes in". This spoke answers the question one step upstream:
 * which people should the enclave believe in at all. One job, three laws:
 *
 *   1. Search costs nothing, reveal costs credits. Apollo people search
 *      burns no email credits — so search is free, bulk, and honest. Money
 *      only moves when a staged candidate at or above the reveal bar goes
 *      through the resolver, and the resolver re-runs its own registry gate.
 *   2. The pre-contact score is honest about being partial. Five
 *      firmographic factors (vertical · erp · size · region · title) — 18%
 *      of the full QLV weight is scoreable before any contact, so this fit
 *      score is its own scale, not a fake QLV. The reveal bar (70) mirrors
 *      CHANNEL_A_MIN_SCORE because both are the same gesture: no money
 *      below the bar.
 *   3. Fixtures are labeled or they are lies. A staging batch (no key on
 *      disk) runs on fixture people with `.example.com` domains and is
 *      marked mode="staging", batchId "fixture:…" — it can stage, score,
 *      queue and dismiss, but a reveal still walks the real resolver gate
 *      and refuses with its named reason. Staging when the provider is
 *      armed refuses too: fixtures were never meant to outrun the truth.
 *
 * The Apollo wire format is pinned by the fixtures — a provider changing
 * their response shape breaks a test before it breaks a batch.
 */
import { db } from "@/lib/db";
import { resolveIntegrationGate, recordIntegrationSuccess, recordIntegrationFailure, type Transport } from "@/lib/vertebra/integrations";
import { resolveContact } from "@/lib/vertebra/contacts";

/* ------------------------------------------------------------------ icp -- */

export interface SourcingIcp {
  /** Buyer titles worth emailing — "VP of Sales", "Branch Manager", … */
  titles: string[];
  /** Vertical terms — matched against org industry, keywords, and name. */
  industries: string[];
  /** Region terms — matched against the person's location. */
  regions: string[];
  employeeMin: number;
  employeeMax: number;
  /** ERP / stack tags — "prophet 21", "infor", "eclipse", … */
  erpKeywords: string[];
}

/** The house ICP: industrial distribution with quoting pain. */
export const DEFAULT_ICP: SourcingIcp = {
  titles: ["VP of Sales", "Sales Operations", "Sales Director", "General Manager", "Branch Manager"],
  industries: ["industrial distribution", "plumbing and heating", "electrical wholesale", "hvac", "pvf"],
  regions: ["Texas", "Ontario"],
  employeeMin: 20,
  employeeMax: 500,
  erpKeywords: ["prophet 21", "p21", "infor", "eclipse", "epicor", "sap"],
};

/* ----------------------------------------------------------------- rubric -- */

export const SOURCING_FIT_WEIGHTS = {
  vertical: 0.35,
  erp: 0.2,
  size: 0.15,
  region: 0.15,
  title: 0.15,
} as const;

export const REVEAL_BAR = 70;

export interface SourcingFitFactor {
  key: keyof typeof SOURCING_FIT_WEIGHTS;
  weight: number;
  points: number; // 0 | 0.5 | 1 — the fraction of the factor's weight earned
  evidence: string;
}

export interface SourcingFit {
  fitScore: number; // 0–100
  factors: SourcingFitFactor[];
}

const hasAny = (haystack: string, needles: string[]): string | null => {
  const h = haystack.toLowerCase();
  for (const n of needles) if (h.includes(n.toLowerCase())) return n;
  return null;
};

/**
 * The pre-contact fit rubric — pure, deterministic, DB-free (the pipeline
 * doctrine: the math lives here so vitest can hammer it). Each factor earns
 * full, half, or no credit; the score is the weighted sum. The evidence
 * strings name the exact term that matched, so a fit score is auditable.
 */
export function scoreSourcingFit(person: SourcingPerson, icp: SourcingIcp): SourcingFit {
  const org = person.organization ?? null;
  const orgText = [org?.industry ?? "", (org?.keywords ?? []).join(" "), org?.name ?? ""].join(" ");
  const factors: SourcingFitFactor[] = [];

  const verticalHit = orgText.trim() ? hasAny(orgText, icp.industries) : null;
  factors.push({
    key: "vertical",
    weight: SOURCING_FIT_WEIGHTS.vertical,
    points: verticalHit ? 1 : 0,
    evidence: verticalHit ? `industry/keywords match "${verticalHit}"` : `no ICP vertical in "${orgText.trim() || "no organization"}"`,
  });

  const erpHit = orgText.trim() ? hasAny(orgText, icp.erpKeywords) : null;
  factors.push({
    key: "erp",
    weight: SOURCING_FIT_WEIGHTS.erp,
    points: erpHit ? 1 : 0,
    evidence: erpHit ? `stack tag "${erpHit}"` : "no legacy-ERP signal",
  });

  const emp = org?.estimated_num_employees ?? null;
  const inBand = emp != null && emp >= icp.employeeMin && emp <= icp.employeeMax;
  const nearBand = emp != null && !inBand && emp >= icp.employeeMin / 2 && emp <= icp.employeeMax * 2;
  factors.push({
    key: "size",
    weight: SOURCING_FIT_WEIGHTS.size,
    points: inBand ? 1 : nearBand ? 0.5 : 0,
    evidence: emp == null ? "employee count unknown" : `${emp} employees vs band ${icp.employeeMin}–${icp.employeeMax}${inBand ? "" : nearBand ? " (adjacent)" : " (outside)"}`,
  });

  const locationText = person.location ?? "";
  const regionHit = locationText.trim() ? hasAny(locationText, icp.regions) : null;
  factors.push({
    key: "region",
    weight: SOURCING_FIT_WEIGHTS.region,
    points: regionHit ? 1 : 0,
    evidence: regionHit ? `location matches "${regionHit}"` : `location "${locationText.trim() || "unknown"}" outside ICP regions`,
  });

  const titleText = person.title ?? "";
  const titleFull = titleText.trim() ? hasAny(titleText, icp.titles) : null;
  const titleHalf = !titleFull && titleText.trim() ? hasAny(titleText, ["sales", "operations", "purchasing", "procurement"]) : null;
  factors.push({
    key: "title",
    weight: SOURCING_FIT_WEIGHTS.title,
    points: titleFull ? 1 : titleHalf ? 0.5 : 0,
    evidence: titleFull ? `title matches "${titleFull}"` : titleHalf ? `title partially matches "${titleHalf}"` : `title "${titleText.trim() || "unknown"}" is not a buyer`,
  });

  const raw = factors.reduce((sum, f) => sum + f.weight * f.points, 0);
  const fitScore = Math.round(raw * 100);
  return { fitScore, factors };
}

/* ------------------------------------------------------------------- wire -- */

/** The Apollo people-search wire shape — pinned by the fixtures below. */
export interface SourcingPerson {
  id: string;
  name: string;
  title: string | null;
  location: string | null;
  organization: {
    name: string | null;
    primary_domain: string | null;
    website_url: string | null;
    industry: string | null;
    estimated_num_employees: number | null;
    keywords: string[];
  } | null;
}

interface ApolloSearchResponse {
  people?: SourcingPerson[];
  pagination?: { page?: number; per_page?: number; total_entries?: number };
}

export const APOLLO_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/search";
const SEARCH_TIMEOUT_MS = 15_000;
const PER_PAGE = 25;

export function buildApolloSearchBody(icp: SourcingIcp, page = 1): Record<string, unknown> {
  return {
    person_titles: icp.titles,
    person_locations: icp.regions,
    organization_num_employees_ranges: [`${icp.employeeMin},${icp.employeeMax}`],
    q_organization_keyword_tags: [...icp.industries, ...icp.erpKeywords],
    page,
    per_page: PER_PAGE,
    reveal_personal_emails: false,
  };
}

export async function apolloPeopleSearch(
  icp: SourcingIcp,
  { apiKey, transport, page = 1 }: { apiKey: string; transport: Transport; page?: number },
): Promise<{ people: SourcingPerson[]; total: number }> {
  const res = await transport(APOLLO_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    body: JSON.stringify(buildApolloSearchBody(icp, page)),
  });
  if (!res.ok) {
    throw new Error(`apollo_http_${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const data = (await res.json()) as ApolloSearchResponse;
  if (!Array.isArray(data.people)) {
    throw new Error("apollo_wire_shape: response.people missing — the wire contract moved; fixtures in tests/sourcing.test.ts pin the expected shape");
  }
  return { people: data.people, total: data.pagination?.total_entries ?? data.people.length };
}

/* ---------------------------------------------------------------- fixtures -- */

/**
 * Fixture people — fictional industrial-distribution land. Domains end in
 * .example.com so a staging batch can never collide with a real prospect,
 * and the shape of this array IS the Apollo wire contract the adapter
 * parses. One person deliberately carries no organization (skipped, never
 * staged), and the fit spread runs 100 → below-bar on purpose.
 */
export const FIXTURE_PEOPLE: SourcingPerson[] = [
  {
    id: "fx-01",
    name: "Dale Merritt",
    title: "VP of Sales",
    location: "Houston, Texas",
    organization: {
      name: "Ironvale Pipe & Supply",
      primary_domain: "ironvalepipe.example.com",
      website_url: "https://ironvalepipe.example.com",
      industry: "industrial distribution",
      estimated_num_employees: 240,
      keywords: ["prophet 21", "pvf", "wholesale"],
    },
  },
  {
    id: "fx-02",
    name: "Priya Nair",
    title: "Director of Sales Operations",
    location: "Dallas, Texas",
    organization: {
      name: "BlueRidge Bearing Co",
      primary_domain: "blueridgebearing.example.com",
      website_url: "https://blueridgebearing.example.com",
      industry: "industrial distribution",
      estimated_num_employees: 180,
      keywords: ["infor", "bearings", "power transmission"],
    },
  },
  {
    id: "fx-03",
    name: "Curtis Okafor",
    title: "General Manager",
    location: "Fort Worth, Texas",
    organization: {
      name: "Lone Star HVAC Supply",
      primary_domain: "lonestarhvac.example.com",
      website_url: "https://lonestarhvac.example.com",
      industry: "hvac",
      estimated_num_employees: 95,
      keywords: ["eclipse", "hvac distribution"],
    },
  },
  {
    id: "fx-04",
    name: "Marisol Vega",
    title: "Branch Manager",
    location: "Toronto, Ontario",
    organization: {
      name: "Cascade Electrical Wholesale",
      primary_domain: "cascadeelectric.example.com",
      website_url: "https://cascadeelectric.example.com",
      industry: "electrical wholesale",
      estimated_num_employees: 320,
      keywords: ["epicor", "electrical"],
    },
  },
  {
    id: "fx-05",
    name: "Otto Brandt",
    title: "Sales Operations Manager",
    location: "Mississauga, Ontario",
    organization: {
      name: "Meridian Fluid Power",
      primary_domain: "meridianfluid.example.com",
      website_url: "https://meridianfluid.example.com",
      industry: "industrial distribution",
      estimated_num_employees: 140,
      keywords: ["prophet 21", "hydraulics"],
    },
  },
  {
    id: "fx-06",
    name: "June Castellanos",
    title: "General Manager",
    location: "Houston, Texas",
    organization: {
      name: "Gulf Coast Valve & Fitting",
      primary_domain: "gulfcoastvf.example.com",
      website_url: "https://gulfcoastvf.example.com",
      industry: "pvf",
      estimated_num_employees: 410,
      keywords: ["p21", "valves", "fittings"],
    },
  },
  {
    id: "fx-07",
    name: "Hank Colton",
    title: "VP Sales",
    location: "Sacramento, California",
    organization: {
      name: "Redwood Propane Exchange",
      primary_domain: "redwoodpropane.example.com",
      website_url: "https://redwoodpropane.example.com",
      industry: "propane distribution",
      estimated_num_employees: 210,
      keywords: ["propane"],
    },
  },
  {
    id: "fx-08",
    name: "Roy Dial",
    title: "Director of Purchasing",
    location: "Hamilton, Ontario",
    organization: {
      name: "Northgate Fasteners",
      primary_domain: "northgatefast.example.com",
      website_url: "https://northgatefast.example.com",
      industry: "fasteners",
      estimated_num_employees: 150,
      keywords: ["sap", "fasteners"],
    },
  },
  {
    id: "fx-09",
    name: "Wilma Reyes",
    title: "Office Manager",
    location: "Houston, Texas",
    organization: {
      name: "Summit Office Interiors",
      primary_domain: "summitoffice.example.com",
      website_url: "https://summitoffice.example.com",
      industry: "office furniture",
      estimated_num_employees: 60,
      keywords: ["furniture"],
    },
  },
  {
    id: "fx-10",
    name: "Tessa Lang",
    title: "Procurement Lead",
    location: "Austin, Texas",
    organization: null,
  },
];

/* ------------------------------------------------------------------ stage -- */

export function domainKeyFor(orgName: string | null, domain: string | null): string {
  if (domain && domain.trim()) return domain.trim().toLowerCase();
  return (orgName ?? "unknown-org").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "unknown-org";
}

export interface StageInput {
  icp: SourcingIcp;
  actor: string;
  mode: "live" | "staging";
  transport?: Transport;
}

export interface StageCandidateView {
  candidateId: string;
  prospectId: string;
  person: string;
  title: string | null;
  organization: string;
  domain: string | null;
  fitScore: number;
  factors: SourcingFitFactor[];
  revealEligible: boolean;
  stage: string;
}

export type StageOutcome =
  | { ok: true; mode: "live" | "staging"; batchId: string; staged: number; skipped: number; wireTotal: number; gateNote: string | null; candidates: StageCandidateView[] }
  | { ok: false; reason: string };

/**
 * Run one sourcing batch: search → score → stage. Live mode walks the
 * registry gate first (fail-closed, named reason); staging mode runs the
 * fixtures and is refused when the provider is armed — fixtures never
 * outrun the truth. Search success/failure feeds the circuit; search
 * itself spends 0 credits and the ledger never claims otherwise.
 */
export async function stageSourcingBatch(input: StageInput): Promise<StageOutcome> {
  const gate = await resolveIntegrationGate("apollo");

  let people: SourcingPerson[];
  let wireTotal: number;
  let mode: "live" | "staging";
  let batchId: string;
  let gateNote: string | null = null;

  if (input.mode === "live") {
    if (!gate.ok) return { ok: false, reason: gate.reason };
    try {
      const apiKey = (process.env[gate.row.keyEnvVar ?? ""] ?? "").trim();
      const result = await apolloPeopleSearch(input.icp, { apiKey, transport: input.transport ?? fetch });
      people = result.people;
      wireTotal = result.total;
      await recordIntegrationSuccess("apollo");
    } catch (error) {
      const reason = `provider_error: ${String(error).slice(0, 300)}`;
      await recordIntegrationFailure("apollo", reason);
      return { ok: false, reason };
    }
    mode = "live";
    batchId = `live:${new Date().toISOString()}`;
  } else {
    if (gate.ok) {
      return { ok: false, reason: "staging_mode_unnecessary: apollo is armed and keyed — run a live batch; fixtures never outrun the truth" };
    }
    people = FIXTURE_PEOPLE;
    wireTotal = FIXTURE_PEOPLE.length;
    mode = "staging";
    batchId = `fixture:${Date.now().toString(36)}`;
    gateNote = gate.reason;
  }

  const staged: StageCandidateView[] = [];
  let skipped = 0;

  for (const person of people) {
    const org = person.organization;
    if (!org || (!org.primary_domain && !org.name)) {
      skipped += 1;
      continue;
    }
    const domain = org.primary_domain ?? null;
    const domainKey = domainKeyFor(org.name, domain);
    const fit = scoreSourcingFit(person, input.icp);

    const [first = "", ...rest] = person.name.trim().split(/\s+/);
    const lastName = rest.join(" ") || first;

    const prospect = await db.prospect.upsert({
      where: { source_domainKey: { source: "sourcing", domainKey } },
      create: {
        source: "sourcing",
        sourceUrl: `${mode === "staging" ? "fixture" : "apollo"}://search/${batchId}/${person.id}`,
        name: org.name ?? domainKey,
        domainKey,
        domain,
        website: org.website_url ?? null,
        vertical: org.industry ?? null,
        region: person.location,
        employeeCount: org.estimated_num_employees ?? null,
        detectedErp: hasAny((org.keywords ?? []).join(" "), input.icp.erpKeywords) ?? undefined,
        rawExcerpt: null,
        ingestion: "ingested",
        bestEmail: null,
      },
      update: {
        name: org.name ?? undefined,
        domain: domain ?? undefined,
        vertical: org.industry ?? undefined,
        region: person.location ?? undefined,
        employeeCount: org.estimated_num_employees ?? undefined,
        ingestion: "ingested",
      },
      select: { id: true, bestEmail: true },
    });

    // Contact has no unique key on (prospectId, name) — find-then-write
    // keeps re-runs of a batch idempotent instead of stacking duplicate rows.
    const existingContact = await db.contact.findFirst({
      where: { prospectId: prospect.id, firstName: first, lastName },
      select: { id: true },
    });
    const contact = existingContact
      ? await db.contact.update({
          where: { id: existingContact.id },
          data: { role: person.title ?? undefined, titleRaw: person.title ?? undefined },
          select: { id: true },
        })
      : await db.contact.create({
          data: { prospectId: prospect.id, firstName: first, lastName, role: person.title ?? "unknown", titleRaw: person.title ?? undefined },
          select: { id: true },
        });

    const existingCandidate = await db.sourcingCandidate.findUnique({
      where: { prospectId: prospect.id },
      select: { id: true, stage: true },
    });
    // A dismissed verdict is an operator act and survives re-staging; any
    // other prior state comes back to staged with the fresh batch's math.
    const keepDismissed = existingCandidate?.stage === "dismissed";
    const candidate = existingCandidate
      ? await db.sourcingCandidate.update({
          where: { id: existingCandidate.id },
          data: {
            contactId: contact.id,
            fitScore: fit.fitScore,
            fitJson: JSON.stringify(fit.factors),
            batchId,
            mode,
            ...(keepDismissed ? {} : { stage: "staged", stageReason: null }),
          },
          select: { id: true, stage: true },
        })
      : await db.sourcingCandidate.create({
          data: {
            prospectId: prospect.id,
            contactId: contact.id,
            fitScore: fit.fitScore,
            fitJson: JSON.stringify(fit.factors),
            batchId,
            mode,
            stage: "staged",
          },
          select: { id: true, stage: true },
        });

    staged.push({
      candidateId: candidate.id,
      prospectId: prospect.id,
      person: person.name,
      title: person.title,
      organization: org.name ?? domainKey,
      domain,
      fitScore: fit.fitScore,
      factors: fit.factors,
      revealEligible: fit.fitScore >= REVEAL_BAR && candidate.stage === "staged",
      stage: candidate.stage,
    });
  }

  staged.sort((a, b) => b.fitScore - a.fitScore);
  return { ok: true, mode, batchId, staged: staged.length, skipped, wireTotal, gateNote, candidates: staged };
}

/* ------------------------------------------------------------------ queue -- */

export interface QueueItem {
  candidateId: string;
  prospectId: string;
  person: string | null;
  title: string | null;
  organization: string | null;
  domain: string | null;
  location: string | null;
  fitScore: number;
  factors: SourcingFitFactor[];
  mode: string;
  batchId: string;
  stage: string;
  stageReason: string | null;
  attempts: number;
  revealEligible: boolean;
  bestEmail: string | null;
  revealedProvider: string | null;
  revealedAt: string | null;
}

export interface QueueView {
  staged: QueueItem[];
  revealed: QueueItem[];
  stats: { staged: number; revealed: number; dismissed: number; belowBar: number; eligible: number };
}

/**
 * The reveal queue — staged candidates ranked by fit, revealed kept for the
 * record, dismissed counted but not shown. belowBar = staged rows under the
 * reveal bar (visible in stats so the operator knows why the queue is thin).
 */
export async function sourcingQueue(): Promise<QueueView> {
  const rows = await db.sourcingCandidate.findMany({
    where: { stage: { in: ["staged", "revealed"] } },
    orderBy: [{ fitScore: "desc" }, { updatedAt: "desc" }],
    include: {
      prospect: { select: { id: true, name: true, domain: true, region: true, bestEmail: true } },
    },
    take: 200,
  });

  const items: QueueItem[] = rows.map((r) => {
    const prospect = r.prospect;
    return {
      candidateId: r.id,
      prospectId: r.prospectId,
      person: null, // person name resolved below in bulk
      title: null,
      organization: prospect.name,
      domain: prospect.domain,
      location: prospect.region,
      fitScore: r.fitScore,
      factors: JSON.parse(r.fitJson) as SourcingFitFactor[],
      mode: r.mode,
      batchId: r.batchId,
      stage: r.stage,
      stageReason: r.stageReason,
      attempts: r.attempts,
      revealEligible: r.stage === "staged" && r.fitScore >= REVEAL_BAR,
      bestEmail: prospect.bestEmail,
      revealedProvider: r.revealedProvider,
      revealedAt: r.revealedAt?.toISOString() ?? null,
    };
  });

  // bulk-load the person rows the candidates point at — two queries, not N
  const contactIds = rows.map((r) => r.contactId).filter((v): v is string => Boolean(v));
  const contacts = contactIds.length ? await db.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, firstName: true, lastName: true, role: true } }) : [];
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  for (let i = 0; i < items.length; i += 1) {
    const c = rows[i].contactId ? contactMap.get(rows[i].contactId as string) : null;
    if (c) {
      items[i].person = `${c.firstName} ${c.lastName}`.trim();
      items[i].title = c.role;
    }
  }

  const [dismissed, belowBar] = await Promise.all([
    db.sourcingCandidate.count({ where: { stage: "dismissed" } }),
    db.sourcingCandidate.count({ where: { stage: "staged", fitScore: { lt: REVEAL_BAR } } }),
  ]);

  return {
    staged: items.filter((i) => i.stage === "staged"),
    revealed: items.filter((i) => i.stage === "revealed"),
    stats: {
      staged: items.filter((i) => i.stage === "staged").length,
      revealed: items.filter((i) => i.stage === "revealed").length,
      dismissed,
      belowBar,
      eligible: items.filter((i) => i.stage === "staged" && i.fitScore >= REVEAL_BAR).length,
    },
  };
}

/* ----------------------------------------------------------------- reveal -- */

export interface RevealOutcome {
  ok: boolean;
  status: "resolved" | "no_match" | "refused";
  provider: string;
  reason?: string;
  email?: string | null;
  confidence?: string | null;
  creditsUsed: number;
  fitScore: number;
  candidateStage: string;
  candidateId: string;
}

/**
 * Spend money on one candidate: fit bar first, then the resolver's own
 * registry gate, adapter, and ContactResolution ledger. The candidate row
 * keeps the outcome — resolved graduates the stage; no_match and refusals
 * stay staged with the reason so the operator decides, not the machine.
 */
export async function revealSourcingCandidate(
  candidateId: string,
  opts: { actor: string; transport?: Transport },
): Promise<RevealOutcome> {
  const candidate = await db.sourcingCandidate.findUnique({
    where: { id: candidateId },
    include: { prospect: { select: { id: true, name: true, domain: true } } },
  });
  const refused = (status: "refused", reason: string, fitScore = candidate?.fitScore ?? 0): RevealOutcome => ({
    ok: false,
    status,
    provider: "none",
    reason,
    creditsUsed: 0,
    fitScore,
    candidateStage: candidate?.stage ?? "missing",
    candidateId,
  });

  if (!candidate) return refused("refused", "sourcing_candidate_missing: no candidate row carries this id");
  if (candidate.stage !== "staged") {
    return refused("refused", `sourcing_candidate_not_staged: this candidate is ${candidate.stage} — nothing to reveal`);
  }
  if (candidate.fitScore < REVEAL_BAR) {
    return refused(
      "refused",
      `sourcing_fit_below_bar: fit ${candidate.fitScore} < reveal bar ${REVEAL_BAR} — dismiss it or wait for a tighter batch; money never moves below the bar`,
    );
  }
  const contact = candidate.contactId ? await db.contact.findUnique({ where: { id: candidate.contactId } }) : null;
  const personName = contact ? `${contact.firstName} ${contact.lastName}`.trim() : null;

  const outcome = await resolveContact(
    {
      query: { name: personName, domain: candidate.prospect.domain, company: candidate.prospect.name, role: contact?.role ?? null },
      prospectId: candidate.prospectId,
      actor: opts.actor,
      transport: opts.transport,
    },
  );

  const attempts = { increment: 1 } as const;
  if (outcome.status === "resolved") {
    await db.sourcingCandidate.update({
      where: { id: candidateId },
      data: { stage: "revealed", revealedProvider: outcome.provider, revealedAt: new Date(), stageReason: null, attempts },
    });
    return { ...outcome, fitScore: candidate.fitScore, candidateStage: "revealed", candidateId };
  }
  await db.sourcingCandidate.update({
    where: { id: candidateId },
    data: { stageReason: (outcome.reason ?? outcome.status).slice(0, 500), attempts },
  });
  return { ...outcome, fitScore: candidate.fitScore, candidateStage: "staged", candidateId };
}

/* ---------------------------------------------------------------- dismiss -- */

export async function dismissSourcingCandidate(candidateId: string, reason: string, actor: string): Promise<{ ok: boolean; reason?: string }> {
  const candidate = await db.sourcingCandidate.findUnique({ where: { id: candidateId }, select: { stage: true } });
  if (!candidate) return { ok: false, reason: "sourcing_candidate_missing: no candidate row carries this id" };
  if (candidate.stage !== "staged") return { ok: false, reason: `sourcing_candidate_not_staged: this candidate is ${candidate.stage} — nothing to dismiss` };
  await db.sourcingCandidate.update({
    where: { id: candidateId },
    data: { stage: "dismissed", stageReason: `dismissed by ${actor}: ${reason.slice(0, 400)}` },
  });
  return { ok: true };
}
