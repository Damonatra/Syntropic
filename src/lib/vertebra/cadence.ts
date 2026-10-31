/**
 * The cadence engine — autonomous follow-ups for Channel A.
 *
 * The fast-lane fires Email 1; the cadence fires the two after it. When a
 * prospect's last touch has sat unanswered for its step's wait window, the
 * scan queues the next step itself — same tick, same mailer interlocks,
 * same evidence the opener rode on. No operator click, no new entry point,
 * no AI improvisation in the wire: the follow-up texts are deterministic
 * templates in Josias's voice, and the mailer re-gates every send exactly
 * as it does for openers (warmup caps, suppression, unsubscribe signing,
 * the egress arm).
 *
 * The rhythm (operator decision, 2026-10-31): three touches over twelve
 * days — Day 0 opener → Day 3 follow-up → Day 8 close. Each step anchors
 * to the previous touch's ACTUAL send time, not the plan: a deferred or
 * backoff-delayed step pushes the next one honestly.
 *
 * The doors that end a sequence, every one named in the scan's story:
 *   · any reply hands the conversation to tiered autonomy — no machine
 *     follow-up lands behind a human conversation (replies.ts owns it:
 *     not_interested stops, live intents page and park drafts). The one
 *     exception is an out-of-office: the next step re-anchors to the
 *     return date (7 days out when none was stated), matching the OOO
 *     semantics the reply brain already applies to queued dispatches.
 *   · a vetoed OperatorAction refuses the step first — the operator's
 *     always-win card, checked before money or noise.
 *   · the suppression ledger refuses — unsubscribed, bounced, complained.
 *   · a last touch without a provider message id refuses — same-thread
 *     continuity (In-Reply-To) is the promise; without the id there is no
 *     thread to continue, and a fresh-thread cold email is not ours to send.
 *   · the newest Channel A dispatch not being a live touch (stopped by
 *     reply, failed send) means the sequence is already over.
 *
 * Concurrency and honesty: the scan CLAIMS its 90 s window first (UNIQUE
 * engineId+pulseRef) — operator button, cron door, in-process heartbeat
 * all absorb into one scan. Cap per scan is a stampede guard only; real
 * volume is the warmup ledger's job. Failure-isolated: never throws into
 * the tick.
 *
 * Arming: the same switch as the fast-lane — VERTEBRA_FASTLANE=on. There
 * is one armed posture for the whole outreach engine, not one per lane.
 * Disarmed, the scan is fully silent.
 */
import { db } from "@/lib/db";
import { isSuppressed } from "@/lib/vertebra/mailer";
import { writeEnginePulse } from "@/lib/vertebra/pulse";
import { fastlaneArmed } from "@/lib/vertebra/fastlane";
import { landingUrlFor } from "@/lib/vertebra/track";

export const CADENCE_ENGINE_ID = "cadence";
export const CADENCE_WATCH_ID = "cadence_scan";
/** Claim window — matches the sequence heartbeat cadence (90 s). */
export const CADENCE_SCAN_BUCKET_MS = 90_000;
/** Stampede guard only — real volume is capped by the warmup ledger. */
export const CADENCE_LANE_CAP = 5;
/** Send jitter for overdue steps — spreads admissions across ticks. */
export const CADENCE_JITTER_MS = 90_000;
/** The rhythm: step N waits this many days after the previous touch. */
export const CADENCE_STEP_WAIT_DAYS: Record<number, number> = { 2: 3, 3: 5 };
export const CADENCE_MAX_STEP = 3;
/** Day-scale fallback for an out-of-office without a stated return date. */
const OOO_DEFAULT_PUSH_DAYS = 7;
/** Candidate pool read per scan (oldest first — nobody waits forever). */
const POOL_TAKE = 40;

const DAY_MS = 86_400_000;
/** A dispatch status that counts as a delivered touch. */
const TOUCH_STATUSES = ["sent", "delivered", "opened", "clicked", "replied"];

export interface CadenceRefusal {
  prospectId: string;
  name: string;
  reason: string;
}

export interface CadenceAdmission {
  prospectId: string;
  name: string;
  dispatchId: string;
  step: number;
  scheduledAt: Date;
  /** Named context for the admission — "ooo_deferred" when a reply moved it. */
  note?: string;
}

export interface CadenceOutcome {
  armed: boolean;
  /** true when another trigger already owns this 90 s window. */
  claimDeduped: boolean;
  scanned: number;
  admitted: number;
  admissions: CadenceAdmission[];
  refusals: CadenceRefusal[];
  error?: string;
}

function refusalSummary(refusals: CadenceRefusal[], limit = 6): string {
  const counts = new Map<string, number>();
  for (const r of refusals) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts.entries()]
    .slice(0, limit)
    .map(([reason, n]) => `${reason}(${n})`)
    .join(" · ");
}

function parseReturnDate(extractedJson: string | null): Date | null {
  if (!extractedJson) return null;
  try {
    const parsed = JSON.parse(extractedJson) as { return_date?: string | null };
    if (!parsed.return_date) return null;
    const d = new Date(parsed.return_date);
    return Number.isNaN(d.valueOf()) ? null : d;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// The follow-up texts — deterministic, step-specific, Josias's voice. The
// mailer owns the CASL footer and the display signature; these bodies never
// duplicate either.
// --------------------------------------------------------------------------- //

export interface FollowupContext {
  contactFirst: string;
  company: string;
  hookBody: string | null;
  /** the tracked landing link — one line, same door the opener carries */
  landingUrl?: string | null;
}

export function composeFollowup(step: number, ctx: FollowupContext): { subject: string | null; body: string } {
  const first = ctx.contactFirst || "there";
  const hook = ctx.hookBody
    ? ctx.hookBody.length > 140
      ? `${ctx.hookBody.slice(0, 137)}…`
      : ctx.hookBody
    : null;
  if (step === 2) {
    return {
      subject: null, // the tick threads "Re: <opener subject>" from the ledger
      body: `${first} — one follow-up, then quiet.${hook ? ` The short version is still: ${hook}` : ""} If that's worth 15 minutes this week, reply with a time.${ctx.landingUrl ? ` The one-page math: ${ctx.landingUrl}.` : ""} If not, one word back and I'll close the file. — Josias`,
    };
  }
  return {
    subject: null,
    body: `${first} — last note from me on this, and I'll leave you in peace. Your quote desk's math hasn't changed since the first note${hook ? `: ${hook}` : ""}.${ctx.landingUrl ? ` The one-page math: ${ctx.landingUrl}.` : ""} If the timing is ever right, reply with a time and I'll work around your team. — Josias`,
  };
}

/** The thread subject: the opener's subject with the reply marker. */
export function threadSubject(openerSubject: string | null, company: string): string {
  const base = openerSubject ?? `${company}: quoting benchmark`;
  return base.toLowerCase().startsWith("re:") ? base : `Re: ${base}`;
}

/**
 * The scan. Call from the sequence tick (every trigger inherits it) or
 * standalone. `now` is injectable so tests can pin claim buckets.
 */
export async function runCadenceScan(now: Date = new Date()): Promise<CadenceOutcome> {
  const outcome: CadenceOutcome = { armed: fastlaneArmed(), claimDeduped: false, scanned: 0, admitted: 0, admissions: [], refusals: [] };
  if (!outcome.armed) return outcome; // disarmed = silent: no rows, no pulses, no behavior

  // 1. Claim the 90 s window — a second trigger in the same window absorbs.
  const bucket = Math.floor(now.getTime() / CADENCE_SCAN_BUCKET_MS);
  try {
    const claim = await writeEnginePulse({
      engineId: CADENCE_ENGINE_ID,
      pulseRef: `scan:${bucket}`,
      watchId: CADENCE_WATCH_ID,
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
    // 2. Candidate pool: prospects with Channel A history and NOTHING queued
    //    — the pending-send case belongs to the tick, not to intake.
    //    Refinement happens in-memory where every refusal can be NAMED.
    const pool = await db.prospect.findMany({
      where: {
        bestEmail: { not: null },
        ingestion: { not: { in: ["filtered", "failed"] } },
        dispatches: {
          some: { channel: "channel_a_automated_email" },
          none: { channel: "channel_a_automated_email", status: "queued" },
        },
      },
      orderBy: { createdAt: "asc" },
      take: POOL_TAKE,
      select: {
        id: true,
        name: true,
        bestEmail: true,
        caslScope: true,
        dispatches: {
          where: { channel: "channel_a_automated_email" },
          orderBy: { updatedAt: "desc" },
          select: { id: true, step: true, status: true, subject: true, providerMsgId: true, updatedAt: true },
        },
        scores: { orderBy: { createdAt: "desc" }, take: 1, select: { hooksJson: true } },
        contacts: { take: 1, select: { firstName: true } },
        inboundReplies: { orderBy: { receivedAt: "desc" }, take: 1, select: { id: true, intent: true, receivedAt: true, extractedJson: true } },
      },
    });
    outcome.scanned = pool.length;

    // 3. The rule — veto first, every exit named.
    const due: Array<{
      prospectId: string;
      name: string;
      email: string;
      caslScope: boolean;
      step: number;
      dueAt: Date;
      openerSubject: string | null;
      hookBody: string | null;
      contactFirst: string;
      oooAnchor: Date | null;
    }> = [];
    for (const p of pool) {
      const lastTouch = p.dispatches.find((d) => TOUCH_STATUSES.includes(d.status));
      const newest = p.dispatches[0];
      if (!lastTouch || (newest && newest.id !== lastTouch.id)) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "last_touch_not_live" });
        continue;
      }
      if (lastTouch.step >= CADENCE_MAX_STEP) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "sequence_complete" });
        continue;
      }
      const veto = await db.operatorAction.findFirst({ where: { prospectId: p.id, action: "vetoed" }, select: { id: true } });
      if (veto) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "vetoed_by_operator" });
        continue;
      }
      if (await isSuppressed(p.bestEmail, p.id)) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "suppressed" });
        continue;
      }
      const nextStep = lastTouch.step + 1;
      const dueAt = new Date(lastTouch.updatedAt.getTime() + (CADENCE_STEP_WAIT_DAYS[nextStep] ?? 3) * DAY_MS);

      // The reply door — a conversation is live the moment anything lands.
      let oooAnchor: Date | null = null;
      const reply = p.inboundReplies[0];
      if (reply && reply.receivedAt.getTime() > lastTouch.updatedAt.getTime()) {
        if (reply.intent === "out_of_office") {
          const stated = parseReturnDate(reply.extractedJson);
          oooAnchor = stated ?? new Date(now.getTime() + OOO_DEFAULT_PUSH_DAYS * DAY_MS);
        } else {
          outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "reply_landed_conversation_live" });
          continue;
        }
      }

      // The thread door — same-thread is the promise; no id, no follow-up.
      if (!lastTouch.providerMsgId) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "thread_broken_no_msgid" });
        continue;
      }

      if (now.getTime() < dueAt.getTime() && !oooAnchor) {
        outcome.refusals.push({ prospectId: p.id, name: p.name, reason: "not_due_yet" });
        continue;
      }

      const hookBody = (() => {
        try {
          const hooks = p.scores[0] ? (JSON.parse(p.scores[0].hooksJson) as Array<{ body: string }>) : [];
          return hooks[0]?.body ?? null;
        } catch {
          return null;
        }
      })();
      due.push({
        prospectId: p.id,
        name: p.name,
        email: p.bestEmail as string,
        caslScope: p.caslScope,
        step: nextStep,
        dueAt,
        openerSubject: lastTouch.subject,
        hookBody,
        contactFirst: p.contacts[0]?.firstName ?? "",
        oooAnchor,
      });
    }

    // 4. Oldest-due first, cap the lane.
    due.sort((a, b) => a.dueAt.valueOf() - b.dueAt.valueOf());
    const lane = due.slice(0, CADENCE_LANE_CAP);
    for (const o of due.slice(CADENCE_LANE_CAP)) {
      outcome.refusals.push({ prospectId: o.prospectId, name: o.name, reason: "lane_cap" });
    }

    for (const a of lane) {
      const scheduledAt = a.oooAnchor
        ? new Date(Math.max(a.oooAnchor.getTime(), a.dueAt.getTime()))
        : a.dueAt.getTime() > now.getTime()
          ? a.dueAt
          : new Date(now.getTime() + Math.floor(Math.random() * CADENCE_JITTER_MS));
      const composed = composeFollowup(a.step, {
        contactFirst: a.contactFirst,
        company: a.name,
        hookBody: a.hookBody,
        landingUrl: landingUrlFor(a.prospectId),
      });
      const dispatch = await db.dispatch.create({
        data: {
          prospectId: a.prospectId,
          channel: "channel_a_automated_email",
          status: "queued",
          caslScope: a.caslScope,
          step: a.step,
          subject: threadSubject(a.openerSubject, a.name),
          body: composed.body,
          scheduledAt,
        },
        select: { id: true },
      });
      outcome.admissions.push({
        prospectId: a.prospectId,
        name: a.name,
        dispatchId: dispatch.id,
        step: a.step,
        scheduledAt,
        note: a.oooAnchor ? "ooo_deferred" : undefined,
      });
    }
    outcome.admitted = outcome.admissions.length;

    // 5. The scan's story — honest counts, named refusals, ≤400 chars.
    const admittedNames = lane.map((a) => `s${a.step} ${a.name}`).slice(0, 3).join(", ");
    const detail = `armed · scanned ${outcome.scanned} · queued ${outcome.admitted}/${CADENCE_LANE_CAP}${admittedNames ? ` · ${admittedNames}` : ""}${
      outcome.refusals.length > 0 ? ` · held: ${refusalSummary(outcome.refusals)}` : ""
    }`;
    await writeEnginePulse({
      engineId: CADENCE_ENGINE_ID,
      pulseRef: `result:${bucket}`,
      watchId: CADENCE_WATCH_ID,
      status: "ok",
      detail: detail.slice(0, 400),
    }).catch(() => undefined);
    return outcome;
  } catch (error) {
    outcome.error = `scan_failed: ${String(error).slice(0, 200)}`;
    await writeEnginePulse({
      engineId: CADENCE_ENGINE_ID,
      pulseRef: `error:${bucket}`,
      watchId: CADENCE_WATCH_ID,
      status: "fail",
      detail: outcome.error,
      expectEveryMs: CADENCE_SCAN_BUCKET_MS,
    }).catch(() => undefined);
    return outcome;
  }
}
