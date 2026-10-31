import { describe, expect, it } from "vitest";
import {
  effectivePriority,
  heatLevel,
  isHighIntentNow,
  isHighSignal,
  intentWeight,
  money,
  recencyFactor,
  relTime,
  verticalLabel,
  AUTO_SEND_INTENTS,
  HUMAN_GATE_INTENTS,
} from "@/lib/vertebra/command";

const MIN = 60_000;

describe("recencyFactor — decay ladder", () => {
  const now = Date.now();
  it("boosts fresh high-signal events and decays stale ones", () => {
    expect(recencyFactor(now - 5 * MIN, now)).toBe(1.35);
    expect(recencyFactor(now - 30 * MIN, now)).toBe(1.2);
    expect(recencyFactor(now - 3 * 60 * MIN, now)).toBe(1.0);
    expect(recencyFactor(now - 20 * 60 * MIN, now)).toBe(0.85);
    expect(recencyFactor(now - 3 * 1440 * MIN, now)).toBe(0.7);
    expect(recencyFactor(now - 10 * 1440 * MIN, now)).toBe(0.6);
  });
  it("never had a signal → 0.6 floor", () => {
    expect(recencyFactor(null, now)).toBe(0.6);
  });
});

describe("intentWeight", () => {
  it("ranks document_download highest", () => {
    expect(intentWeight("document_download")).toBe(1.3);
    expect(intentWeight("audit_view")).toBe(1.25);
    expect(intentWeight("portal_visit")).toBe(1.2);
    expect(intentWeight("pricing_view")).toBe(1.1);
    expect(intentWeight("session_end")).toBe(0.9);
  });
  it("defaults low for unknown types", () => {
    expect(intentWeight("mystery_event")).toBe(0.75);
    expect(intentWeight(null)).toBe(0.75);
  });
});

describe("effectivePriority", () => {
  const now = Date.now();
  it("is QLV × recency × intent", () => {
    const p = effectivePriority({ qlvScore: 90, lastHighSignalAtMs: now - 5 * MIN, lastEventType: "document_download" }, now);
    expect(p).toBeCloseTo(90 * 1.35 * 1.3, 6);
  });
  it("returns 0 for unscored leads", () => {
    expect(effectivePriority({ qlvScore: null, lastHighSignalAtMs: now, lastEventType: "audit_view" }, now)).toBe(0);
  });
  it("fresh document download outranks stale portal visit at equal QLV", () => {
    const fresh = effectivePriority({ qlvScore: 80, lastHighSignalAtMs: now - 5 * MIN, lastEventType: "document_download" }, now);
    const stale = effectivePriority({ qlvScore: 80, lastHighSignalAtMs: now - 6 * 1440 * MIN, lastEventType: "portal_visit" }, now);
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe("high-intent gate", () => {
  const now = Date.now();
  it("requires QLV ≥ 85 AND a signal ≤ 15 minutes old", () => {
    expect(isHighIntentNow(now - 10 * MIN, now, 90)).toBe(true);
    expect(isHighIntentNow(now - 16 * MIN, now, 90)).toBe(false);
    expect(isHighIntentNow(now - 10 * MIN, now, 84)).toBe(false);
    expect(isHighIntentNow(null, now, 90)).toBe(false);
  });
});

describe("signal + presentation helpers", () => {
  it("classifies high-signal telemetry types", () => {
    expect(isHighSignal("portal_visit")).toBe(true);
    expect(isHighSignal("audit_view")).toBe(true);
    expect(isHighSignal("document_download")).toBe(true);
    expect(isHighSignal("pricing_view")).toBe(false);
    expect(isHighSignal("session_end")).toBe(false);
  });

  it("heat ladder thresholds: 85/72/50", () => {
    expect(heatLevel(95)).toBe("critical");
    expect(heatLevel(85)).toBe("critical");
    expect(heatLevel(84)).toBe("hot");
    expect(heatLevel(72)).toBe("hot");
    expect(heatLevel(50)).toBe("warm");
    expect(heatLevel(49)).toBe("cool");
    expect(heatLevel(null)).toBe("cool");
  });

  it("money formatting", () => {
    expect(money(null)).toBe("—");
    expect(money(10_600_000)).toBe("$10.6M");
    expect(money(10_000_000)).toBe("$10M");
    expect(money(840_000)).toBe("$840K");
    expect(money(900)).toBe("$900");
  });

  it("relative time", () => {
    const now = Date.now();
    expect(relTime(now - 30_000, now)).toBe("30s ago");
    expect(relTime(now - 5 * MIN, now)).toBe("5m ago");
    expect(relTime(now - 3 * 60 * MIN, now)).toBe("3h ago");
    expect(relTime(now - 4 * 1440 * MIN, now)).toBe("4d ago");
  });

  it("vertical labels", () => {
    expect(verticalLabel("pvf")).toBe("PVF");
    expect(verticalLabel("fluid_power")).toBe("Fluid Power");
    expect(verticalLabel(null)).toBe("—");
  });
});

describe("tiered autonomy policy", () => {
  it("tier split is disjoint and complete", () => {
    const auto = new Set(AUTO_SEND_INTENTS);
    const gate = new Set(HUMAN_GATE_INTENTS);
    for (const i of auto) expect(gate.has(i as never)).toBe(false);
    expect(auto).toEqual(new Set(["send_information", "out_of_office", "not_interested"]));
    expect(gate).toEqual(new Set(["interested", "objection_price", "objection_erp"]));
  });
});

describe("score JSON columns — the validated readers", () => {
  // the v1 dummy seed stored an object in factorsJson and crashed RadarView
  // (`factors.find is not a function`); the readers exist so the ledger can
  // hold anything a script ever wrote without taking a component down.
  it("parseFactorsJson — canonical array passes through, everything else reads as empty", async () => {
    const { parseFactorsJson } = await import("@/lib/vertebra/scoring");
    const good = [{ key: "rfq_latency", weight: 0.28, points: 82, evidence: "portal=manual_mailto" }];
    expect(parseFactorsJson(JSON.stringify(good))).toEqual(good);
    expect(parseFactorsJson(JSON.stringify({ portal_drift: 0.3, rfq_latency: 0.5 }))).toEqual([]); // the poison shape
    expect(parseFactorsJson(JSON.stringify("an array, double-encoded"))).toEqual([]);
    expect(parseFactorsJson("not json at all")).toEqual([]);
    expect(parseFactorsJson(JSON.stringify([null, 42, { key: "size_fit", weight: "oops", points: 1, evidence: "x" }]))).toEqual([]);
    expect(parseFactorsJson(null)).toEqual([]);
    expect(parseFactorsJson(undefined)).toEqual([]);
  });

  it("parseHooksJson — same contract for the hooks column", async () => {
    const { parseHooksJson } = await import("@/lib/vertebra/scoring");
    const good = [{ flavor: "rfq_latency", body: "quotes in 26 hours" }];
    expect(parseHooksJson(JSON.stringify(good))).toEqual(good);
    expect(parseHooksJson(JSON.stringify({ flavor: "rfq_latency" }))).toEqual([]);
    expect(parseHooksJson("garbage")).toEqual([]);
    expect(parseHooksJson(null)).toEqual([]);
  });

  it("persona KPI math survives a malformed snapshot — no throw, empty factor pools", async () => {
    const { deriveKpiInputs } = await import("@/lib/vertebra/persona");
    const snap = {
      leads: [
        { name: "Poisoned Factor", leakageUsd: 120_000, highIntentNow: false, score: { qlvScore: 88, factors: { portal_drift: 0.3 } } },
        { name: "Clean Lead", leakageUsd: 80_000, highIntentNow: true, score: { qlvScore: 71, factors: [{ key: "rfq_latency", points: 90 }, { key: "unapplied_spa", points: 61 }] } },
      ],
      triage: { pending: [] },
      ops: { telemetryEvents24h: 3, dispatchesSent24h: 1, alerts24h: 0, outboxPending: 0, outboxPublished: 0 },
    } as never;
    const k = deriveKpiInputs(snap);
    expect(k.leakageTotalUsd).toBe(200_000);
    expect(k.latencyCrew).toBe(1); // only the clean lead's rfq_latency lands
    expect(k.spaLaggards).toBe(1);
    expect(k.manualAvg).toBe(0); // no manual_quoting_share anywhere
  });
});
