import { describe, expect, it } from "vitest";
import {
  TURNAROUND_CADENCE_MS,
  TURNAROUND_ENGINE_ID,
  TURNAROUND_WATCHES,
  planTurnaround,
  pulseRef,
  slaGuard,
  type TurnaroundRow,
} from "@/lib/vertebra/turnaround";

// --------------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------------- //

const NOW = 1_800_000_000_000;

/** A full webhook-carried intake: contacts + volume all present. */
const base: TurnaroundRow = {
  id: "eng_1",
  ref: "PAY-001",
  status: "paid",
  contactName: "Dana Ruiz",
  contactEmail: "dana@gulfcoastvalve.com",
  intakeRfqPerMonth: 40,
  intakeLineItems: 12,
  guaranteeCleared: null,
  confirmedLeakageUsd: null,
  deliverableUrl: null,
  paidAtMs: NOW - 2 * 3_600_000,
  docCount: 0,
  verdictEnteredAtMs: null,
};

const row = (over: Partial<TurnaroundRow>): TurnaroundRow => ({ ...base, ...over });

// --------------------------------------------------------------------------- //
// planTurnaround — the gate ladder
// --------------------------------------------------------------------------- //

describe("planTurnaround — paid stage", () => {
  it("advances to intake when contacts and volume are on the ledger", () => {
    const [a] = planTurnaround([row({})], NOW);
    expect(a?.kind).toBe("advance_stage");
    expect(a?.to).toBe("intake");
    expect(a?.gate).toContain("contacts");
  });

  it("waits when quote volume is missing — the desk confirms, the engine proves", () => {
    const actions = planTurnaround([row({ intakeRfqPerMonth: null, intakeLineItems: null })], NOW);
    expect(actions).toHaveLength(0);
  });

  it("waits when contacts are missing", () => {
    expect(planTurnaround([row({ contactEmail: null })], NOW)).toHaveLength(0);
    expect(planTurnaround([row({ contactName: null })], NOW)).toHaveLength(0);
  });

  it("writes the drain-reader detail format — `${Label} → ${to}` leads", () => {
    const [a] = planTurnaround([row({})], NOW);
    expect(a?.detail.startsWith("Paid → intake")).toBe(true);
  });
});

describe("planTurnaround — intake stage", () => {
  it("advances to forensics once quote volume is confirmed", () => {
    const [a] = planTurnaround([row({ status: "intake" })], NOW);
    expect(a?.to).toBe("forensics");
    expect(a?.detail.startsWith("Intake → forensics")).toBe(true);
  });

  it("waits in intake while volume is unrecorded", () => {
    expect(planTurnaround([row({ status: "intake", intakeRfqPerMonth: null })], NOW)).toHaveLength(0);
    expect(planTurnaround([row({ status: "intake", intakeLineItems: null })], NOW)).toHaveLength(0);
  });
});

describe("planTurnaround — forensics stage", () => {
  it("models leakage and advances to verdict with the model stamped on the detail", () => {
    const [a] = planTurnaround([row({ status: "forensics", docCount: 3 })], NOW);
    expect(a?.to).toBe("verdict");
    expect(a?.detail.startsWith("Forensics → verdict")).toBe(true);
    expect(a?.detail).toContain("LM-2025-Q4-r1");
    expect(a?.detail).toContain("recoverable");
    expect(a?.detail).toMatch(/\$\d[\d,]*·|· recoverable \$[\d,]+/); // real numbers, not placeholders
  });

  it("waits while zero documents are sealed — dropping them is the operator's work", () => {
    expect(planTurnaround([row({ status: "forensics", docCount: 0 })], NOW)).toHaveLength(0);
  });

  it("waits without volume — the model refuses to invent its input", () => {
    expect(planTurnaround([row({ status: "forensics", docCount: 2, intakeRfqPerMonth: null })], NOW)).toHaveLength(0);
  });
});

describe("planTurnaround — verdict stage (the human boundary)", () => {
  it("renders the deliverable once the guarantee decision is on the ledger", () => {
    const [a] = planTurnaround(
      [row({ status: "verdict", guaranteeCleared: true, confirmedLeakageUsd: 34_000 })],
      NOW,
    );
    expect(a?.kind).toBe("render_deliverable");
    expect(a?.to).toBeUndefined();
    expect(a?.gate).toContain("release stays human");
  });

  it("never renders an undecided guarantee — the $10k call is human, always", () => {
    expect(planTurnaround([row({ status: "verdict" })], NOW)).toHaveLength(0);
    expect(planTurnaround([row({ status: "verdict", guaranteeCleared: true })], NOW)).toHaveLength(0);
    expect(planTurnaround([row({ status: "verdict", confirmedLeakageUsd: 34_000 })], NOW)).toHaveLength(0);
  });

  it("does not re-render a delivered artifact — rendered work awaits release, quietly", () => {
    const actions = planTurnaround(
      [row({ status: "verdict", guaranteeCleared: false, confirmedLeakageUsd: 4_000, deliverableUrl: "/x" })],
      NOW,
    );
    expect(actions).toHaveLength(0);
  });
});

describe("planTurnaround — terminal stages and ordering", () => {
  it("never touches delivered, sow or closed rows", () => {
    expect(planTurnaround([row({ status: "delivered" }), row({ status: "sow" }), row({ status: "closed" })], NOW)).toHaveLength(0);
  });

  it("drains FIFO — oldest money first", () => {
    const old = row({ id: "old", ref: "OLD", paidAtMs: NOW - 10 * 86_400_000 });
    const fresh = row({ id: "fresh", ref: "NEW", paidAtMs: NOW - 60_000 });
    const plan = planTurnaround([fresh, old], NOW);
    expect(plan[0]?.engagementId).toBe("old");
    expect(plan[1]?.engagementId).toBe("fresh");
  });

  it("plans independent actions for a mixed queue in one pass", () => {
    const plan = planTurnaround(
      [
        row({ id: "a", status: "intake" }),
        row({ id: "b", status: "verdict", guaranteeCleared: true, confirmedLeakageUsd: 12_000 }),
        row({ id: "c", status: "paid", contactEmail: null }),
      ],
      NOW,
    );
    expect(plan.map((p) => p.engagementId)).toEqual(["a", "b"]);
  });
});

// --------------------------------------------------------------------------- //
// slaGuard — the engine reads the same clocks the watchtower rings
// --------------------------------------------------------------------------- //

describe("slaGuard", () => {
  it("reads comfortable on a fresh book", () => {
    const g = slaGuard([row({}), row({ status: "forensics", docCount: 2 })], NOW);
    expect(g.status).toBe("ok");
    expect(g.detail).toContain("clocks comfortable");
  });

  it("warns inside the deliverable warn window (2d before the 5d promise)", () => {
    const paid4dAgo = row({ paidAtMs: NOW - 4 * 86_400_000 });
    const g = slaGuard([paid4dAgo], NOW);
    expect(g.status).toBe("warn");
    expect(g.detail).toContain("1 inside deliverable warn window");
  });

  it("warns an undecided verdict inside the 24h verdict warn window", () => {
    const entered2dAgo = row({
      status: "verdict",
      // 3d promise − 2.1d elapsed ≈ 21.6h remaining — inside the 24h window
      verdictEnteredAtMs: NOW - 2.1 * 86_400_000,
    });
    const g = slaGuard([entered2dAgo], NOW);
    expect(g.status).toBe("warn");
    expect(g.detail).toContain("1 inside verdict warn window");
  });

  it("degrades honestly when verdict entry is unprovable — no invented clock", () => {
    const g = slaGuard([row({ status: "verdict", verdictEnteredAtMs: null })], NOW);
    expect(g.status).toBe("ok");
    expect(g.detail).not.toContain("verdict warn");
  });

  it("counts rendered-but-unreleased work", () => {
    const g = slaGuard(
      [row({ status: "verdict", guaranteeCleared: true, confirmedLeakageUsd: 12_000, deliverableUrl: "/x" })],
      NOW,
    );
    expect(g.detail).toContain("1 awaiting release");
  });

  it("keeps pulse details inside the 400-char EnginePulse contract", () => {
    const crowd = Array.from({ length: 40 }, (_, i) =>
      row({ id: `e${i}`, ref: `R${i}`, paidAtMs: NOW - 4.8 * 86_400_000, verdictEnteredAtMs: NOW - 2.9 * 86_400_000 }),
    );
    const g = slaGuard(crowd, NOW);
    expect(g.detail.length).toBeLessThanOrEqual(400);
  });
});

// --------------------------------------------------------------------------- //
// Engine identity — the heartbeat contract's surface
// --------------------------------------------------------------------------- //

describe("engine identity", () => {
  it("is turnaround-core on a 5-minute cadence with three watches", () => {
    expect(TURNAROUND_ENGINE_ID).toBe("turnaround-core");
    expect(TURNAROUND_CADENCE_MS).toBe(300_000);
    expect(TURNAROUND_WATCHES).toEqual(["stage_advance", "deliverable_render", "sla_guard"]);
  });

  it("issues a unique ref per beat — distinct ticks never silence each other", () => {
    // Two ticks in the same minute are two beats: the scheduler's "nothing
    // due" and the operator's "1 advanced" both reach the deck.
    expect(pulseRef("sla_guard", NOW)).not.toBe(pulseRef("sla_guard", NOW));
    expect(pulseRef("sla_guard", NOW)).not.toBe(pulseRef("sla_guard", NOW + 20_000));
    expect(pulseRef("sla_guard", NOW)).not.toBe(pulseRef("sla_guard", NOW + 61_000));
    expect(pulseRef("stage_advance", NOW)).not.toBe(pulseRef("sla_guard", NOW));
    expect(pulseRef("sla_guard", NOW)).toMatch(/^sla_guard:[a-z0-9]+-[a-z0-9]+$/);
  });
});
