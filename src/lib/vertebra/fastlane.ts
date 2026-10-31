/**
 * The fast-lane — the sequence engine's intake. The one missing rung
 * between "prospect qualified" and "Email 1 out".
 *
 * Every sequence tick, the lane scans the Book for prospects that crossed
 * the line and queues their opener itself — no operator click, no per-
 * prospect ceremony. It ONLY queues: the mailer's interlocks (warmup caps,
 * suppression, unsubscribe signing, the egress arm) re-gate every send
 * regardless of who queued the row, so the lane cannot outrun the physics.
 *
 * The admission rule is deterministic and veto-first:
 *   · latest QLV score >= CHANNEL_A_MIN_SCORE (70)
 *   · a verified bestEmail on the prospect
 *   · no Channel A dispatch yet (idempotent by construction)
 *   · not suppressed (the one suppression definition, from the mailer)
 *   · no `vetoed` OperatorAction — the operator's always-win card; veto is
 *     permanent until an operator removes the row, by design
 *   · ingestion not filtered/failed
 * and caps admissions per scan (best score first) with 0–90 s send jitter
 * so volume spreads across ticks instead of bursting.
 *
 * Arming is always an operator act: VERTEBRA_FASTLANE=on. Disarmed, the
 * lane is fully silent — no rows, no pulses, zero behavior change.
 *
 * Concurrency: the scan CLAIMS its 90 s window first (UNIQUE engineId+
 * pulseRef on the EnginePulse ledger). A second trigger — operator button,
 * cron door, in-process heartbeat — arriving in the same window absorbs
 * and exits; the first scan owns the admissions. Cross-process honest.
 *
 * Every scan pulses its story (admitted, cap, every refusal by reason) so
 * the ops deck sees WHY each prospect was admitted or left behind.
 * Failure-isolated: the scan never throws into the tick.
 */
import { db } from "@/lib/db";
import { isSuppressed } from "@/lib/vertebra/mailer";
import { CHANNEL_A_MIN_SCORE } from "@/lib/vertebra/scoring";
import { writeEnginePulse } from "@/lib/vertebra/pulse";

export const FASTLANE_ENGINE_ID = "fastlane";
export const FASTLANE_WATCH_ID = "fastlane_scan";
/** Claim window — matches the sequence heartbeat cadence (90 s). */
export const FASTLANE_SCAN_BUCKET_MS = 90_000;
/** Stampede guard only — real volume is capped by the warmup ledger. */
export const FASTLANE_LANE_CAP = 5;
/** Send jitter ceiling — spreads admissions across ticks. */
export const FASTLANE_JITTER_MS = 90_000;
/** Candidate pool read per scan (oldest first — nobody waits forever). */
const POOL_TAKE = 40;

export function fastlaneArmed(): boolean {
  return process.env.VERTEBRA_FASTLANE === "on";
}

export interface FastlaneRefusal {
  prospectId: string;
  name: string;
  reason: string;
}

export interface FastlaneOutcome {
  armed: boolean;
  /** true when another trigger already owns this 90 s window. */
  claimDeduped: boolean;
  scanned: number;
  admitted: number;
  admissions: FastlaneAdmission[];
  refusals: FastlaneRefusal[];
  error?: string;
}

export interface FastlaneAdmission {
  prospectId: string;
  name: string;
  dispatchId: string;
  scheduledAt: Date;
}

function refusalSummary(refusals: FastlaneRefusal[], limit = 6): string {
  const counts = new Map<string, number>();
  for (const r of refusals) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts.entries()]
    .slice(0, limit)
    .map(([reason, n]) => `${reason}(${n})`)
    .join(" · ");
}

/**
 * The scan. Call from the sequence tick (every trigger inherits it) or
 * standalone. `now` is injectable so tests can pin claim buckets.
 */
export async function runFastlaneScan(now: Date = new Date()): Promise<FastlaneOutcome> {
  const outcome: FastlaneOutcome = { armed: fastlaneArmed(), claimDeduped: false, scanned: 0, admitted: 0, admissions: [], refusals: [] };
  if (!outcome.armed) return outcome; // disarmed = silent: no rows, no pulses, no behavior

  // 1. Claim the 90 s window — a second trigger in the same window absorbs.
  const bucket = Math.floor(now.getTime() / FASTLANE_SCAN_BUCKET_MS);
  try {
    const claim = await writeEnginePulse({
      engineId: FASTLANE_ENGINE_ID,
      pulseRef: `scan:${bucket}`,
      watchId: FASTLANE_WATCH_ID,
      status: "ok",
      detail: `scan claim · window ${bucket}`,
    });
    if (claim.deduped) {
      outcome.claimDeduped = true;
      return outcome;
    }
  } catch {
    // A failed claim pulse must not wedge the lane — proceed, best-effort.
  }

  try {
    // 2. Candidate pool: verified email, never filtered, no Channel A
    //    dispatch yet, some score history. Refinement happens in-memory
    //    where every refusal can be NAMED.
    const pool = await db.prospect.findMany({
      where: {
        bestEmail: { not: null },
        ingestion: { not: { in: ["filtered", "failed"] } },
        dispatches: { none: { channel: "channel_a_automated_email" } },
        scores: { some: { id: { not: "" } } },
      },
      orderBy: { createdAt: "asc" },
      take: POOL_TAKE,
      select: {
        id: true,
        name: true,
        bestEmail: true,
        caslScope: true,
        scores: { orderBy: { createdAt: "desc" }, take: 1, select: { qlvScore: true } },
      },
    });
    outcome.scanned = pool.length;

    // 3. The rule, veto-first, every exit named.
    const admissible: Array<{ id: string; name: string; qlvScore: number; caslScope: boolean; email: string }> = [];
    for (const p of pool) {
      const qlv = p.scores[0]?.qlvScore ?? -1;
      if (qlv < CHANNEL_A_MIN_SCORE) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "below_channel_a_bar" });
        continue;
      }
      const email = p.bestEmail as string;
      if (await isSuppressed(email, p.id)) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "suppressed" });
        continue;
      }
      const veto = await db.operatorAction.findFirst({ where: { prospectId: p.id, action: "vetoed" }, select: { id: true } });
      if (veto) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "vetoed_by_operator" });
        continue;
      }
      admissible.push({ id: p.id, name: p.name, qlvScore: qlv, caslScope: p.caslScope, email });
    }

    // 4. Best score first, cap the lane, jitter the send across ticks.
    admissible.sort((a, b) => b.qlvScore - a.qlvScore);
    const lane = admissible.slice(0, FASTLANE_LANE_CAP);
    for (const o of admissible.slice(FASTLANE_LANE_CAP)) {
      outcome.refusals.push({ prospectId: o.id, name: o.name, reason: "lane_cap" });
    }

    for (const a of lane) {
      const scheduledAt = new Date(now.getTime() + Math.floor(Math.random() * FASTLANE_JITTER_MS));
      const dispatch = await db.dispatch.create({
        data: {
          prospectId: a.id,
          channel: "channel_a_automated_email",
          status: "queued",
          caslScope: a.caslScope,
          // subject/body stay null — the tick composes from the evidence
          // hooks (the exact path it always sends from), never new wording.
          scheduledAt,
        },
        select: { id: true },
      });
      outcome.admissions.push({ prospectId: a.id, name: a.name, dispatchId: dispatch.id, scheduledAt });
    }
    outcome.admitted = outcome.admissions.length;

    // 5. The scan's story — honest counts, named refusals, ≤400 chars.
    const admittedNames = lane
      .map((a) => a.name)
      .slice(0, 3)
      .join(", ");
    const detail = `armed · scanned ${outcome.scanned} · admitted ${outcome.admitted}/${FASTLANE_LANE_CAP}${admittedNames ? ` · ${admittedNames}` : ""}${
      outcome.refusals.length > 0 ? ` · refused: ${refusalSummary(outcome.refusals)}` : ""
    }`;
    await writeEnginePulse({
      engineId: FASTLANE_ENGINE_ID,
      pulseRef: `result:${bucket}`,
      watchId: FASTLANE_WATCH_ID,
      status: "ok",
      detail: detail.slice(0, 400),
    }).catch(() => undefined);
    return outcome;
  } catch (error) {
    outcome.error = `scan_failed: ${String(error).slice(0, 200)}`;
    await writeEnginePulse({
      engineId: FASTLANE_ENGINE_ID,
      pulseRef: `error:${bucket}`,
      watchId: FASTLANE_WATCH_ID,
      status: "fail",
      detail: outcome.error,
      expectEveryMs: FASTLANE_SCAN_BUCKET_MS,
    }).catch(() => undefined);
    return outcome;
  }
}
