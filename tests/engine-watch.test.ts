import { describe, expect, it } from "vitest";
import {
  ENGINE_STALE_FACTOR,
  ENGINE_STALE_MIN_MS,
  SLA,
  deriveEngineAlerts,
  deriveEngineView,
  stageEnteredAtMs,
  stageMoveTarget,
} from "@/lib/vertebra/watches";
import type { EngagementEventShape, EngagementShape, EnginePulseRow } from "@/lib/vertebra/command";

// --------------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------------- //

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const pulse = (over: Partial<EnginePulseRow>): EnginePulseRow => ({
  id: `pl_${Math.random().toString(36).slice(2, 8)}`,
  engineId: "turnaround-core",
  watchId: "stage_advance",
  status: "ok",
  detail: null,
  atMs: NOW - 60_000,
  expectEveryMs: 300_000,
  ...over,
});

const ev = (kind: string, detail: string, agoMs: number, actor = "engine"): EngagementEventShape => ({
  id: `ev_${Math.random().toString(36).slice(2, 8)}`,
  kind,
  detail,
  actor,
  createdAtMs: NOW - agoMs,
});

/** Events are newest-first — the route feeds the trail descending. */
const engagement = (over: Partial<EngagementShape>): EngagementShape => ({
  id: "eng_1",
  ref: "PAY-001",
  clientName: "Gulf Coast Valve",
  clientDomain: null,
  contactName: "Dana Ruiz",
  contactEmail: "dana@gulfcoastvalve.com",
  contactPhone: null,
  tier: "diagnostic_audit",
  amountUsd: 3_500,
  source: "portal_webhook",
  status: "paid",
  intakeRfqPerMonth: null,
  intakeLineItems: null,
  guaranteeCleared: null,
  confirmedLeakageUsd: null,
  verdictNote: null,
  deliverableUrl: null,
  prospectId: null,
  prospectName: null,
  documentCount: 0,
  paidAtMs: NOW - 2 * HOUR,
  deliveredAtMs: null,
  events: [],
  ...over,
});

// --------------------------------------------------------------------------- //
// The stage trail contract — "detail LEADS with `${Label} → ${to}`"
// --------------------------------------------------------------------------- //

describe("stageMoveTarget — the trail contract both writers honor", () => {
  it("parses the desk's terse move", () => {
    expect(stageMoveTarget("Paid → intake")).toBe("intake");
    expect(stageMoveTarget("Verdict → delivered")).toBe("delivered");
  });

  it("parses the engine's rich move — the story after the move never hides it", () => {
    // Verbatim detail from the live ledger (ENGINE-RT-1793316939).
    expect(
      stageMoveTarget(
        "Forensics → verdict · engine modeled LM-2025-Q4-r1 — annual $62,512 (band $53,135–$71,889) · recoverable $28,000 yr-one",
      ),
    ).toBe("verdict");
    expect(stageMoveTarget("Paid → intake · engine advance — contacts and quote volume on the ledger (40 RFQ/mo · 12 lines)")).toBe("intake");
  });

  it("non-move details parse to null — no invention", () => {
    expect(stageMoveTarget(null)).toBeNull();
    expect(stageMoveTarget("")).toBeNull();
    expect(stageMoveTarget("generated audit deliverable · 4.0 kb · seal 5c2bae973ee3ba2b")).toBeNull();
    expect(stageMoveTarget("note without a move")).toBeNull();
  });

  it("stage entry is provable for engine-moved engagements — the M2 math sees the machine's work", () => {
    const engineMoved = engagement({
      id: "em1",
      status: "verdict",
      events: [
        ev("stage_changed", "Forensics → verdict · engine modeled LM-2025-Q4-r1 — annual $62,512 (band $53,135–$71,889) · recoverable $28,000 yr-one", 90 * 60_000),
        ev("stage_changed", "Intake → forensics · engine advance — quote volume confirmed (40 RFQ/mo · 12 lines)", 3 * HOUR),
        ev("stage_changed", "Paid → intake · engine advance — contacts and quote volume on the ledger (40 RFQ/mo · 12 lines)", 4 * HOUR),
      ],
    });
    expect(stageEnteredAtMs(engineMoved, "verdict")).toBe(NOW - 90 * 60_000);
    expect(stageEnteredAtMs(engineMoved, "forensics")).toBe(NOW - 3 * HOUR);
    expect(stageEnteredAtMs(engineMoved, "intake")).toBe(NOW - 4 * HOUR);
  });
});

// --------------------------------------------------------------------------- //
// deriveEngineAlerts — silence is the loudest signal an ingress-only engine sends
// --------------------------------------------------------------------------- //

describe("deriveEngineAlerts — healthy engine", () => {
  it("a fresh ok pulse is quiet — quiet when beating", () => {
    expect(deriveEngineAlerts([pulse({})], NOW)).toHaveLength(0);
  });

  it("an engine that never declared a cadence is never called silent", () => {
    const p = pulse({ expectEveryMs: null, atMs: NOW - 26 * HOUR });
    expect(deriveEngineAlerts([p], NOW)).toHaveLength(0);
  });
});

describe("deriveEngineAlerts — spoken signals", () => {
  it("warn renders at warn severity with the pulse detail as the action", () => {
    const [a] = deriveEngineAlerts(
      [pulse({ status: "warn", detail: "1 inside deliverable warn window", watchId: "sla_guard" })],
      NOW,
    );
    expect(a?.watchId).toBe("engine_warn");
    expect(a?.severity).toBe("warn");
    expect(a?.action).toBe("1 inside deliverable warn window");
    expect(a?.subjectId).toBe("turnaround-core");
  });

  it("fail renders at crit severity", () => {
    const [a] = deriveEngineAlerts([pulse({ status: "fail", detail: "2 advance failure(s)" })], NOW);
    expect(a?.watchId).toBe("engine_fail");
    expect(a?.severity).toBe("crit");
    expect(a?.action).toBe("2 advance failure(s)");
  });
});

describe("deriveEngineAlerts — the silence watch", () => {
  it("fires crit past 3× the declared cadence", () => {
    const stale = pulse({ atMs: NOW - (ENGINE_STALE_FACTOR * 300_000 + 60_000) });
    const [a] = deriveEngineAlerts([stale], NOW);
    expect(a?.watchId).toBe("engine_silent");
    expect(a?.severity).toBe("crit");
    expect(a?.title).toContain("turnaround-core");
    expect(a?.evidence).toContain("declared cadence");
  });

  it("holds just inside the window — no alarm without its math", () => {
    const fresh = pulse({ atMs: NOW - ENGINE_STALE_FACTOR * 300_000 + 60_000 });
    expect(deriveEngineAlerts([fresh], NOW)).toHaveLength(0);
  });

  it("the 10-minute floor protects fast-cadence engines from noise", () => {
    // 1-minute cadence → 3× = 3min, but the floor is 10min: a 5-min-old beat is fine.
    const quick = pulse({ expectEveryMs: 60_000, atMs: NOW - 5 * 60_000 });
    expect(deriveEngineAlerts([quick], NOW)).toHaveLength(0);
    // …but 11 minutes of silence from the same engine rings.
    const dead = pulse({ expectEveryMs: 60_000, atMs: NOW - 11 * 60_000 });
    expect(deriveEngineAlerts([dead], NOW)[0]?.watchId).toBe("engine_silent");
    expect(ENGINE_STALE_MIN_MS).toBe(10 * 60_000);
  });

  it("silence outranks a fail on the same watch — one alarm, the truest one", () => {
    const staleFail = pulse({ status: "fail", atMs: NOW - 30 * 60_000 });
    const alerts = deriveEngineAlerts([staleFail], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.watchId).toBe("engine_silent");
  });
});

describe("deriveEngineAlerts — per-key dedup and independence", () => {
  it("newest pulse per (engine, watch) wins regardless of array order", () => {
    const oldFail = pulse({ status: "fail", atMs: NOW - 20 * 60_000, id: "pl_old" });
    const newOk = pulse({ status: "ok", atMs: NOW - 60_000, id: "pl_new" });
    expect(deriveEngineAlerts([oldFail, newOk], NOW)).toHaveLength(0);
    expect(deriveEngineAlerts([newOk, oldFail], NOW)).toHaveLength(0);
  });

  it("engines are independent — one silent engine never silences another", () => {
    const silent = pulse({ engineId: "ghost-engine", atMs: NOW - 60 * 60_000 });
    const alive = pulse({ engineId: "turnaround-core" });
    const alerts = deriveEngineAlerts([silent, alive], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subjectId).toBe("ghost-engine");
  });
});

// --------------------------------------------------------------------------- //
// deriveEngineView — the document turnaround pipeline, measured
// --------------------------------------------------------------------------- //

describe("deriveEngineView — stage stats and dwell", () => {
  it("counts per active stage and reads dwell from the ledger trail", () => {
    const verdict = engagement({
      id: "v1",
      status: "verdict",
      events: [ev("stage_changed", "Forensics → verdict · engine modeled LM-2025-Q4-r1", 2 * HOUR)],
    });
    const view = deriveEngineView([engagement({ id: "p1" }), verdict], NOW);
    const paid = view.stages.find((s) => s.stage === "paid");
    const verd = view.stages.find((s) => s.stage === "verdict");
    expect(paid?.count).toBe(1);
    expect(verd?.count).toBe(1);
    expect(verd?.medianDwellMs).toBe(2 * HOUR);
    expect(verd?.maxDwellMs).toBe(2 * HOUR);
  });

  it("flags at-risk stages against the deliverable clock — with the dollars", () => {
    const risky = engagement({ id: "r1", paidAtMs: NOW - 4.2 * 86_400_000, amountUsd: 3_500 });
    const view = deriveEngineView([risky], NOW);
    const paid = view.stages.find((s) => s.stage === "paid");
    expect(paid?.atRisk).toBe(1);
    expect(paid?.atRiskDollars).toBe(3_500);
  });

  it("an unprovable stage entry carries no invented dwell", () => {
    const ghost = engagement({ id: "g1", status: "forensics", events: [] });
    const view = deriveEngineView([ghost], NOW);
    const forensics = view.stages.find((s) => s.stage === "forensics");
    expect(forensics?.count).toBe(1);
    expect(forensics?.medianDwellMs).toBeNull();
  });
});

describe("deriveEngineView — Little's Law drain", () => {
  it("measures throughput from real stage-change trail events", () => {
    const advanced = engagement({
      id: "d1",
      status: "intake",
      events: [ev("stage_changed", "Paid → intake · engine advance — quote volume confirmed", 3 * HOUR)],
    });
    const waiting = engagement({ id: "d1b", status: "paid" }); // depth — someone stands in the stage
    const view = deriveEngineView([advanced, waiting], NOW);
    const paid = view.drain.find((d) => d.stage === "paid");
    expect(paid?.depth).toBe(1);
    expect(paid?.completions7d).toBe(1);
    expect(paid?.drainPerHour).toBeCloseTo(1 / (7 * 24), 10);
    expect(paid?.timeToDrainMs).toBe(168 * HOUR);
  });

  it("a stage with no completions on record forecasts nothing — null, not zero", () => {
    const view = deriveEngineView([engagement({ id: "q1" })], NOW);
    const paid = view.drain.find((d) => d.stage === "paid");
    expect(paid?.drainPerHour).toBeNull();
    expect(paid?.timeToDrainMs).toBeNull();
  });

  it("completions outside the 7-day window do not price the drain", () => {
    const e = engagement({
      id: "d2",
      events: [ev("stage_changed", "Paid → intake · engine advance", 8 * 86_400_000)],
    });
    const view = deriveEngineView([e], NOW);
    expect(view.drain.find((d) => d.stage === "paid")?.completions7d).toBe(0);
  });
});

describe("deriveEngineView — the money and the contract", () => {
  it("delivered 24h and document throughput are counted, not remembered", () => {
    const shipped = engagement({
      id: "s1",
      status: "delivered",
      deliveredAtMs: NOW - 5 * HOUR,
      documents: [
        { id: "doc1", fileName: "lines.pdf", sizeBytes: 1024, sha256: "a", pages: 2, lineItems: 12, extraction: "full_text", createdAtMs: NOW - 4 * HOUR },
        { id: "doc2", fileName: "scan.pdf", sizeBytes: 2048, sha256: "b", pages: null, lineItems: null, extraction: "partial", createdAtMs: NOW - 30 * HOUR },
      ],
    });
    const view = deriveEngineView([shipped], NOW);
    expect(view.delivered24h).toBe(1);
    expect(view.docs24h).toBe(1); // only the doc inside 24h
    expect(view.parseFull).toBe(1);
    expect(view.parsePartial).toBe(1);
  });

  it("active dollars exclude sow and closed books", () => {
    const view = deriveEngineView([
      engagement({ id: "a1", amountUsd: 3_500 }),
      engagement({ id: "a2", status: "sow", amountUsd: 20_000 }),
      engagement({ id: "a3", status: "closed", amountUsd: 5_000 }),
    ], NOW);
    expect(view.activeDollars).toBe(3_500);
  });

  it("guarantee exposure exists while a verdict is undecided — and only then", () => {
    const undecided = deriveEngineView(
      [engagement({ id: "u1", status: "verdict", guaranteeCleared: null })],
      NOW,
    );
    expect(undecided.guaranteeExposureDollars).toBe(10_000);

    const decided = deriveEngineView(
      [engagement({ id: "u2", status: "verdict", guaranteeCleared: true, confirmedLeakageUsd: 34_000 })],
      NOW,
    );
    expect(decided.guaranteeExposureDollars).toBe(0);
  });

  it("keeps the deliverable promise constants honest — the contract in numbers", () => {
    expect(SLA.deliverableMs).toBe(5 * 86_400_000);
    expect(SLA.verdictMs).toBe(3 * 86_400_000);
  });
});
