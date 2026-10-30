/**
 * M2 verification — Little's Law drain forecast + p90 dwell.
 * Pure derivation checks against synthetic engagement rows. No DB.
 *
 *   bun scripts/test_ops_m2.ts
 */
import {
  deriveEngineView,
  deriveQueueForecastAlerts,
} from "../src/lib/vertebra/watches";
import type { EngagementShape } from "../src/lib/vertebra/command";

const HOUR = 3_600_000;
const DAY = 86_400_000;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

let seq = 0;
function mkEngagement(o: {
  id: string;
  status: string;
  paidAgeH: number;
  enteredAgeH?: number; // stage entry via trail event
  deliveredAtMs?: number | null;
  events?: Array<{ kind: string; detail: string; ageH: number }>;
}): EngagementShape {
  seq += 1;
  const paidAtMs = NOW - o.paidAgeH * HOUR;
  return {
    id: o.id,
    ref: `ref_${o.id}`,
    clientName: o.id,
    clientDomain: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    tier: "diagnostic_audit",
    amountUsd: 3500,
    source: "portal_webhook",
    status: o.status,
    intakeRfqPerMonth: null,
    intakeLineItems: null,
    guaranteeCleared: null,
    confirmedLeakageUsd: null,
    verdictNote: null,
    deliverableUrl: null,
    prospectId: null,
    prospectName: null,
    documentCount: 0,
    paidAtMs,
    deliveredAtMs: o.deliveredAtMs ?? null,
    events: [
      ...(o.enteredAgeH != null
        ? [{ id: `ev_in_${seq}`, kind: "stage_changed", detail: `→ ${o.status}`, actor: "operator", createdAtMs: NOW - o.enteredAgeH * HOUR }]
        : []),
      ...(o.events ?? []).map((e, i) => ({ id: `ev_${seq}_${i}`, kind: e.kind.startsWith("→") ? "stage_changed" : e.kind, detail: e.detail, actor: "operator", createdAtMs: NOW - e.ageH * HOUR })),
    ],
  };
}

// --------------------------------------------------------------------------- //
// p90 dwell
// --------------------------------------------------------------------------- //
console.log("deriveEngineView — p90 dwell");

{
  // 4 engagements in forensics, entered 1h/2h/3h/10h ago → dwells sorted
  // [1,2,3,10]h → p90 nearest rank = ceil(0.9*4)=4th = 10h. Median = 2.5h.
  const rows = [
    mkEngagement({ id: "a", status: "forensics", paidAgeH: 100, enteredAgeH: 10 }),
    mkEngagement({ id: "b", status: "forensics", paidAgeH: 50, enteredAgeH: 3 }),
    mkEngagement({ id: "c", status: "forensics", paidAgeH: 40, enteredAgeH: 2 }),
    mkEngagement({ id: "d", status: "forensics", paidAgeH: 30, enteredAgeH: 1 }),
  ];
  const view = deriveEngineView(rows, NOW);
  const st = view.stages.find((s) => s.stage === "forensics");
  check("p90 is the nearest-rank tail under n=4", st?.p90DwellMs === 10 * HOUR, `p90=${st?.p90DwellMs}`);
  check("median unchanged", st?.medianDwellMs === Math.round(((2 + 3) / 2) * 10) / 10 * HOUR || st?.medianDwellMs === 2.5 * HOUR, `median=${st?.medianDwellMs}`);
}

{
  // n=1 — p90 refuses to pretend (null), max still speaks.
  const view = deriveEngineView([mkEngagement({ id: "solo", status: "verdict", paidAgeH: 20, enteredAgeH: 2 })], NOW);
  const st = view.stages.find((s) => s.stage === "verdict");
  check("p90 null under n<4", st?.p90DwellMs == null);
  check("max still reported", st?.maxDwellMs === 2 * HOUR);
}

// --------------------------------------------------------------------------- //
// Drain ledger — Little's Law from the real trail
// --------------------------------------------------------------------------- //
console.log("deriveEngineView — drain ledger");

{
  // Two "Forensics → verdict" completions on older engagements (2d, 4d ago)
  // → drain 2/168h ≈ 0.0119/h. Queue depth 2 → timeToDrain = 2/0.0119 = 168h.
  const rows = [
    mkEngagement({ id: "done1", status: "verdict", paidAgeH: 100, enteredAgeH: 48, events: [{ kind: "stage_changed", detail: "Forensics → verdict", ageH: 48 }] }),
    mkEngagement({ id: "done2", status: "delivered", paidAgeH: 200, enteredAgeH: 96, events: [{ kind: "stage_changed", detail: "Forensics → verdict", ageH: 96 }], }),
    mkEngagement({ id: "q1", status: "forensics", paidAgeH: 100, enteredAgeH: 10 }),
    mkEngagement({ id: "q2", status: "forensics", paidAgeH: 80, enteredAgeH: 5 }),
  ];
  const view = deriveEngineView(rows, NOW);
  const d = view.drain.find((x) => x.stage === "forensics");
  check("depth reads the live queue", d?.depth === 2);
  check("completions counted from real trail events", d?.completions7d === 2, `completions=${d?.completions7d}`);
  check("drain rate is completions/168h", Math.abs((d?.drainPerHour ?? 0) - 2 / 168) < 1e-9);
  check("time to drain = depth / rate", d?.timeToDrainMs === Math.round((2 / (2 / 168)) * HOUR));
  // Delivered stage has no completions and no queue → honest null, not zero.
  const paid = view.drain.find((x) => x.stage === "paid");
  check("stage without completions reports no drain data", paid?.drainPerHour == null && paid?.timeToDrainMs == null);
}

// --------------------------------------------------------------------------- //
// Queue forecast watch
// --------------------------------------------------------------------------- //
console.log("deriveQueueForecastAlerts — promise priced against the drain");

{
  // Drain 2 completions/7d. Queue (oldest entry first): A0(15h in, head —
  // no one ahead, SLA clock's territory), A(10h in, paid 110h ago → 10h
  // left, 1 ahead → wait 84h ≫ 10h → crit), B(5h in, paid 96h ago → 24h
  // left, 2 ahead → wait 168h ≫ 24h → crit).
  const rows = [
    mkEngagement({ id: "done1", status: "verdict", paidAgeH: 150, enteredAgeH: 30, events: [{ kind: "stage_changed", detail: "Forensics → verdict", ageH: 30 }] }),
    mkEngagement({ id: "done2", status: "verdict", paidAgeH: 200, enteredAgeH: 20, events: [{ kind: "stage_changed", detail: "Forensics → verdict", ageH: 96 }] }),
    mkEngagement({ id: "A0", status: "forensics", paidAgeH: 130, enteredAgeH: 15 }),
    mkEngagement({ id: "A", status: "forensics", paidAgeH: 110, enteredAgeH: 10 }),
    mkEngagement({ id: "B", status: "forensics", paidAgeH: 96, enteredAgeH: 5 }),
  ];
  const alerts = deriveQueueForecastAlerts(rows, NOW);
  check("forecast fires for queued engagements whose wait exceeds the clock", alerts.length === 2, JSON.stringify(alerts.map((a) => a.title)));
  const a = alerts.find((x) => x.subjectId === "A");
  check("subject is the engagement at risk", Boolean(a));
  check("crit when the projected overrun is heavy", a?.severity === "crit");
  check("head of the queue is not double-alarmed", !alerts.some((x) => x.subjectId === "A0"));
  const aev = a?.evidence ?? undefined;
  check("evidence carries the drain math", Boolean(aev?.includes("drain 0.01/h") && aev?.includes("ahead") && aev?.includes("projected overrun")), aev);
  check("etaMs is the predicted time-to-impact", a?.etaMs != null && a.etaMs >= 0);
  // The verdict engagements are heads of their queue (1 each, no drain data
  // for verdict — no completions "Verdict → …") → no forecast for them.
  check("no drain data means no invented forecast", !alerts.some((x) => x.subjectId?.startsWith("done") === true));
}

{
  // Nobody ahead → the SLA clock owns that case; forecast stays silent.
  const rows = [
    mkEngagement({ id: "done1", status: "verdict", paidAgeH: 150, enteredAgeH: 30, events: [{ kind: "stage_changed", detail: "Forensics → verdict", ageH: 30 }] }),
    mkEngagement({ id: "solo", status: "forensics", paidAgeH: 110, enteredAgeH: 10 }),
  ];
  check("head of queue is not double-alarmed", deriveQueueForecastAlerts(rows, NOW).length === 0);
}

{
  // Terminal stages excluded; delivered excluded even with trail noise.
  const rows = [
    mkEngagement({ id: "done1", status: "verdict", paidAgeH: 150, enteredAgeH: 30, events: [{ kind: "stage_changed", detail: "Forensics → verdict", ageH: 30 }] }),
    mkEngagement({ id: "closed1", status: "closed", paidAgeH: 400, enteredAgeH: 300, deliveredAtMs: NOW - 200 * HOUR, events: [{ kind: "stage_changed", detail: "Forensics → verdict", ageH: 48 }] }),
  ];
  check("terminal and delivered engagements never forecast", deriveQueueForecastAlerts(rows, NOW).length === 0);
}

console.log(failures === 0 ? "\nall M2 checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
