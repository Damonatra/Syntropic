/**
 * The Watchtower — the watch layer behind the Ops tab.
 *
 * Everything here is pure derivation from real rows: no DB, no React, no
 * invented numbers. The command route measures and loads; this module turns
 * those rows into (a) vitals — measured heartbeats, (b) the alert deck —
 * ranked watches with evidence and predicted time-to-impact, (c) the
 * document turnaround engine view — stage flow, dwell, SLA risk.
 *
 * Two prediction engines, both honest:
 *   · SLA clocks      — deterministic countdowns on the turnaround promise
 *                       (deliverable within 5 days of payment; verdict within
 *                       3 days of opening forensics), with dwell-based
 *                       severity so the alarm rings before the breach.
 *   · trend sentinels — least-squares slope + seasonal z-score over the
 *                       hourly CommandBaseline history; the baseline reads
 *                       same-hour-of-day peers across the trailing week (a
 *                       funnel is not stationary — nights and weekends look
 *                       like failures to a flat window), falling back to the
 *                       flat 24h window when that history is thin. A metric
 *                       rising 2σ above its baseline with positive slope
 *                       fires WARN with an ETA to threshold; crossing the
 *                       threshold fires CRIT.
 *
 * correlateDeck then groups the echoes: a threshold alarm and its sentinel
 * are one signal, stalled capture explains the sentinels that read it, and a
 * verdict clock sits inside its engagement's deliverable clock. One incident,
 * not twelve rows — and causality is never invented.
 *
 * The watchtower never fires an alarm it cannot show the math for: every
 * alert carries an evidence line, and predictive alerts carry etaMs.
 *
 * The full roster, eight watches deep:
 *   SLA clocks · funnel thresholds · system vitals · trend sentinels ·
 *   engine pulses · queue forecast (Little's Law) · watchtower self-audit
 *   (flap) · coverage (guarantee exposure, deliverable liveness, drought) —
 *   plus the escalation ladder: a crit unacked 15 minutes names itself and
 *   re-pages through configured channels, honestly or not at all.
 *
 * Acks are keyed `${watchId}:${subjectId ?? "system"}:${windowBucket}` —
 * suppression lasts one window (6h); a condition that clears and refires
 * later returns as a fresh key. Never nagged twice in a window, never
 * silenced forever.
 */

import type {
  EngagementShape,
  EngineDrainStat,
  EnginePulseRow,
  EngineStageStat,
  EngineView,
  KpiInputs,
  OpsVital,
  OpsWatchAlert,
  WatchSeverity,
} from "./command";
import { LEAKAGE_MODEL } from "./leakage";

// --------------------------------------------------------------------------- //
// Policy — the promises the desk sells, in one place
// --------------------------------------------------------------------------- //

export const SLA = {
  /** Deliverable promised within 5 days of payment. */
  deliverableMs: 5 * 86_400_000,
  /** Verdict (the guarantee decision) promised within 3 days of forensics. */
  verdictMs: 3 * 86_400_000,
  /** Deliverable alarm rings when this much of the promise remains. */
  deliverableCritMs: 12 * 3_600_000,
  deliverableWarnMs: 2 * 86_400_000,
  /** Verdict alarm rings when this much of the promise remains. */
  verdictCritMs: 6 * 3_600_000,
  verdictWarnMs: 24 * 3_600_000,
} as const;

export const ACK_WINDOW_MS = 6 * 3_600_000;
export const BASELINE_STALE_MS = 2 * 3_600_000;
export const ENGINE_STALE_FACTOR = 3;
export const ENGINE_STALE_MIN_MS = 10 * 60_000;

/** Absolute floors so tiny counts never trip noise-level sentinels. */
export const THRESHOLDS = {
  outboxWarn: 10,
  outboxCrit: 25,
  outboxSentinelFloor: 5,
  outboxSentinelThreshold: 25,
  failedWarn: 3,
  failedCrit: 8,
  failedSentinelFloor: 2,
  failedSentinelThreshold: 8,
} as const;

const HOUR = 3_600_000;
const DAY = 86_400_000;

export const windowBucket = (nowMs: number): number => Math.floor(nowMs / ACK_WINDOW_MS);

export const alertKey = (watchId: string, subjectId: string | null, nowMs: number): string =>
  `${watchId}:${subjectId ?? "system"}:${windowBucket(nowMs)}`;

/** Crit first, then soonest time-to-impact, then newest fire. */
export function rankAlerts(alerts: OpsWatchAlert[]): OpsWatchAlert[] {
  const sev: Record<WatchSeverity, number> = { crit: 0, warn: 1, info: 2 };
  return [...alerts].sort((a, b) => {
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
    if (a.etaMs != null && b.etaMs != null && a.etaMs !== b.etaMs) return a.etaMs - b.etaMs;
    if (a.etaMs != null && b.etaMs == null) return -1;
    if (a.etaMs == null && b.etaMs != null) return 1;
    return b.firedAtMs - a.firedAtMs;
  });
}

// --------------------------------------------------------------------------- //
// Correlation — one incident, not twelve rows
// --------------------------------------------------------------------------- //

/**
 * Cascade noise is how monitoring systems train their operators to ignore
 * them: one failure lights five watches, the deck reads "five crises", and
 * the operator learns to skim. correlateDeck marks the echoes.
 *
 * Only where the math truly connects — causality is never invented:
 *   1. same-signal echo    a threshold alarm and its trend sentinel are the
 *                          same metric; the one with impact now is the root,
 *                          the other rides as its trend view.
 *   2. frozen history      when KPI capture stalls, the sentinels' "latest"
 *                          point is stale — they are explained by the stale
 *                          capture, not separate incidents.
 *   3. one clock inside    a verdict clock on an engagement sits inside that
 *                          engagement's deliverable clock — the verdict
 *                          decision gates the deliverable.
 *
 * Echoes keep their severity chip, their math, and their own ack key —
 * correlation changes reading order and attribution, never suppressibility.
 * Ordering: roots ranked first, each root immediately followed by its echoes.
 */
export function correlateDeck(alerts: OpsWatchAlert[]): OpsWatchAlert[] {
  if (alerts.length < 2) return rankAlerts(alerts);

  const sevRank: Record<WatchSeverity, number> = { crit: 0, warn: 1, info: 2 };
  const caused = new Map<string, { key: string; reason: string }>();
  const free = (a: OpsWatchAlert) => !caused.has(a.key);
  const worst = (rows: OpsWatchAlert[]) =>
    rows.reduce((a, b) => (sevRank[a.severity] <= sevRank[b.severity] ? a : b));

  // Rule 1 — a threshold alarm and its sentinel are one signal, twice told.
  for (const pair of [
    { threshold: "outbox_backlog", sentinel: "sentinel_outbox", label: "outbox backlog" },
    { threshold: "dispatch_failures", sentinel: "sentinel_failures", label: "dispatch failure" },
  ]) {
    const tRows = alerts.filter((a) => a.watchId === pair.threshold && free(a));
    const sRows = alerts.filter((a) => a.watchId === pair.sentinel && free(a));
    if (!tRows.length || !sRows.length) continue;
    const root = worst([...tRows, ...sRows]);
    const echoes = root.watchId === pair.threshold ? sRows : tRows;
    const reason =
      root.watchId === pair.threshold
        ? `same signal — the ${pair.label} threshold alarm is already live`
        : `the ${pair.label} sentinel crossed first — the threshold breach is riding the same trend`;
    for (const e of echoes) caused.set(e.key, { key: root.key, reason });
  }

  // Rule 2 — stalled capture freezes the trend math the sentinels read.
  const stale = alerts.find((a) => a.watchId === "baseline_stale" && free(a));
  if (stale) {
    for (const s of alerts.filter(
      (a) => (a.watchId === "sentinel_outbox" || a.watchId === "sentinel_failures") && free(a),
    )) {
      caused.set(s.key, {
        key: stale.key,
        reason: "trend math reads a frozen history — KPI capture has stalled",
      });
    }
  }

  // Rule 3 — the verdict clock lives inside the deliverable clock.
  for (const d of alerts.filter((a) => a.watchId === "sla_deliverable")) {
    const v = alerts.find(
      (a) => a.watchId === "sla_verdict" && a.subjectId === d.subjectId && free(a),
    );
    if (v && free(d)) {
      caused.set(v.key, {
        key: d.key,
        reason: "same engagement — the verdict decision gates the deliverable clock",
      });
    }
  }

  if (caused.size === 0) return rankAlerts(alerts);

  const out: OpsWatchAlert[] = [];
  const placed = new Set<string>();
  for (const root of rankAlerts(alerts.filter(free))) {
    out.push(root);
    placed.add(root.key);
    for (const echo of rankAlerts(alerts.filter((a) => caused.get(a.key)?.key === root.key))) {
      out.push({ ...echo, causedBy: caused.get(echo.key) });
      placed.add(echo.key);
    }
  }
  // Defensive: an echo whose root left the deck between derivations stays
  // readable as a root rather than vanishing.
  for (const a of rankAlerts(alerts.filter((a) => !placed.has(a.key)))) {
    out.push(caused.has(a.key) ? { ...a, causedBy: caused.get(a.key) } : a);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Time helpers — every duration rendered for humans
// --------------------------------------------------------------------------- //

export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.max(0, Math.round(abs / 1000))}s`;
  if (abs < HOUR) return `${Math.round(abs / 60_000)}m`;
  if (abs < DAY) return `${Math.round((abs / HOUR) * 10) / 10}h`;
  return `${Math.round((abs / DAY) * 10) / 10}d`;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/** Nearest-rank p90. Needs a sample of 4+ — a percentile of 3 points is a
 *  costume; below that the max column already tells the tail's story. */
const p90 = (xs: number[]): number | null => {
  if (xs.length < 4) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
};

// --------------------------------------------------------------------------- //
// Stage-entry times — read from the append-only engagement trail
// --------------------------------------------------------------------------- //

/**
 * When the engagement entered `stage`, read from its ledger: the newest
 * `stage_changed` event whose "→ target" names the stage; `paid` falls back
 * to the `ingested` event, then to paidAt. Null when the trail cannot prove
 * it — callers degrade honestly instead of guessing.
 */
export function stageEnteredAtMs(engagement: EngagementShape, stage: string): number | null {
  if (stage === "paid") {
    const ing = engagement.events.find((e) => e.kind === "ingested");
    return ing?.createdAtMs ?? engagement.paidAtMs;
  }
  const ev = engagement.events.find(
    (e) => (e.kind === "stage_changed" || e.kind === "delivered") && e.detail?.includes("→"),
  );
  if (ev && ev.detail) {
    const target = ev.detail.split("→").pop()?.trim();
    if (target === stage) return ev.createdAtMs;
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Watch 1 — SLA clocks on the document turnaround engine
// --------------------------------------------------------------------------- //

interface SlaInput {
  id: string;
  ref: string;
  clientName: string;
  amountUsd: number;
  status: string;
  paidAtMs: number;
  deliveredAtMs: number | null;
  events: Array<{ id: string; kind: string; detail: string | null; createdAtMs: number }>;
}

/**
 * SLA clocks per active engagement. Deliverable clock runs payment → now for
 * every engagement not yet delivered; verdict clock runs from the moment the
 * engagement entered the verdict stage. Severity by promise remaining, so
 * the operator sees the breach coming hours before it lands.
 */
export function deriveSlaAlerts(engagements: SlaInput[], nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];
  for (const e of engagements) {
    if (e.status === "sow" || e.status === "closed") continue;

    const delivered = e.status === "delivered" || e.deliveredAtMs != null;
    if (!delivered) {
      const remaining = SLA.deliverableMs - (nowMs - e.paidAtMs);
      if (remaining < SLA.deliverableCritMs) {
        const overdue = remaining <= 0;
        out.push({
          key: alertKey("sla_deliverable", e.id, nowMs),
          watchId: "sla_deliverable",
          watch: "Turnaround SLA — deliverable",
          severity: "crit",
          subjectKind: "engagement",
          subjectId: e.id,
          subjectLabel: e.clientName,
          title: overdue
            ? `${e.clientName} deliverable is ${humanDuration(-remaining)} past the promise`
            : `${e.clientName} breaches the deliverable promise in ${humanDuration(remaining)}`,
          action: "work the desk — forensics → verdict → generate & deliver",
          evidence: `paid ${humanDuration(nowMs - e.paidAtMs)} ago · promise ${humanDuration(SLA.deliverableMs)} · remaining ${humanDuration(remaining)}`,
          etaMs: Math.max(0, remaining),
          firedAtMs: nowMs,
        });
      } else if (remaining < SLA.deliverableWarnMs) {
        out.push({
          key: alertKey("sla_deliverable", e.id, nowMs),
          watchId: "sla_deliverable",
          watch: "Turnaround SLA — deliverable",
          severity: "warn",
          subjectKind: "engagement",
          subjectId: e.id,
          subjectLabel: e.clientName,
          title: `${e.clientName} — ${humanDuration(remaining)} left on the deliverable promise`,
          action: "keep the desk moving — next stage is one key away",
          evidence: `paid ${humanDuration(nowMs - e.paidAtMs)} ago · promise ${humanDuration(SLA.deliverableMs)} · remaining ${humanDuration(remaining)}`,
          etaMs: remaining,
          firedAtMs: nowMs,
        });
      }
    }

    if (e.status === "verdict") {
      const entered = stageEnteredAtMs(e as EngagementShape, "verdict");
      if (entered != null) {
        const remaining = SLA.verdictMs - (nowMs - entered);
        const undecided = true; // verdict stage with undecided guarantee — the recorder gates delivery
        if (remaining < SLA.verdictCritMs) {
          out.push({
            key: alertKey("sla_verdict", e.id, nowMs),
            watchId: "sla_verdict",
            watch: "Verdict clock — guarantee decision",
            severity: "crit",
            subjectKind: "engagement",
            subjectId: e.id,
            subjectLabel: e.clientName,
            title:
              remaining <= 0
                ? `${e.clientName} verdict is ${humanDuration(-remaining)} overdue — guarantee decision open`
                : `${e.clientName} verdict clock expires in ${humanDuration(remaining)}`,
            action: "record the verdict — the $10,000 decision gates delivery",
            evidence: `in verdict ${humanDuration(nowMs - entered)} · verdict promise ${humanDuration(SLA.verdictMs)} · remaining ${humanDuration(remaining)}`,
            etaMs: Math.max(0, remaining),
            firedAtMs: nowMs,
          });
        } else if (remaining < SLA.verdictWarnMs && undecided) {
          out.push({
            key: alertKey("sla_verdict", e.id, nowMs),
            watchId: "sla_verdict",
            watch: "Verdict clock — guarantee decision",
            severity: "warn",
            subjectKind: "engagement",
            subjectId: e.id,
            subjectLabel: e.clientName,
            title: `${e.clientName} — ${humanDuration(remaining)} to decide the guarantee`,
            action: "record the verdict before the clock forces it",
            evidence: `in verdict ${humanDuration(nowMs - entered)} · verdict promise ${humanDuration(SLA.verdictMs)} · remaining ${humanDuration(remaining)}`,
            etaMs: remaining,
            firedAtMs: nowMs,
          });
        }
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Watch 2 — funnel health (outbox, dispatch failures, coverage)
// --------------------------------------------------------------------------- //

export interface FunnelInput {
  outboxPending: number;
  dispatchFailed24h: number;
  dispatchSent24h: number;
  verifiedEmailShare: number;
  leadCount: number;
}

export function deriveFunnelAlerts(f: FunnelInput, nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];
  if (f.outboxPending >= THRESHOLDS.outboxCrit) {
    out.push({
      key: alertKey("outbox_backlog", null, nowMs),
      watchId: "outbox_backlog",
      watch: "Outbox backlog",
      severity: "crit",
      subjectKind: "system",
      subjectId: null,
      subjectLabel: "outbox",
      title: `Outbox backlog at ${f.outboxPending} — publish pipeline is falling behind`,
      action: "publish the outbox — the funnel is stalled at the gate",
      evidence: `${f.outboxPending} events pending · crit threshold ${THRESHOLDS.outboxCrit}`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  } else if (f.outboxPending >= THRESHOLDS.outboxWarn) {
    out.push({
      key: alertKey("outbox_backlog", null, nowMs),
      watchId: "outbox_backlog",
      watch: "Outbox backlog",
      severity: "warn",
      subjectKind: "system",
      subjectId: null,
      subjectLabel: "outbox",
      title: `Outbox backlog at ${f.outboxPending} events`,
      action: "publish soon — the ledger is growing faster than it drains",
      evidence: `${f.outboxPending} events pending · warn threshold ${THRESHOLDS.outboxWarn} · crit ${THRESHOLDS.outboxCrit}`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  }

  if (f.dispatchFailed24h >= THRESHOLDS.failedCrit) {
    out.push({
      key: alertKey("dispatch_failures", null, nowMs),
      watchId: "dispatch_failures",
      watch: "Dispatch failures",
      severity: "crit",
      subjectKind: "funnel",
      subjectId: null,
      subjectLabel: "channel A",
      title: `${f.dispatchFailed24h} dispatches failed in 24h — the send loop is bleeding`,
      action: "read the tick errors — provider or suppression cause, then re-run the tick",
      evidence: `${f.dispatchFailed24h} failed / ${f.dispatchSent24h} sent in 24h · crit threshold ${THRESHOLDS.failedCrit}`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  } else if (f.dispatchFailed24h >= THRESHOLDS.failedWarn) {
    out.push({
      key: alertKey("dispatch_failures", null, nowMs),
      watchId: "dispatch_failures",
      watch: "Dispatch failures",
      severity: "warn",
      subjectKind: "funnel",
      subjectId: null,
      subjectLabel: "channel A",
      title: `${f.dispatchFailed24h} dispatch failures in 24h`,
      action: "scan the tick errors before the next send window",
      evidence: `${f.dispatchFailed24h} failed / ${f.dispatchSent24h} sent in 24h · warn threshold ${THRESHOLDS.failedWarn}`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  }

  if (f.leadCount >= 5 && f.verifiedEmailShare < 50) {
    out.push({
      key: alertKey("email_coverage", null, nowMs),
      watchId: "email_coverage",
      watch: "Email coverage",
      severity: "info",
      subjectKind: "funnel",
      subjectId: null,
      subjectLabel: "channel A",
      title: `Verified email coverage at ${f.verifiedEmailShare}% — channel A reach is capped`,
      action: "re-run permutations on unscored, unverified prospects",
      evidence: `${f.verifiedEmailShare}% of ${f.leadCount} prospects carry a verified best-email`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Watch 3 — system vitals gone wrong (baseline capture stalled)
// --------------------------------------------------------------------------- //

export function deriveSystemAlerts(input: { baselineAgeMs: number | null }, nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];
  if (input.baselineAgeMs != null && input.baselineAgeMs > BASELINE_STALE_MS) {
    out.push({
      key: alertKey("baseline_stale", null, nowMs),
      watchId: "baseline_stale",
      watch: "Baseline capture",
      severity: "warn",
      subjectKind: "system",
      subjectId: null,
      subjectLabel: "command baseline",
      title: `Hourly KPI capture stalled — baselines ${humanDuration(input.baselineAgeMs)} old`,
      action: "open the command route once — the capture appends on build",
      evidence: `newest capture ${humanDuration(input.baselineAgeMs)} ago · stale past ${humanDuration(BASELINE_STALE_MS)} · radar deltas frozen until it resumes`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Watch 4 — trend sentinels over the hourly baseline history (predictive)
// --------------------------------------------------------------------------- //

export interface BaselineRow {
  capturedAtMs: number;
  metrics: Partial<KpiInputs>;
}

interface SentinelSpec {
  metric: keyof Pick<KpiInputs, "outboxPending" | "dispatchFailed24h">;
  watchId: string;
  watch: string;
  subjectLabel: string;
  floor: number;
  threshold: number;
  unit: string;
  action: string;
}

const SENTINELS: SentinelSpec[] = [
  {
    metric: "outboxPending",
    watchId: "sentinel_outbox",
    watch: "Sentinel — outbox trend",
    subjectLabel: "outbox",
    floor: THRESHOLDS.outboxSentinelFloor,
    threshold: THRESHOLDS.outboxSentinelThreshold,
    unit: "events",
    action: "publish the outbox before the backlog lands",
  },
  {
    metric: "dispatchFailed24h",
    watchId: "sentinel_failures",
    watch: "Sentinel — failure trend",
    subjectLabel: "channel A",
    floor: THRESHOLDS.failedSentinelFloor,
    threshold: THRESHOLDS.failedSentinelThreshold,
    unit: "failures",
    action: "inspect tick errors — a rising failure trend precedes the pile",
  },
];

/**
 * The predictive layer. For each sentinel metric: need ≥ 4 captures inside
 * the trailing 24h with non-null values and σ > 0. Fires when the latest
 * value sits ≥ 2σ above its baseline with positive slope, and ≥ floor.
 * Evidence carries the full math: μ, σ, latest, slope, and the ETA to the
 * hard threshold at the current rate. Crossing the threshold promotes to CRIT.
 *
 * The baseline itself is seasonal: μ and σ come from same-hour-of-day peers
 * across the trailing 7 days whenever ≥ 4 such peers exist, because a B2B
 * funnel is not stationary — nights and weekends look like failures to a
 * flat window, and a Monday 09:00 surge is not an anomaly. When the same-hour
 * history is too thin, the flat trailing-24h window is used and the evidence
 * line says so. Slope and ETA always read the trailing 24h — momentum, not
 * season, decides how fast the line is being crossed.
 */
export function deriveBaselineSentinels(rows: BaselineRow[], nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];
  const cutoff = nowMs - DAY;
  const week = rows.filter((r) => r.capturedAtMs >= nowMs - 7 * DAY);
  const recent = week.filter((r) => r.capturedAtMs >= cutoff);
  if (recent.length < 4) return out;

  for (const spec of SENTINELS) {
    const pts = recent
      .map((r) => ({ t: r.capturedAtMs, v: r.metrics[spec.metric] }))
      .filter((p): p is { t: number; v: number } => typeof p.v === "number");
    if (pts.length < 4) continue;

    const latest = pts[pts.length - 1].v;

    // Flat trailing-24h baseline — the fallback when seasonal history is thin.
    const flat = pts.map((p) => p.v);

    // Seasonal baseline — same UTC hour-of-day peers across the trailing week.
    const latestHour = new Date(pts[pts.length - 1].t).getUTCHours();
    const peers = week
      .map((r) => ({ t: r.capturedAtMs, v: r.metrics[spec.metric] }))
      .filter(
        (p): p is { t: number; v: number } =>
          typeof p.v === "number" && new Date(p.t).getUTCHours() === latestHour,
      );

    const useSeasonal = peers.length >= 4;
    const sample = useSeasonal ? peers.map((p) => p.v) : flat;
    const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
    const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length;
    const sigma = Math.sqrt(variance);
    if (sigma <= 0) continue;
    if (latest < Math.max(spec.floor, mean + 2 * sigma)) continue;

    // Least-squares slope in units/hour over the trailing 24h.
    const t0 = pts[0].t;
    const xs = pts.map((p) => (p.t - t0) / HOUR);
    const ys = flat;
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = flat.reduce((a, b) => a + b, 0) / flat.length;
    const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const varX = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const slope = varX > 0 ? cov / varX : 0; // units per hour
    if (slope <= 0) continue;

    const z = (latest - mean) / sigma;
    const etaMs = latest >= spec.threshold ? 0 : Math.round(((spec.threshold - latest) / slope) * HOUR);
    const severity: WatchSeverity = latest >= spec.threshold ? "crit" : "warn";
    const title =
      severity === "crit"
        ? `Sentinel: ${spec.subjectLabel} crossed ${spec.threshold} ${spec.unit} — ${latest} and climbing +${Math.round(slope * 10) / 10}/h`
        : `Sentinel: ${spec.subjectLabel} trending ${latest} ${spec.unit} — threshold ~${spec.threshold} in ${humanDuration(etaMs ?? 0)} at current rate`;
    const math = `μ=${Math.round(mean * 10) / 10} σ=${Math.round(sigma * 10) / 10} · latest=${latest} z=${Math.round(z * 10) / 10}σ · slope=+${Math.round(slope * 100) / 100}/h`;
    const sampleLabel = useSeasonal
      ? `n=${sample.length} same-hour/7d`
      : `n=${sample.length} captures/24h · flat window (thin seasonal history)`;
    out.push({
      key: alertKey(spec.watchId, null, nowMs),
      watchId: spec.watchId,
      watch: spec.watch,
      severity,
      subjectKind: "system",
      subjectId: null,
      subjectLabel: spec.subjectLabel,
      title,
      action: spec.action,
      evidence: `${sampleLabel} · ${math}`,
      etaMs,
      firedAtMs: nowMs,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Watch 5 — external engines (the engine contract's pulses)
// --------------------------------------------------------------------------- //

/**
 * A reporting engine goes on the deck when it declares failure, reports warn,
 * or goes silent past max(3× its declared cadence, 10 minutes). Silence is
 * the loudest signal an ingress-only engine can send.
 */
export function deriveEngineAlerts(pulses: EnginePulseRow[], nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];
  const byKey = new Map<string, EnginePulseRow>();
  for (const p of pulses) {
    const k = `${p.engineId}:${p.watchId}`;
    const cur = byKey.get(k);
    if (!cur || p.atMs > cur.atMs) byKey.set(k, p);
  }
  for (const p of byKey.values()) {
    const staleMs = p.expectEveryMs != null ? Math.max(ENGINE_STALE_FACTOR * p.expectEveryMs, ENGINE_STALE_MIN_MS) : null;
    if (staleMs != null && nowMs - p.atMs > staleMs) {
      out.push({
        key: alertKey("engine_silent", `${p.engineId}:${p.watchId}`, nowMs),
        watchId: "engine_silent",
        watch: "Engine silent",
        severity: "crit",
        subjectKind: "engine",
        subjectId: p.engineId,
        subjectLabel: p.engineId,
        title: `Engine "${p.engineId}" went silent — no pulse for ${humanDuration(nowMs - p.atMs)}`,
        action: "check the engine host — the contract expects a pulse every " + humanDuration(p.expectEveryMs ?? ENGINE_STALE_MIN_MS),
        evidence: `last beat ${humanDuration(nowMs - p.atMs)} ago · declared cadence ${humanDuration(p.expectEveryMs ?? 0)} · silence threshold ${humanDuration(staleMs)}`,
        etaMs: null,
        firedAtMs: nowMs,
      });
      continue;
    }
    if (p.status === "fail") {
      out.push({
        key: alertKey("engine_fail", `${p.engineId}:${p.watchId}`, nowMs),
        watchId: "engine_fail",
        watch: "Engine failure",
        severity: "crit",
        subjectKind: "engine",
        subjectId: p.engineId,
        subjectLabel: p.engineId,
        title: `Engine "${p.engineId}" reports failure on ${p.watchId}`,
        action: p.detail ?? "open the engine view — the pulse carries the detail",
        evidence: `pulse ${p.watchId} · fail · ${humanDuration(nowMs - p.atMs)} ago`,
        etaMs: null,
        firedAtMs: nowMs,
      });
    } else if (p.status === "warn") {
      out.push({
        key: alertKey("engine_warn", `${p.engineId}:${p.watchId}`, nowMs),
        watchId: "engine_warn",
        watch: "Engine warning",
        severity: "warn",
        subjectKind: "engine",
        subjectId: p.engineId,
        subjectLabel: p.engineId,
        title: `Engine "${p.engineId}" warns on ${p.watchId}`,
        action: p.detail ?? "review the pulse detail",
        evidence: `pulse ${p.watchId} · warn · ${humanDuration(nowMs - p.atMs)} ago`,
        etaMs: null,
        firedAtMs: nowMs,
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// The engine view — the document turnaround pipeline, measured
// --------------------------------------------------------------------------- //

const ACTIVE_STAGES: Array<{ stage: string; label: string }> = [
  { stage: "paid", label: "Paid" },
  { stage: "intake", label: "Intake" },
  { stage: "forensics", label: "Forensics" },
  { stage: "verdict", label: "Verdict" },
];

export function deriveEngineView(engagements: EngagementShape[], nowMs: number): EngineView {
  const dayAgo = nowMs - DAY;
  const weekAgo = nowMs - 7 * DAY;
  const stages: EngineStageStat[] = ACTIVE_STAGES.map(({ stage, label }) => {
    const rows = engagements.filter((e) => e.status === stage);
    const dwells = rows
      .map((e) => {
        const entered = stageEnteredAtMs(e, stage);
        return entered != null ? nowMs - entered : null;
      })
      .filter((d): d is number => d != null);
    const atRiskRows = rows.filter((e) => {
      const remaining = SLA.deliverableMs - (nowMs - e.paidAtMs);
      return remaining < SLA.deliverableWarnMs;
    });
    return {
      stage,
      label,
      count: rows.length,
      medianDwellMs: median(dwells),
      p90DwellMs: p90(dwells),
      maxDwellMs: dwells.length ? Math.max(...dwells) : null,
      atRisk: atRiskRows.length,
      atRiskDollars: atRiskRows.reduce((sum, e) => sum + e.amountUsd, 0),
    };
  });

  // Little's Law drain — completions read from the real stage-change trail
  // ("{Label} → next" events) over the trailing 7 days. A stage with no
  // completion on record has no measurable rate: the forecast reports null
  // rather than inventing throughput.
  const drain: EngineDrainStat[] = ACTIVE_STAGES.map(({ stage, label }) => {
    const depth = engagements.filter((e) => e.status === stage).length;
    const completions7d = engagements.flatMap((e) => e.events).filter(
      (ev) =>
        (ev.kind === "stage_changed" || ev.kind === "delivered") &&
        ev.detail?.startsWith(`${label} →`) &&
        ev.createdAtMs >= weekAgo,
    ).length;
    const drainPerHour = completions7d > 0 ? completions7d / (7 * 24) : null;
    return {
      stage,
      label,
      depth,
      completions7d,
      drainPerHour,
      timeToDrainMs: drainPerHour != null && drainPerHour > 0 ? Math.round((depth / drainPerHour) * HOUR) : null,
    };
  });

  const docs = engagements.flatMap((e) => e.documents ?? []);
  return {
    stages,
    drain,
    delivered24h: engagements.filter((e) => e.deliveredAtMs != null && e.deliveredAtMs >= dayAgo).length,
    docs24h: docs.filter((d) => d.createdAtMs >= dayAgo).length,
    parseFull: docs.filter((d) => d.extraction === "full_text").length,
    parsePartial: docs.filter((d) => d.extraction !== "full_text").length,
    activeDollars: engagements
      .filter((e) => e.status !== "sow" && e.status !== "closed")
      .reduce((sum, e) => sum + e.amountUsd, 0),
    guaranteeExposureDollars: engagements.filter((e) => e.status === "verdict" && e.guaranteeCleared == null).length
      ? LEAKAGE_MODEL.guaranteeFloorUsd
      : 0,
  };
}

// --------------------------------------------------------------------------- //
// Watch 6 — queue forecast: the promise priced against the drain rate
// --------------------------------------------------------------------------- //

/**
 * The SLA clock says how much promise an engagement has left. The drain rate
 * says how fast the stage actually clears. This watch joins them BEFORE the
 * breach: an engagement waiting behind others in a slow stage can be
 * projected out of time while its own clock still looks healthy.
 *
 * Math per active engagement: everyone ahead of it in its stage (same stage,
 * entered earlier) must clear first — wait = ahead / stage drain rate. When
 * wait > remaining deliverable promise, the queue outlasts the promise and
 * the forecast fires with the full arithmetic in the evidence line.
 *
 * Honest limits: no drain rate (no completions in 7d) → no forecast; nobody
 * ahead → the SLA clock already owns that case. Zero rows today; this watch
 * earns its keep the day the turnaround engine brings volume.
 */
export function deriveQueueForecastAlerts(engagements: EngagementShape[], nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];
  const drain = new Map<string, { drainPerHour: number; completions7d: number }>();
  for (const { stage, label } of ACTIVE_STAGES) {
    const completions7d = engagements.flatMap((e) => e.events).filter(
      (ev) =>
        (ev.kind === "stage_changed" || ev.kind === "delivered") &&
        ev.detail?.startsWith(`${label} →`) &&
        ev.createdAtMs >= nowMs - 7 * DAY,
    ).length;
    if (completions7d > 0) drain.set(stage, { drainPerHour: completions7d / (7 * 24), completions7d });
  }

  for (const e of engagements) {
    if (e.status === "sow" || e.status === "closed" || e.status === "delivered" || e.deliveredAtMs != null) continue;
    const rate = drain.get(e.status);
    if (!rate) continue;

    const entered = stageEnteredAtMs(e, e.status);
    const enteredMs =
      entered ?? (e.status === "paid" ? e.paidAtMs : null);
    if (enteredMs == null) continue;
    const ahead = engagements.filter((o) => {
      if (o.id === e.id || o.status !== e.status) return false;
      const oEntered = stageEnteredAtMs(o, o.status);
      return oEntered != null ? oEntered < enteredMs! : o.paidAtMs < e.paidAtMs;
    }).length;
    if (ahead === 0) continue;

    const waitMs = (ahead / rate.drainPerHour) * HOUR;
    const remaining = SLA.deliverableMs - (nowMs - e.paidAtMs);
    if (remaining >= waitMs) continue;

    const overrun = waitMs - remaining;
    out.push({
      key: alertKey("queue_forecast", e.id, nowMs),
      watchId: "queue_forecast",
      watch: "Queue forecast — drain vs promise",
      severity: overrun > 12 * HOUR ? "crit" : "warn",
      subjectKind: "engagement",
      subjectId: e.id,
      subjectLabel: e.clientName,
      title: `${e.clientName} waits behind ${ahead} in ${e.status} — the queue outlasts the promise`,
      action: "clear the queue ahead — parallelize or escalate the stage before the clock lands",
      evidence: `drain ${Math.round(rate.drainPerHour * 100) / 100}/h (n=${rate.completions7d} completions/7d) · ${ahead} ahead · wait ${humanDuration(waitMs)} · clock ${humanDuration(remaining)} · projected overrun ${humanDuration(overrun)}`,
      etaMs: Math.max(0, Math.round(remaining)),
      firedAtMs: nowMs,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Watch 7 — the watchtower watching itself (chronic watches)
// --------------------------------------------------------------------------- //

/** A watch live in this many distinct hours of the trailing 24 is chronic. */
export const FLAP_HOURS_24H = 12;

export interface FireCountRow {
  watchKey: string;
  fires24h: number;
}

/**
 * Flap alarms — the deck's own accuracy report. A watch row that has been
 * live for half a day or more is not alerting anymore; it is decoration the
 * operator has learned to skim past. This watch names it so the threshold
 * gets tuned instead of trusted. watch_flap never flags itself: a meta
 * watch that flags its own chronicness would chase its tail forever.
 */
export function deriveFlapAlerts(fireCounts: FireCountRow[], nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];
  for (const f of fireCounts) {
    if (f.fires24h < FLAP_HOURS_24H) continue;
    const [watchId, subjectId] = f.watchKey.split(":");
    if (watchId === "watch_flap") continue;
    const label = subjectId && subjectId !== "system" ? `${watchId} on ${subjectId.slice(0, 12)}` : watchId;
    out.push({
      key: alertKey("watch_flap", watchId, nowMs),
      watchId: "watch_flap",
      watch: "Watchtower self-audit — chronic watch",
      severity: "info",
      subjectKind: "system",
      subjectId: watchId,
      subjectLabel: label,
      title: `Watch "${label}" has been live ${f.fires24h} of the last 24 hours — chronic, not acute`,
      action: "tune the threshold or fix the cause — an alert the operator skims past is worse than silence",
      evidence: `live in ${f.fires24h}/24 distinct hourly sweeps · chronic past ${FLAP_HOURS_24H}/24`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Watch 8 — coverage: the money and pipeline surfaces nothing watched yet
// --------------------------------------------------------------------------- //

export interface CoverageInput {
  /** Active engagements (same shape as the engine view reads). */
  engagements: EngagementShape[];
  /** Prospects created in the trailing 7d / the 21d before that. */
  newLeads7d: number;
  newLeadsPrior21d: number;
}

/**
 * The recon sweep — surfaces the earlier watches never covered. Three rules,
 * each priced in real rows:
 *   · guarantee exposure  undecided verdicts each sit on the $10,000
 *                         recovery promise; two or more undecided is a
 *                         liability the balance sheet cannot hide.
 *   · deliverable missing delivered engagements whose artifact link is null
 *                         — the promise was kept but the money room points
 *                         at nothing.
 *   · lead drought        no new prospects for a week when the book's own
 *                         28-day rhythm says there should have been —
 *                         pipeline starvation is visible weeks ahead.
 */
export function deriveCoverageAlerts(input: CoverageInput, nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];

  const undecided = input.engagements.filter(
    (e) => e.status === "verdict" && e.guaranteeCleared == null,
  );
  const exposure = undecided.length * LEAKAGE_MODEL.guaranteeFloorUsd;
  if (undecided.length >= 2) {
    out.push({
      key: alertKey("guarantee_exposure", null, nowMs),
      watchId: "guarantee_exposure",
      watch: "Guarantee exposure",
      severity: "warn",
      subjectKind: "system",
      subjectId: null,
      subjectLabel: "verdict stage",
      title: `Guarantee exposure at ${usdFloor(exposure)} — ${undecided.length} verdicts undecided`,
      action: "record the verdicts — every undecided clock sits on the $10,000 promise",
      evidence: `${undecided.length} undecided × ${usdFloor(LEAKAGE_MODEL.guaranteeFloorUsd)} floor = ${usdFloor(exposure)} exposure`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  }

  for (const e of input.engagements) {
    const terminal = e.status === "delivered" || e.status === "sow" || e.status === "closed";
    if (!terminal || e.deliveredAtMs == null || e.deliverableUrl) continue;
    out.push({
      key: alertKey("deliverable_missing", e.id, nowMs),
      watchId: "deliverable_missing",
      watch: "Deliverable liveness",
      severity: "warn",
      subjectKind: "engagement",
      subjectId: e.id,
      subjectLabel: e.clientName,
      title: `${e.clientName} was delivered but the artifact link is empty`,
      action: "seal the deliverable — the close ledger links to it and the client was promised the readout",
      evidence: `delivered ${humanDuration(Math.max(0, nowMs - e.deliveredAtMs))} ago · deliverableUrl null`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  }

  const weeksPrior = 3; // the 21d comparison window
  const priorPerWeek = input.newLeadsPrior21d / weeksPrior;
  if (input.newLeads7d === 0 && priorPerWeek >= 1) {
    out.push({
      key: alertKey("lead_drought", null, nowMs),
      watchId: "lead_drought",
      watch: "Pipeline drought",
      severity: "info",
      subjectKind: "funnel",
      subjectId: null,
      subjectLabel: "channel A+B",
      title: "No new prospects in 7 days — the pipeline has gone dry",
      action: "run a territory sweep — starvation now is an empty desk next month",
      evidence: `0 new in 7d · prior 3 weeks averaged ${Math.round(priorPerWeek * 10) / 10}/wk`,
      etaMs: null,
      firedAtMs: nowMs,
    });
  }

  return out;
}

const usdFloor = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

// --------------------------------------------------------------------------- //
// Escalation — crit unacked too long stops whispering
// --------------------------------------------------------------------------- //

/** A crit alarm unacked this long is escalated on the deck. */
export const ESCALATE_AFTER_MS = 15 * 60_000;

/**
 * The escalation ladder, in-app layer: a crit row that has been live for 15
 * minutes without an ack stops being a quiet line and names itself. The
 * pager layer rides the same signal (see the route) and delivers honestly —
 * attempted only when a channel is configured, never faked.
 */
export function escalateDeck(
  deck: OpsWatchAlert[],
  firstSeenByKey: Map<string, number | null>,
  nowMs: number,
): OpsWatchAlert[] {
  return deck.map((a) => {
    if (a.severity !== "crit") return a;
    const firstSeen = firstSeenByKey.get(`${a.watchId}:${a.subjectId ?? "system"}`);
    if (firstSeen == null) return a;
    const unackedMs = nowMs - firstSeen;
    if (unackedMs < ESCALATE_AFTER_MS) return a;
    return { ...a, escalated: { unackedMs } };
  });
}

export function deriveVitals(input: {
  snapshotBuildMs: number;
  baselineAgeMs: number | null;
  outboxPending: number;
  deckSize: number;
}): OpsVital[] {
  const vitals: OpsVital[] = [
    {
      id: "snapshot",
      label: "snapshot build",
      value: `${input.snapshotBuildMs}ms`,
      beat: true,
      ageMs: null,
      detail: "measured per build — queries + derivation",
    },
    {
      id: "baseline",
      label: "kpi baseline",
      value: input.baselineAgeMs != null ? `${humanDuration(input.baselineAgeMs)} old` : "no captures",
      beat: input.baselineAgeMs != null && input.baselineAgeMs < BASELINE_STALE_MS,
      ageMs: input.baselineAgeMs,
      detail: "hourly capture · feeds radar deltas and the sentinels",
    },
    {
      id: "outbox",
      label: "outbox",
      value: `${input.outboxPending} pending`,
      beat: input.outboxPending < THRESHOLDS.outboxCrit,
      ageMs: null,
      detail: "publish pipeline backlog",
    },
    {
      id: "deck",
      label: "watchtower",
      value: `${input.deckSize} live`,
      beat: true,
      ageMs: null,
      detail: "unacknowledged watches on the deck",
    },
  ];
  return vitals;
}
