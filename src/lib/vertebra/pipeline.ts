/**
 * Pipeline pure logic — the operator's home deck runs on this.
 *
 * No DB, no React: filters, sorts, bulk-partition math, keyboard cursor
 * arithmetic and countdown formatting live here so vitest can hammer them
 * and the console re-ranks live without touching SQL. Mirror of the
 * command.ts doctrine — the read model ships data, the client decides.
 */

import type { ReplyIntent, TriageItem } from "./command";

// --------------------------------------------------------------------------- //
// Intent grouping — the tier-2 gate only ever holds three families
// --------------------------------------------------------------------------- //

export type IntentFamily = "interested" | "objection" | "other";

/** Collapse the seven intents into the three families the gate actually triages. */
export function intentFamily(intent: ReplyIntent | string): IntentFamily {
  if (intent === "interested") return "interested";
  if (intent === "objection_price" || intent === "objection_erp") return "objection";
  return "other";
}

// --------------------------------------------------------------------------- //
// Filters + sorts
// --------------------------------------------------------------------------- //

export type PipelineFilter = "all" | "interested" | "objection";
export type TriageSort = "newest" | "confidence" | "qlv";

/** [key, label] pairs for the filter pill row — label renders in mono caps. */
export const PIPELINE_FILTERS: Array<[PipelineFilter, string]> = [
  ["all", "All"],
  ["interested", "Interested"],
  ["objection", "Objections"],
];

export const TRIAGE_SORTS: Array<[TriageSort, string]> = [
  ["newest", "Newest"],
  ["confidence", "Confidence"],
  ["qlv", "QLV"],
];

export function matchPipelineFilter(item: TriageItem, filter: PipelineFilter): boolean {
  if (filter === "all") return true;
  return intentFamily(item.intent) === filter;
}

/**
 * Sort the pending queue. Confidence and QLV sort descending with nulls
 * demoted to the tail (unknown never outranks known); newest is descending
 * recency. Ties fall back to newest so the order is stable across repaints.
 */
export function sortTriage(items: TriageItem[], sort: TriageSort): TriageItem[] {
  const rows = [...items];
  const recency = (a: TriageItem, b: TriageItem) => b.receivedAtMs - a.receivedAtMs;
  if (sort === "newest") {
    rows.sort(recency);
  } else if (sort === "confidence") {
    rows.sort((a, b) => {
      const av = a.confidence ?? -1;
      const bv = b.confidence ?? -1;
      return bv - av || recency(a, b);
    });
  } else {
    rows.sort((a, b) => {
      const av = a.qlvScore ?? -1;
      const bv = b.qlvScore ?? -1;
      return bv - av || recency(a, b);
    });
  }
  return rows;
}

// --------------------------------------------------------------------------- //
// Bulk triage math
// --------------------------------------------------------------------------- //

/** Confidence at or above which "approve high-confidence" will sweep a draft. */
export const BULK_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Partition the pending queue for the bulk bar: drafts the agent is confident
 * about (interested/objection family, conf ≥ threshold) vs everything the
 * operator should eyeball. Null-confidence drafts never auto-approve.
 */
export function bulkPartition(
  items: TriageItem[],
  threshold: number = BULK_CONFIDENCE_THRESHOLD,
): { confident: TriageItem[]; rest: TriageItem[] } {
  const confident: TriageItem[] = [];
  const rest: TriageItem[] = [];
  for (const item of items) {
    if (item.draftId != null && item.confidence != null && item.confidence >= threshold && intentFamily(item.intent) !== "other") {
      confident.push(item);
    } else {
      rest.push(item);
    }
  }
  return { confident, rest };
}

// --------------------------------------------------------------------------- //
// Keyboard cursor arithmetic
// --------------------------------------------------------------------------- //

/**
 * Next cursor index for j/k navigation over `len` rows. Unknown/empty cursor
 * starts at the top; j clamps at the last row, k at the first. Returns -1 for
 * an empty list so callers can no-op.
 */
export function nextCursorIdx(current: number, len: number, key: "j" | "k"): number {
  if (len <= 0) return -1;
  if (current < 0) return 0;
  return key === "j" ? Math.min(len - 1, current + 1) : Math.max(0, current - 1);
}

// --------------------------------------------------------------------------- //
// Honest delivery surface
// ---------------------------------------------------------------------------

export type DeliveryTone = "sent" | "staged" | "none";

/**
 * The honest send state for an approved draft: the mailer stages when no
 * provider is configured, and the reviewer note is the ledger. "staged"
 * wins over "sent" — the console never claims delivery it can't prove.
 */
export function deliveryOf(status: string | null, reviewerNote: string | null): DeliveryTone {
  if (status !== "approved" && status !== "sent") return "none";
  if (reviewerNote && /staged/i.test(reviewerNote)) return "staged";
  return "sent";
}

// --------------------------------------------------------------------------- //
// Sequence countdown
// --------------------------------------------------------------------------- //

/**
 * Countdown label for the next due Channel A dispatch: "2m", "1h 04m", "3d",
 * or "due now" for anything at/behind the clock. Negative-free by contract.
 */
export function countdownUntil(atMs: number | null, nowMs: number): string | null {
  if (atMs == null) return null;
  const delta = atMs - nowMs;
  if (delta <= 0) return "due now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d`;
}
