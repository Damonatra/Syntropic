/**
 * M1 verification — seasonal sentinels + deck correlation.
 * Runs the pure derivation functions against synthetic rows and asserts the
 * math. No DB, no server, no product code touched. Exit 1 on any failure.
 *
 *   bun scripts/test_ops_m1.ts
 */
import {
  correlateDeck,
  deriveBaselineSentinels,
  type BaselineRow,
} from "../src/lib/vertebra/watches";
import type { OpsWatchAlert } from "../src/lib/vertebra/command";

const HOUR = 3_600_000;
const DAY = 86_400_000;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --------------------------------------------------------------------------- //
// Seasonal sentinels
// --------------------------------------------------------------------------- //
console.log("deriveBaselineSentinels — seasonal baseline");

// Fixed "now": day 7 at 14:00 UTC. Hour-of-day 14 is the busy hour.
const NOW = Date.UTC(2026, 9, 30, 14, 0, 0);

/** `count` hourly captures ending AT `endMs` (i = count-1 … 0, where 0 = now). */
function hourlyRows(endMs: number, count: number): BaselineRow[] {
  const rows: BaselineRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    rows.push({ capturedAtMs: endMs - i * HOUR, metrics: { outboxPending: 0, dispatchFailed24h: 0 } });
  }
  return rows;
}

// Case A — the 3 a.m. false positive the seasonal baseline exists to kill:
// night hour normally runs 6-7 events; a small night bump (7) looks like 3σ
// on a flat window but sits inside its same-hour norm (μ=6.5 σ=0.5 — 7 is
// within μ+2σ=7.5). Seasonal must stay quiet where the flat window fires.
{
  const NOW3 = Date.UTC(2026, 9, 30, 3, 0, 0);
  const night = hourlyRows(NOW3, 169); // i=0…168 → 8 captures at hour 03
  for (const r of night) {
    const i = (NOW3 - r.capturedAtMs) / HOUR;
    const h = new Date(r.capturedAtMs).getUTCHours();
    if (h === 3 && i > 0) r.metrics.outboxPending = [6, 7, 6, 7, 6, 7, 6][i / 24 - 1] ?? 6;
  }
  // Trailing trend climbing into the night bump: 00:00→03:00 = 4,5,6,7.
  const last = night.slice(-4);
  [4, 5, 6, 7].forEach((v, i) => (last[i].metrics.outboxPending = v));
  const alerts = deriveBaselineSentinels(night, NOW3);
  check("night bump stays quiet under seasonal baseline", alerts.length === 0, JSON.stringify(alerts.map((a) => a.evidence)));
}

// Case B — a real surge at the busy hour: same-hour peers sit tight at
// 44-45, the latest capture jumps to 47 while climbing +1/h. Seasonal must
// fire (z ≥ 2 against the sample the latest point belongs to) and say so.
{
  const rows = hourlyRows(NOW, 168);
  const hourPeers = rows.filter((r) => new Date(r.capturedAtMs).getUTCHours() === 14);
  hourPeers.forEach((r, i) => {
    if (i < hourPeers.length - 1) r.metrics.outboxPending = [44, 44, 44, 45, 44, 45][i] ?? 44;
  });
  const trailing = rows.slice(-5);
  [43, 44, 45, 46, 47].forEach((v, i) => (trailing[i].metrics.outboxPending = v));
  const alerts = deriveBaselineSentinels(rows, NOW);
  const outbox = alerts.find((a) => a.watchId === "sentinel_outbox");
  const ev = outbox?.evidence ?? undefined;
  check("busy-hour surge fires", Boolean(outbox), JSON.stringify(alerts.map((a) => a.evidence)));
  check("evidence names the seasonal sample", Boolean(ev?.includes("same-hour/7d")), ev);
  check("evidence carries μ σ z slope math", Boolean(ev?.includes("μ=") && ev?.includes("σ=") && ev?.includes("z=") && ev?.includes("slope=")));
}

// Case C — thin seasonal history falls back to the flat window, and says so.
{
  const rows = hourlyRows(NOW, 27); // just over a day — 2 same-hour peers only
  const trailing = rows.slice(-5);
  [48, 49, 50, 51, 52].forEach((v, i) => (trailing[i].metrics.outboxPending = v));
  const alerts = deriveBaselineSentinels(rows, NOW);
  const outbox = alerts.find((a) => a.watchId === "sentinel_outbox");
  const evFlat = outbox?.evidence ?? undefined;
  check("thin history still fires (flat fallback)", Boolean(outbox), JSON.stringify(alerts.map((a) => a.evidence)));
  check("evidence discloses the flat fallback", Boolean(evFlat?.includes("flat window")), evFlat);
}

// Case D — flat history: σ = 0, the sentinel refuses to invent an anomaly.
{
  const rows: BaselineRow[] = [];
  for (let i = 168; i >= 1; i--) {
    rows.push({ capturedAtMs: NOW - i * HOUR, metrics: { outboxPending: 3, dispatchFailed24h: 0 } });
  }
  check("zero-variance history stays silent", deriveBaselineSentinels(rows, NOW).length === 0);
}

// --------------------------------------------------------------------------- //
// Correlation
// --------------------------------------------------------------------------- //
console.log("correlateDeck — one incident, not twelve rows");

const mk = (over: Partial<OpsWatchAlert> & { watchId: string }): OpsWatchAlert => ({
  key: `${over.watchId}:${over.subjectId ?? "system"}:0`,
  watch: over.watchId,
  severity: "warn",
  subjectKind: "system",
  subjectId: null,
  subjectLabel: "x",
  title: over.watchId,
  action: "act",
  evidence: null,
  etaMs: null,
  firedAtMs: 0,
  ...over,
});

// Rule 1 — threshold crit + sentinel warn → sentinel echoes the alarm.
{
  const deck = correlateDeck([
    mk({ watchId: "sentinel_outbox", key: "s1" }),
    mk({ watchId: "outbox_backlog", key: "t1", severity: "crit" }),
    mk({ watchId: "sla_deliverable", key: "d1", subjectId: "e1", subjectKind: "engagement" }),
  ]);
  check("root first, echo after", deck[0].key === "t1" && deck[1].key === "s1", deck.map((a) => a.key).join(","));
  check("echo carries causedBy with reason", deck[1].causedBy?.key === "t1" && Boolean(deck[1].causedBy?.reason));
  check("root untouched", !deck[0].causedBy);
  check("unrelated root keeps its place", deck[2].key === "d1" && !deck[2].causedBy);
  check("echo keeps its own ack key", deck[1].key === "s1");
}

// Rule 1 reversed — sentinel crossed first (crit), threshold alarm warn.
{
  const deck = correlateDeck([
    mk({ watchId: "outbox_backlog", key: "t1" }),
    mk({ watchId: "sentinel_outbox", key: "s1", severity: "crit" }),
  ]);
  check("crit sentinel outranks warn alarm as root", deck[0].key === "s1" && deck[1].key === "t1");
  check("threshold alarm explained as riding the trend", Boolean(deck[1].causedBy?.reason.includes("crossed first")));
}

// Rule 2 — stalled capture explains live sentinels when no threshold alarm.
{
  const deck = correlateDeck([
    mk({ watchId: "baseline_stale", key: "b1" }),
    mk({ watchId: "sentinel_failures", key: "f1" }),
    mk({ watchId: "sentinel_outbox", key: "s1" }),
  ]);
  check("both sentinels grouped under baseline_stale", deck[0].key === "b1" && deck[1].causedBy?.key === "b1" && deck[2].causedBy?.key === "b1");
  check("reason names frozen history", Boolean(deck[1].causedBy?.reason.includes("frozen history")));
}

// Rule 3 — verdict clock inside the deliverable clock, same engagement only.
{
  const deck = correlateDeck([
    mk({ watchId: "sla_deliverable", key: "d1", subjectId: "e1", subjectKind: "engagement", severity: "crit" }),
    mk({ watchId: "sla_verdict", key: "v1", subjectId: "e1", subjectKind: "engagement" }),
    mk({ watchId: "sla_verdict", key: "v2", subjectId: "e2", subjectKind: "engagement" }),
  ]);
  check("verdict grouped under its own engagement's clock", deck[0].key === "d1" && deck[1].key === "v1" && deck[1].causedBy?.key === "d1");
}

// Quiet deck — nothing to correlate, order is just the rank.
{
  const deck = correlateDeck([mk({ watchId: "email_coverage", key: "e1", severity: "info" })]);
  check("single row passes through ranked", deck.length === 1 && !deck[0].causedBy);
}

console.log(failures === 0 ? "\nall M1 checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
