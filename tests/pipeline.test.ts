/**
 * Pipeline pure-logic suite — the gate's brain, hammered without a DB.
 * Covers intent families, filters, sorts, bulk partition, cursor math,
 * honest delivery surface and sequence countdowns.
 */
import { describe, expect, it } from "vitest";
import type { TriageItem } from "@/lib/vertebra/command";
import {
  BULK_CONFIDENCE_THRESHOLD,
  PIPELINE_FILTERS,
  TRIAGE_SORTS,
  bulkPartition,
  countdownUntil,
  deliveryOf,
  intentFamily,
  matchPipelineFilter,
  nextCursorIdx,
  sortTriage,
} from "@/lib/vertebra/pipeline";

const MIN = 60_000;

let seq = 0;
function item(over: Partial<TriageItem> = {}): TriageItem {
  seq += 1;
  return {
    draftId: `draft-${seq}`,
    replyId: `reply-${seq}`,
    prospectId: `prospect-${seq}`,
    prospectName: `Distributor ${seq}`,
    qlvScore: 80,
    intent: "interested",
    confidence: 0.9,
    fromEmail: "buyer@distributor.example",
    subject: "Re: quote desk",
    body: "Send me a time.",
    draftSubject: "Locked — bringing numbers",
    draftBody: "20 minutes, your ops team welcome.",
    draftStatus: "pending_human_review",
    receivedAtMs: Date.now() - seq * 10 * MIN,
    rationale: "asks to proceed",
    rescheduledToMs: null,
    erpName: "Epicor",
    city: "Houston",
    region: "TX",
    country: "US",
    leakageUsd: 240_000,
    draftCount: 1,
    sentAtMs: null,
    reviewerNote: null,
    ...over,
  };
}

describe("intentFamily — the three triage families", () => {
  it("maps the seven intents correctly", () => {
    expect(intentFamily("interested")).toBe("interested");
    expect(intentFamily("objection_price")).toBe("objection");
    expect(intentFamily("objection_erp")).toBe("objection");
    expect(intentFamily("out_of_office")).toBe("other");
    expect(intentFamily("send_information")).toBe("other");
    expect(intentFamily("not_interested")).toBe("other");
    expect(intentFamily("unknown")).toBe("other");
  });
});

describe("matchPipelineFilter", () => {
  const interested = item({ intent: "interested" });
  const objection = item({ intent: "objection_price" });
  const other = item({ intent: "unknown" });
  it("all passes everything", () => {
    expect(matchPipelineFilter(interested, "all")).toBe(true);
    expect(matchPipelineFilter(objection, "all")).toBe(true);
    expect(matchPipelineFilter(other, "all")).toBe(true);
  });
  it("interested keeps only interested", () => {
    expect(matchPipelineFilter(interested, "interested")).toBe(true);
    expect(matchPipelineFilter(objection, "interested")).toBe(false);
  });
  it("objection keeps both objection flavors", () => {
    expect(matchPipelineFilter(item({ intent: "objection_erp" }), "objection")).toBe(true);
    expect(matchPipelineFilter(item({ intent: "objection_price" }), "objection")).toBe(true);
    expect(matchPipelineFilter(interested, "objection")).toBe(false);
  });
});

describe("sortTriage", () => {
  const a = item({ confidence: 0.7, qlvScore: 60, receivedAtMs: Date.now() - 100 * MIN });
  const b = item({ confidence: 0.95, qlvScore: 90, receivedAtMs: Date.now() - 60 * MIN });
  const c = item({ confidence: null, qlvScore: null, receivedAtMs: Date.now() - 10 * MIN });
  it("newest first", () => {
    expect(sortTriage([a, b, c], "newest").map((i) => i.replyId)).toEqual([c.replyId, b.replyId, a.replyId]);
  });
  it("confidence desc, nulls demoted to the tail", () => {
    expect(sortTriage([a, b, c], "confidence").map((i) => i.replyId)).toEqual([b.replyId, a.replyId, c.replyId]);
  });
  it("qlv desc, nulls demoted", () => {
    expect(sortTriage([a, b, c], "qlv").map((i) => i.replyId)).toEqual([b.replyId, a.replyId, c.replyId]);
  });
  it("does not mutate the input array", () => {
    const input = [a, b];
    sortTriage(input, "confidence");
    expect(input[0].replyId).toBe(a.replyId);
  });
  it("ties fall back to recency", () => {
    const x = item({ confidence: 0.8, receivedAtMs: Date.now() - 5 * MIN });
    const y = item({ confidence: 0.8, receivedAtMs: Date.now() - 50 * MIN });
    expect(sortTriage([y, x], "confidence").map((i) => i.replyId)).toEqual([x.replyId, y.replyId]);
  });
});

describe("bulkPartition — the high-confidence sweep", () => {
  it("sweeps only known-family drafts at or above threshold", () => {
    const strong = item({ confidence: 0.9, intent: "interested" });
    const edge = item({ confidence: BULK_CONFIDENCE_THRESHOLD, intent: "objection_price" });
    const weak = item({ confidence: 0.6, intent: "interested" });
    const unknown = item({ confidence: 0.99, intent: "unknown" });
    const nullConf = item({ confidence: null, intent: "interested" });
    const noDraft = item({ confidence: 0.99, intent: "interested", draftId: null });
    const { confident, rest } = bulkPartition([strong, edge, weak, unknown, nullConf, noDraft]);
    expect(confident.map((i) => i.replyId)).toEqual([strong.replyId, edge.replyId]);
    expect(rest.map((i) => i.replyId)).toEqual([weak.replyId, unknown.replyId, nullConf.replyId, noDraft.replyId]);
  });
  it("never auto-approves unknown intents regardless of confidence", () => {
    const { confident } = bulkPartition([item({ intent: "unknown", confidence: 1 })]);
    expect(confident).toHaveLength(0);
  });
});

describe("nextCursorIdx — j/k clamp math", () => {
  it("empty list is -1", () => {
    expect(nextCursorIdx(0, 0, "j")).toBe(-1);
  });
  it("unknown cursor starts at the top", () => {
    expect(nextCursorIdx(-1, 5, "j")).toBe(0);
    expect(nextCursorIdx(-1, 5, "k")).toBe(0);
  });
  it("j clamps at the last row, k at the first", () => {
    expect(nextCursorIdx(3, 5, "j")).toBe(4);
    expect(nextCursorIdx(4, 5, "j")).toBe(4);
    expect(nextCursorIdx(2, 5, "k")).toBe(1);
    expect(nextCursorIdx(0, 5, "k")).toBe(0);
  });
});

describe("deliveryOf — honest send surface", () => {
  it("approved without a staged note = sent", () => {
    expect(deliveryOf("approved", "approved in command centre")).toBe("sent");
  });
  it("staged wins — never claim delivery that is only queued", () => {
    expect(deliveryOf("approved", "approved in command centre · staged (console)")).toBe("staged");
    expect(deliveryOf("sent", "STAGED")).toBe("staged");
  });
  it("pending/discarded/no status = none", () => {
    expect(deliveryOf("pending_human_review", null)).toBe("none");
    expect(deliveryOf("discarded", "discarded in command centre")).toBe("none");
    expect(deliveryOf(null, null)).toBe("none");
  });
});

describe("countdownUntil — next-due labels", () => {
  const now = Date.now();
  it("null schedule → null", () => {
    expect(countdownUntil(null, now)).toBeNull();
  });
  it("at or behind the clock is due now", () => {
    expect(countdownUntil(now - 5 * MIN, now)).toBe("due now");
    expect(countdownUntil(now, now)).toBe("due now");
  });
  it("minutes, hours+minutes, days", () => {
    expect(countdownUntil(now + 2 * MIN, now)).toBe("2m");
    expect(countdownUntil(now + 90 * MIN, now)).toBe("1h 30m");
    expect(countdownUntil(now + 72 * 60 * MIN, now)).toBe("3d");
  });
  it("sub-minute rounds up to 1m, never 0m or negative", () => {
    expect(countdownUntil(now + 5_000, now)).toBe("1m");
  });
});

describe("registry shapes", () => {
  it("filter + sort pills stay ordered for the keyboard f-cycle", () => {
    expect(PIPELINE_FILTERS.map(([k]) => k)).toEqual(["all", "interested", "objection"]);
    expect(TRIAGE_SORTS.map(([k]) => k)).toEqual(["newest", "confidence", "qlv"]);
  });
});
