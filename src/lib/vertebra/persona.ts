/**
 * Persona engine — tailors the Enclave header and the RADAR KPI strip to the
 * three buying roles in the Syntropic ICP: COO, VP of Sales, Director of
 * Inside Sales at US/Canada industrial distributors ($10M–$150M).
 *
 * Every metric is derived from the live command snapshot — no decorative numbers.
 */
import type { CommandSnapshot } from "./command";

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
    .map((l) => l.score?.factors.find((f) => f.key === key)?.points ?? null)
    .filter((p): p is number => p != null);

/** The four defended metrics per persona, computed from live telemetry. */
export function personaMetrics(id: PersonaId, snap: CommandSnapshot): PersonaMetric[] {
  const leakageTotal = snap.leads.reduce((s, l) => s + (l.leakageUsd ?? 0), 0);
  const highIntent = snap.leads.filter((l) => l.highIntentNow);
  const critical = snap.leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85);
  const drafts = snap.triage.pending.length;
  const queue = snap.leads.filter((l) => l.score != null).length;

  const rfqLatency = factorPoints(snap, "rfq_latency");
  const latencyCrew = rfqLatency.filter((p) => p >= 55).length;
  const spaLaggards = factorPoints(snap, "unapplied_spa").filter((p) => p >= 50).length;
  const manualPts = factorPoints(snap, "manual_quoting_share");
  const manualAvg = manualPts.length > 0 ? Math.round(manualPts.reduce((a, b) => a + b, 0) / manualPts.length) : 0;

  const fmtM = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1000)}K`);

  switch (id) {
    case "coo":
      return [
        {
          label: "Net margin leakage",
          value: fmtM(leakageTotal),
          sub: "annualized exposure across the distributor book — Module 6 audit math",
          hot: true,
        },
        {
          label: "Quote turnaround latency",
          value: String(latencyCrew).padStart(2, "0"),
          sub: "accounts quoting RFQs outside the 24-hour competitive window",
          hot: latencyCrew > 0,
        },
        {
          label: "SPA laggards",
          value: String(spaLaggards).padStart(2, "0"),
          sub: "special pricing agreements unapplied at quote — margin walking off the floor",
        },
        {
          label: "Manual quoting share",
          value: `${manualAvg}%`,
          sub: "avg inside-sales workload on manual quote assembly (Module 2 factor median)",
        },
      ];
    case "vp_sales":
      return [
        {
          label: "On the board now",
          value: String(highIntent.length).padStart(2, "0"),
          sub: highIntent.length > 0 ? highIntent.map((l) => l.name).join(" · ") : "no critical-band activity in the last 15 minutes",
          hot: highIntent.length > 0,
        },
        {
          label: "Recovery targets",
          value: String(critical.length).padStart(2, "0"),
          sub: `QLV ≥ 85 · ${fmtM(critical.reduce((s, l) => s + (l.leakageUsd ?? 0), 0))} recoverable pool`,
        },
        {
          label: "Drafts to clear",
          value: String(drafts).padStart(2, "0"),
          sub: "reply agent work waiting on human gate — Pipeline view",
          hot: drafts > 0,
        },
        {
          label: "Signals 24h",
          value: String(snap.ops.telemetryEvents24h),
          sub: `${snap.ops.alerts24h} alerts · ${snap.ops.dispatchesSent24h} rep touches`,
        },
      ];
    case "dir_inside":
      return [
        {
          label: "Recovery queue",
          value: String(queue).padStart(2, "0"),
          sub: "ranked strike depth — effective priority order, keyboard-ready",
        },
        {
          label: "SPA laggard burn-down",
          value: String(spaLaggards).padStart(2, "0"),
          sub: "accounts still quoting against expired or unapplied SPAs",
          hot: spaLaggards > 0,
        },
        {
          label: "Agent drafts pending",
          value: String(drafts).padStart(2, "0"),
          sub: "tier-2 human gate — approve from Pipeline, key a",
          hot: drafts > 0,
        },
        {
          label: "Rep touches 24h",
          value: String(snap.ops.dispatchesSent24h),
          sub: `${snap.ops.outboxPending} outbox pending · ${snap.ops.outboxPublished} published`,
        },
      ];
  }
}
