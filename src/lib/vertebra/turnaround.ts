/**
 * Turnaround engine — pure decision logic, the machine half of the stage
 * machine.
 *
 * Why this module exists: the desk moves engagements by hand today. The
 * turnaround engine closes the loop — every stage move the machine is
 * *entitled* to make happens on the tick, every commitment the contract
 * sold stays human. The boundary, in one table:
 *
 *   paid → intake          machine  (contacts + quote volume on the ledger)
 *   intake → forensics     machine  (quote volume confirmed)
 *   forensics → verdict    machine  (documents sealed; model output on the
 *                                    ledger — the operator inherits a ready
 *                                    verdict instead of a blank form)
 *   the $10k guarantee     HUMAN    (a commercial call, never modeled)
 *   deliverable render     machine  (once the verdict exists, the artifact
 *                                    builds itself from real rows)
 *   verdict → delivered    HUMAN    (release — the artifact leaves the
 *                                    building only by operator hand)
 *
 * Doctrine this module obeys:
 *   · mirror the desk  — every gate reads the same fields nextActionFor does;
 *     the engine and the desk can never disagree about readiness.
 *   · honest details   — stage-move details lead with `${Label} → ${to}` in
 *     the PATCH route's exact format; the Little's Law drain reader and the
 *     stage-entry reader parse that trail, so the engine's work is counted
 *     by the watchtower without the watchtower knowing the engine exists.
 *   · no invention     — a gate without its data produces no action; the
 *     pulse reports "nothing due" rather than pretending.
 *
 * Pure logic only: no DB, no React, no fetch. The tick executor lives in
 * tick.ts; the vitest suite hammers the gates here.
 */

import { engagementLeakage, LEAKAGE_MODEL } from "./leakage";
import { SLA } from "./watches";

// --------------------------------------------------------------------------- //
// Engine identity — what the heartbeat contract sees
// --------------------------------------------------------------------------- //

/** The engineId every turnaround pulse carries. */
export const TURNAROUND_ENGINE_ID = "turnaround-core";

/** Declared cadence — the silence watch fires past max(3× this, 10 minutes). */
export const TURNAROUND_CADENCE_MS = 5 * 60_000;

/** The watches this engine reports on, one pulse each per tick. */
export const TURNAROUND_WATCHES = ["stage_advance", "deliverable_render", "sla_guard"] as const;

/**
 * Pulse refs are unique per beat: two ticks inside one minute are two
 * distinct stories (the scheduler said "nothing due", the operator's RUN
 * TICK advanced three stages — both belong on the deck). A shared bucket
 * would let the contract's dedup swallow the second beat's work report,
 * which is exactly the dishonesty the watchtower exists to prevent.
 *
 * The (engineId, pulseRef) UNIQUE pair keeps its role as the retry shield
 * for engines arriving through the signed HTTP door; the in-process tick
 * never retries a beat — it re-reports the world on the next tick.
 */
export function pulseRef(watchId: string, nowMs: number): string {
  const salt = Math.random().toString(36).slice(2, 7);
  return `${watchId}:${nowMs.toString(36)}-${salt}`;
}

// --------------------------------------------------------------------------- //
// Input shape — exactly what the tick executor reads from the DB
// --------------------------------------------------------------------------- //

export interface TurnaroundRow {
  id: string;
  ref: string;
  status: string; // the active stage — paid | intake | forensics | verdict
  contactName: string | null;
  contactEmail: string | null;
  intakeRfqPerMonth: number | null;
  intakeLineItems: number | null;
  guaranteeCleared: boolean | null;
  confirmedLeakageUsd: number | null;
  deliverableUrl: string | null;
  paidAtMs: number;
  /** Legacy documents sealed to this engagement (any extraction depth). */
  docCount: number;
  /** When the engagement entered `verdict`, from the ledger trail. Null = unprovable. */
  verdictEnteredAtMs: number | null;
}

// --------------------------------------------------------------------------- //
// The plan — what the machine is entitled to do this tick
// --------------------------------------------------------------------------- //

export type TurnaroundActionKind = "advance_stage" | "render_deliverable";

export interface TurnaroundAction {
  engagementId: string;
  ref: string;
  kind: TurnaroundActionKind;
  /** Target stage for advance_stage actions — always a legal adjacent move. */
  to?: "intake" | "forensics" | "verdict";
  /**
   * Ledger detail. Stage moves MUST lead with `${Label} → ${to}` — the
   * drain reader and stage-entry reader parse that trail verbatim.
   */
  detail: string;
  /** The honest gate that passed — one clause, rendered in tests and pulses. */
  gate: string;
}

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

const hasVolume = (r: TurnaroundRow): boolean => r.intakeRfqPerMonth != null && r.intakeLineItems != null;

/**
 * The gate for one row, or null when the machine has no entitlement. The
 * gates mirror nextActionFor's data reads field-for-field: wherever the desk
 * says "record volume", the engine demands volume on the ledger first.
 */
function actionFor(r: TurnaroundRow): TurnaroundAction | null {
  switch (r.status) {
    case "paid": {
      if (!(r.contactName && r.contactEmail && hasVolume(r))) return null;
      return {
        engagementId: r.id,
        ref: r.ref,
        kind: "advance_stage",
        to: "intake",
        detail: `Paid → intake · engine advance — contacts and quote volume on the ledger (${r.intakeRfqPerMonth} RFQ/mo · ${r.intakeLineItems} lines)`,
        gate: "contacts + quote volume on the ledger",
      };
    }
    case "intake": {
      if (!hasVolume(r)) return null;
      return {
        engagementId: r.id,
        ref: r.ref,
        kind: "advance_stage",
        to: "forensics",
        detail: `Intake → forensics · engine advance — quote volume confirmed (${r.intakeRfqPerMonth} RFQ/mo · ${r.intakeLineItems} lines)`,
        gate: "quote volume confirmed",
      };
    }
    case "forensics": {
      // Forensics with zero sealed documents is the operator's work still
      // pending ("drop the first legacy document") — the engine waits.
      if (r.docCount === 0 || !hasVolume(r)) return null;
      const m = engagementLeakage(r.intakeRfqPerMonth!, r.intakeLineItems!);
      return {
        engagementId: r.id,
        ref: r.ref,
        kind: "advance_stage",
        to: "verdict",
        detail:
          `Forensics → verdict · engine modeled ${LEAKAGE_MODEL.version} — annual ${usd(m.annual)} ` +
          `(band ${usd(m.low)}–${usd(m.high)}) · recoverable ${usd(m.recoverable)} yr-one`,
        gate: "documents sealed + leakage model derivable",
      };
    }
    case "verdict": {
      // The guarantee decision is human. Once it is on the ledger, rendering
      // the artifact is mechanical — the release stays with the operator.
      if (r.guaranteeCleared == null || r.confirmedLeakageUsd == null) return null;
      if (r.deliverableUrl != null) return null; // rendered; awaiting release
      return {
        engagementId: r.id,
        ref: r.ref,
        kind: "render_deliverable",
        detail:
          `verdict recorded ${usd(r.confirmedLeakageUsd)} · guarantee ${r.guaranteeCleared ? "CLEARED" : "NOT CLEARED"} — rendering the artifact for release`,
        gate: "verdict on the ledger — artifact renders, release stays human",
      };
    }
    default:
      return null; // delivered | sow | closed — the machine is done here
  }
}

/**
 * The tick's work order: actions for every engagement the machine is
 * entitled to move, oldest money first — the queue drains FIFO.
 */
export function planTurnaround(rows: TurnaroundRow[], nowMs: number): TurnaroundAction[] {
  void nowMs; // clock lives in the guard, not the plan — kept for signature symmetry
  return (
    [...rows]
      .sort((a, b) => a.paidAtMs - b.paidAtMs)
      .map(actionFor)
      .filter((a): a is TurnaroundAction => a != null)
  );
}

// --------------------------------------------------------------------------- //
// SLA guard — the engine's own clock read, spoken in the pulse
// --------------------------------------------------------------------------- //

export interface SlaGuardRead {
  status: "ok" | "warn";
  /** ≤ 400 chars — the EnginePulse detail column's contract. */
  detail: string;
}

/**
 * The same SLA math the watchtower's clocks run — deliverable inside 5d of
 * payment, verdict inside 3d of entry — read by the engine after the tick.
 * The pulse reports the nearest breach and anything inside its warn window;
 * unprovable verdict entry degrades to the deliverable clock alone.
 */
export function slaGuard(rows: TurnaroundRow[], nowMs: number): SlaGuardRead {
  let deliverableWarn = 0;
  let verdictWarn = 0;
  let nearestMs: number | null = null;
  let awaitingRelease = 0;

  for (const r of rows) {
    const dRemaining = SLA.deliverableMs - (nowMs - r.paidAtMs);
    if (dRemaining > 0 && dRemaining < SLA.deliverableWarnMs) {
      deliverableWarn += 1;
      if (nearestMs == null || dRemaining < nearestMs) nearestMs = dRemaining;
    }
    if (r.status === "verdict") {
      if (r.guaranteeCleared == null && r.verdictEnteredAtMs != null) {
        const vRemaining = SLA.verdictMs - (nowMs - r.verdictEnteredAtMs);
        if (vRemaining > 0 && vRemaining < SLA.verdictWarnMs) {
          verdictWarn += 1;
          if (nearestMs == null || vRemaining < nearestMs) nearestMs = vRemaining;
        }
      }
      if (r.guaranteeCleared != null && r.deliverableUrl != null) awaitingRelease += 1;
    }
  }

  const parts: string[] = [];
  const warn = deliverableWarn + verdictWarn > 0;
  parts.push(warn ? "warn" : "clocks comfortable");
  if (deliverableWarn > 0) parts.push(`${deliverableWarn} inside deliverable warn window`);
  if (verdictWarn > 0) parts.push(`${verdictWarn} inside verdict warn window`);
  if (nearestMs != null) parts.push(`nearest breach in ${humanHours(nearestMs)}`);
  if (awaitingRelease > 0) parts.push(`${awaitingRelease} awaiting release`);
  return { status: warn ? "warn" : "ok", detail: parts.join(" · ") };
}

/** Hours-and-days humanization for pulse details — coarse on purpose. */
function humanHours(ms: number): string {
  const h = Math.max(1, Math.round(ms / 3_600_000));
  return h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`;
}
