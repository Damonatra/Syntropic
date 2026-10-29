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
 *   · trend sentinels — least-squares slope + z-score over the hourly
 *                       CommandBaseline history; a metric rising 2σ above its
 *                       24h window with positive slope fires WARN with an ETA
 *                       to threshold; crossing the threshold fires CRIT.
 *
 * The watchtower never fires an alarm it cannot show the math for: every
 * alert carries an evidence line, and predictive alerts carry etaMs.
 *
 * Acks are keyed `${watchId}:${subjectId ?? "system"}:${windowBucket}` —
 * suppression lasts one window (6h); a condition that clears and refires
 * later returns as a fresh key. Never nagged twice in a window, never
 * silenced forever.
 */

import type {
  EngagementShape,
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
 * value sits ≥ 2σ above the window mean with positive slope, and ≥ floor.
 * Evidence carries the full math: μ, σ, latest, slope, and the ETA to the
 * hard threshold at the current rate. Crossing the threshold promotes to CRIT.
 */
export function deriveBaselineSentinels(rows: BaselineRow[], nowMs: number): OpsWatchAlert[] {
  const out: OpsWatchAlert[] = [];
  const cutoff = nowMs - DAY;
  const recent = rows.filter((r) => r.capturedAtMs >= cutoff);
  if (recent.length < 4) return out;

  for (const spec of SENTINELS) {
    const pts = recent
      .map((r) => ({ t: r.capturedAtMs, v: r.metrics[spec.metric] }))
      .filter((p): p is { t: number; v: number } => typeof p.v === "number");
    if (pts.length < 4) continue;

    const values = pts.map((p) => p.v);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const sigma = Math.sqrt(variance);
    if (sigma <= 0) continue;

    const latest = values[values.length - 1];
    if (latest < Math.max(spec.floor, mean + 2 * sigma)) continue;

    // Least-squares slope in units/hour over the window.
    const t0 = pts[0].t;
    const xs = pts.map((p) => (p.t - t0) / HOUR);
    const ys = values;
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = mean;
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
      evidence: `n=${n} captures/24h · μ=${Math.round(mean * 10) / 10} σ=${Math.round(sigma * 10) / 10} · latest=${latest} z=${Math.round(z * 10) / 10}σ · slope=+${Math.round(slope * 100) / 100}/h`,
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
      maxDwellMs: dwells.length ? Math.max(...dwells) : null,
      atRisk: atRiskRows.length,
      atRiskDollars: atRiskRows.reduce((sum, e) => sum + e.amountUsd, 0),
    };
  });

  const docs = engagements.flatMap((e) => e.documents ?? []);
  return {
    stages,
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
// Vitals — measured heartbeats for the strip
// --------------------------------------------------------------------------- //

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
