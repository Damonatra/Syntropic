/**
 * Persona engine — tailors the Enclave header and the RADAR KPI strip to the
 * three buying roles in the Syntropic ICP: COO, VP of Sales, Director of
 * Inside Sales at US/Canada industrial distributors ($10M–$150M).
 *
 * Every metric is derived from the live command snapshot — no decorative numbers.
 */
import type { CommandSnapshot, KpiInputs } from "./command";

export type PersonaId = "coo" | "vp_sales" | "dir_inside";

export interface PersonaDef {
  id: PersonaId;
  code: string;
  title: string;
  mandate: string;
}

export const PERSONAS: PersonaDef[] = [
  {
    id: "coo",
    code: "COO",
    title: "Chief Operating Officer",
    mandate: "Net margin leakage recovery · quote-to-cash latency · SPA compliance across the branch network",
  },
  {
    id: "vp_sales",
    code: "VP SALES",
    title: "VP of Sales",
    mandate: "Quote turnaround competitiveness · recovery targets on the board · rep-level signal coverage",
  },
  {
    id: "dir_inside",
    code: "DIR. INSIDE SALES",
    title: "Director of Inside Sales",
    mandate: "Recovery queue throughput · SPA laggard burn-down · agent drafting load per rep",
  },
];

export function personaDef(id: PersonaId): PersonaDef {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];
}

export interface PersonaMetric {
  label: string;
  value: string;
  sub: string;
  hot?: boolean;
}

const factorPoints = (snap: CommandSnapshot, key: string): number[] =>
  snap.leads
    .map((l) => (Array.isArray(l.score?.factors) ? l.score?.factors.find((f) => f.key === key)?.points ?? null : null))
    .filter((p): p is number => p != null);

/**
 * The compact input set every persona KPI derives from — one math source for
 * the live strip (personaMetrics) and the hourly baseline ledger (aggregator).
 */
export function deriveKpiInputs(snap: CommandSnapshot): KpiInputs {
  const leakageTotal = snap.leads.reduce((s, l) => s + (l.leakageUsd ?? 0), 0);
  const highIntent = snap.leads.filter((l) => l.highIntentNow);
  const critical = snap.leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85);
  const rfqLatency = factorPoints(snap, "rfq_latency");
  const manualPts = factorPoints(snap, "manual_quoting_share");
  return {
    leakageTotalUsd: leakageTotal,
    criticalCount: critical.length,
    draftsPending: snap.triage.pending.length,
    scoredCount: snap.leads.filter((l) => l.score != null).length,
    latencyCrew: rfqLatency.filter((p) => p >= 55).length,
    spaLaggards: factorPoints(snap, "unapplied_spa").filter((p) => p >= 50).length,
    manualAvg: manualPts.length > 0 ? Math.round(manualPts.reduce((a, b) => a + b, 0) / manualPts.length) : 0,
    highIntentCount: highIntent.length,
    telemetryEvents24h: snap.ops.telemetryEvents24h,
    dispatchesSent24h: snap.ops.dispatchesSent24h,
  };
}

/** The four defended metrics per persona, computed from live telemetry. */
export function personaMetrics(id: PersonaId, snap: CommandSnapshot): PersonaMetric[] {
  const k = deriveKpiInputs(snap);
  const highIntentNames = snap.leads.filter((l) => l.highIntentNow).map((l) => l.name);
  const criticalPool = snap.leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85).reduce((s, l) => s + (l.leakageUsd ?? 0), 0);

  const fmtM = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1000)}K`);

  switch (id) {
    case "coo":
      return [
        {
          label: "Net margin leakage",
          value: fmtM(k.leakageTotalUsd),
          sub: "annualized exposure across the distributor book — Module 6 audit math",
          hot: true,
        },
        {
          label: "Quote turnaround latency",
          value: String(k.latencyCrew).padStart(2, "0"),
          sub: "accounts quoting RFQs outside the 24-hour competitive window",
          hot: k.latencyCrew > 0,
        },
        {
          label: "SPA laggards",
          value: String(k.spaLaggards).padStart(2, "0"),
          sub: "special pricing agreements unapplied at quote — margin walking off the floor",
        },
        {
          label: "Manual quoting share",
          value: `${k.manualAvg}%`,
          sub: "avg inside-sales workload on manual quote assembly (Module 2 factor median)",
        },
      ];
    case "vp_sales":
      return [
        {
          label: "On the board now",
          value: String(k.highIntentCount).padStart(2, "0"),
          sub: highIntentNames.length > 0 ? highIntentNames.join(" · ") : "no critical-band activity in the last 15 minutes",
          hot: k.highIntentCount > 0,
        },
        {
          label: "Recovery targets",
          value: String(k.criticalCount).padStart(2, "0"),
          sub: `QLV ≥ 85 · ${fmtM(criticalPool)} recoverable pool`,
        },
        {
          label: "Drafts to clear",
          value: String(k.draftsPending).padStart(2, "0"),
          sub: "reply agent work waiting on human gate — Pipeline view",
          hot: k.draftsPending > 0,
        },
        {
          label: "Signals 24h",
          value: String(k.telemetryEvents24h),
          sub: `${snap.ops.alerts24h} alerts · ${snap.ops.dispatchesSent24h} rep touches`,
        },
      ];
    case "dir_inside":
      return [
        {
          label: "Recovery queue",
          value: String(k.scoredCount).padStart(2, "0"),
          sub: "ranked strike depth — effective priority order, keyboard-ready",
        },
        {
          label: "SPA laggard burn-down",
          value: String(k.spaLaggards).padStart(2, "0"),
          sub: "accounts still quoting against expired or unapplied SPAs",
          hot: k.spaLaggards > 0,
        },
        {
          label: "Agent drafts pending",
          value: String(k.draftsPending).padStart(2, "0"),
          sub: "tier-2 human gate — approve from Pipeline, key a",
          hot: k.draftsPending > 0,
        },
        {
          label: "Rep touches 24h",
          value: String(k.dispatchesSent24h),
          sub: `${snap.ops.outboxPending} outbox pending · ${snap.ops.outboxPublished} published`,
        },
      ];
  }
}

// ---- 24h baseline deltas ------------------------------------------------- //

export interface KpiDelta {
  text: string;
  tone: "good" | "bad" | "flat";
}

type DeltaKind = "money" | "count" | "pct";

/** Per persona KPI: which baseline input to compare against, its unit, and which direction is good. */
const DELTA_MAP: Record<PersonaId, Array<{ key: keyof KpiInputs; kind: DeltaKind; upIsGood: boolean } | null>> = {
  // leakage ↓ good · latency crew ↓ good · SPA laggards ↓ good · manual share ↓ good
  coo: [
    { key: "leakageTotalUsd", kind: "money", upIsGood: false },
    { key: "latencyCrew", kind: "count", upIsGood: false },
    { key: "spaLaggards", kind: "count", upIsGood: false },
    { key: "manualAvg", kind: "pct", upIsGood: false },
  ],
  // on-board-now is a 15-minute window — too ephemeral for a 24h comparison
  vp_sales: [null, { key: "criticalCount", kind: "count", upIsGood: true }, { key: "draftsPending", kind: "count", upIsGood: false }, { key: "telemetryEvents24h", kind: "count", upIsGood: true }],
  // scored queue ↑ good · SPA burn-down ↓ good · drafts ↓ good · rep touches ↑ good
  dir_inside: [
    { key: "scoredCount", kind: "count", upIsGood: true },
    { key: "spaLaggards", kind: "count", upIsGood: false },
    { key: "draftsPending", kind: "count", upIsGood: false },
    { key: "dispatchesSent24h", kind: "count", upIsGood: true },
  ],
};

function formatDelta(kind: DeltaKind, abs: number): string {
  if (kind === "money") return abs >= 1_000_000 ? `$${(abs / 1_000_000).toFixed(1)}M` : `$${Math.round(abs / 1000)}K`;
  if (kind === "pct") return `${abs} pts`;
  return String(abs);
}

/**
 * Aligned with personaMetrics: per KPI card, the delta against the ~24h-ago
 * capture — or null when no baseline exists yet / the metric is too ephemeral.
 */
export function personaDeltas(id: PersonaId, live: KpiInputs, baseline: { capturedAtMs: number; inputs: KpiInputs } | null): (KpiDelta | null)[] {
  if (!baseline) return [null, null, null, null];
  return DELTA_MAP[id].map((spec) => {
    if (!spec) return null;
    const now = live[spec.key] ?? 0;
    const base = baseline.inputs[spec.key] ?? 0;
    const diff = now - base;
    if (diff === 0) return { text: "flat vs 24h", tone: "flat" as const };
    const glyph = diff > 0 ? "▲" : "▼";
    const good = diff > 0 === spec.upIsGood;
    return { text: `${glyph} ${formatDelta(spec.kind, Math.abs(diff))} vs 24h`, tone: good ? ("good" as const) : ("bad" as const) };
  });
}
