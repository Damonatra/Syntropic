/**
 * Sequence engine — the loop closer (shared by the engine/cron entry and the
 * operator's RUN TICK in Ops).
 *
 * Two loops, one tick:
 *   · runSequenceTick   — Channel A dispatches (the outreach loop)
 *   · runTurnaroundTick — engagement stages + deliverable renders (the
 *                         document turnaround engine, pulsing heartbeats)
 * Both are claimed-and-executed closers: honest gates, idempotent moves,
 * ledger-first writes. The operator's button and the scheduler call the
 * same functions — there is no other entry.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { isSuppressed, mailProvider, sendEmail } from "@/lib/vertebra/mailer";
import { CLOSE_CTA, buildCaslFooter, subjectForHook } from "@/lib/vertebra/casl";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";
import { buildBriefPdf } from "@/lib/vertebra/brief-pdf";
import { buildAuditBriefLines } from "@/lib/vertebra/brief-build";
import {
  TURNAROUND_CADENCE_MS,
  TURNAROUND_ENGINE_ID,
  planTurnaround,
  pulseRef,
  slaGuard,
  type TurnaroundAction,
  type TurnaroundRow,
} from "@/lib/vertebra/turnaround";
import { writeEnginePulse } from "@/lib/vertebra/pulse";
import { stageMoveTarget } from "@/lib/vertebra/watches";

const NO_PROVIDER_BACKOFF_MS = 15 * 60_000;

export interface TickOutcome {
  due: number;
  sent: number;
  stopped: number;
  deferred: number;
  failed: number;
  provider: string;
  details: Array<{ id: string; prospect: string; outcome: string; note?: string }>;
}

function composeBody(args: {
  contactFirst: string;
  hookBody: string | null;
  region: string | null;
  prospectId: string;
  address: string;
}): string {
  const first = args.contactFirst || "there";
  const hook = args.hookBody ?? "Your quote desk is leaking margin on RFQs that never get priced competitively.";
  return `${first} —\n\n${hook}\n\n${CLOSE_CTA}\n\n— Josias\n\n${buildCaslFooter(args.prospectId, args.address, args.region)}`;
}

export async function runSequenceTick(): Promise<TickOutcome> {
  const now = new Date();
  const outcome: TickOutcome = { due: 0, sent: 0, stopped: 0, deferred: 0, failed: 0, provider: mailProvider(), details: [] };

  const due = await db.dispatch.findMany({
    where: { status: "queued", scheduledAt: { lte: now }, channel: "channel_a_automated_email" },
    orderBy: { scheduledAt: "asc" },
    take: 25,
    include: {
      prospect: {
        include: {
          contacts: { take: 1 },
          scores: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });
  outcome.due = due.length;
  if (due.length > 0) invalidateSnapshot();

  for (const d of due) {
    const p = d.prospect;
    const email = p.bestEmail;

    // 1. Suppression ledger wins over everything.
    if (await isSuppressed(email, p.id)) {
      await db.dispatch.update({ where: { id: d.id }, data: { status: "stopped", error: "suppressed" } });
      outcome.stopped += 1;
      outcome.details.push({ id: d.id, prospect: p.name, outcome: "stopped", note: "suppression ledger" });
      continue;
    }
    if (!email) {
      await db.dispatch.update({ where: { id: d.id }, data: { status: "failed", error: "no verified email on file" } });
      outcome.failed += 1;
      outcome.details.push({ id: d.id, prospect: p.name, outcome: "failed", note: "no verified email" });
      continue;
    }

    // 2. Compose: stored body when the dispatch carries one, else hook-driven.
    const score = p.scores[0];
    const topHook = (() => {
      try {
        const hooks = score ? (JSON.parse(score.hooksJson) as Array<{ flavor: string; body: string }>) : [];
        return hooks[0] ?? null;
      } catch {
        return null;
      }
    })();
    const subject = d.subject ?? (topHook ? subjectForHook(topHook.flavor, p.name) : `${p.name}: quoting benchmark`);
    const body =
      d.body ??
      composeBody({
        contactFirst: p.contacts[0]?.firstName ?? "",
        hookBody: topHook?.body ?? null,
        region: p.caslScope ? "ca" : "us",
        prospectId: p.id,
        address: email,
      });

    // 3. Send through the mailer (Resend when configured, honest backoff when not).
    const result = await sendEmail({
      to: email,
      subject,
      text: body,
      prospectId: p.id,
      caslScope: p.caslScope,
      region: p.caslScope ? "ca" : "us",
      fromDomain: d.fromDomain,
    });

    if (result.status === "sent") {
      await db.dispatch.update({
        where: { id: d.id },
        data: { status: "sent", provider: "resend", providerMsgId: result.providerMsgId, footerApplied: "casl", error: null, updatedAt: now },
      });
      outcome.sent += 1;
      outcome.details.push({ id: d.id, prospect: p.name, outcome: "sent", note: result.providerMsgId });
    } else if (result.status === "staged") {
      await db.dispatch.update({
        where: { id: d.id },
        data: { status: "queued", error: "staged: no provider configured", scheduledAt: new Date(Date.now() + NO_PROVIDER_BACKOFF_MS) },
      });
      outcome.deferred += 1;
      outcome.details.push({ id: d.id, prospect: p.name, outcome: "deferred", note: "no provider configured" });
    } else {
      await db.dispatch.update({
        where: { id: d.id },
        data: { status: "failed", error: result.reason?.slice(0, 300) ?? "send failed" },
      });
      outcome.failed += 1;
      outcome.details.push({ id: d.id, prospect: p.name, outcome: "failed", note: result.reason?.slice(0, 120) });
    }
  }

  return outcome;
}

// --------------------------------------------------------------------------- //
// The document turnaround engine — stages, artifacts, heartbeats
// --------------------------------------------------------------------------- //

/** Adjacent source for each machine-legal target — mirrors STAGE_TRANSITIONS. */
const ADVANCE_FROM: Record<"intake" | "forensics" | "verdict", string> = {
  intake: "paid",
  forensics: "intake",
  verdict: "forensics",
};

export interface TurnaroundTickOutcome {
  scanned: number;
  advanced: number;
  rendered: number;
  awaitingRelease: number;
  failures: number;
  /** Per-action ledger — the deck's tick flash and the tests both read this. */
  details: Array<{ id: string; ref: string; action: string; to?: string; note?: string }>;
  guard: { status: "ok" | "warn"; detail: string };
  pulses: { written: number; deduped: number };
}

/** Joins refs into a ≤-limit clause — pulse details cap at 400 chars. */
function refClause(refs: string[], limit = 380): string {
  if (refs.length === 0) return "";
  let out = "";
  let n = 0;
  for (const r of refs) {
    const piece = (out ? " · " : "") + r;
    if (out.length + piece.length > limit) {
      return `${out} … +${refs.length - n} more`;
    }
    out += piece;
    n += 1;
  }
  return out;
}

export async function runTurnaroundTick(): Promise<TurnaroundTickOutcome> {
  const now = new Date();
  const nowMs = now.getTime();
  const outcome: TurnaroundTickOutcome = {
    scanned: 0,
    advanced: 0,
    rendered: 0,
    awaitingRelease: 0,
    failures: 0,
    details: [],
    guard: { status: "ok", detail: "sweep failed before the guard ran" },
    pulses: { written: 0, deduped: 0 },
  };

  // ---- sweep — the four stages the machine may touch --------------------- //
  const active = await db.engagement.findMany({
    where: { status: { in: ["paid", "intake", "forensics", "verdict"] } },
    include: {
      _count: { select: { documents: true } },
      events: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  outcome.scanned = active.length;

  const rows: TurnaroundRow[] = active.map((e) => {
    // Verdict entry from the ledger trail — the same read stageEnteredAtMs
    // runs: newest stage_changed whose LEADING move names verdict (the
    // engine's own details carry their story after the move — the parser
    // reads the head, not the tail).
    const entry = e.events.find(
      (ev) => ev.kind === "stage_changed" && stageMoveTarget(ev.detail) === "verdict",
    );
    return {
      id: e.id,
      ref: e.ref,
      status: e.status,
      contactName: e.contactName,
      contactEmail: e.contactEmail,
      intakeRfqPerMonth: e.intakeRfqPerMonth,
      intakeLineItems: e.intakeLineItems,
      guaranteeCleared: e.guaranteeCleared,
      confirmedLeakageUsd: e.confirmedLeakageUsd,
      deliverableUrl: e.deliverableUrl,
      paidAtMs: e.paidAt.getTime(),
      docCount: e._count.documents,
      verdictEnteredAtMs: entry?.createdAt.getTime() ?? null,
    };
  });
  outcome.awaitingRelease = rows.filter((r) => r.status === "verdict" && r.guaranteeCleared != null && r.deliverableUrl != null).length;

  // ---- execute the plan — failure-isolated per action -------------------- //
  const advanceRefs: string[] = [];
  const renderRefs: string[] = [];
  const advanceFails: string[] = [];
  const renderFails: string[] = [];
  const justRendered = new Set<string>();

  const execute = async (action: TurnaroundAction): Promise<void> => {
    if (action.kind === "advance_stage") {
      // Optimistic claim: the update only lands when the stage is still what
      // the plan read — an operator or a concurrent tick that moved first
      // wins, and the engine's ledger stays free of ghosts.
      const from = ADVANCE_FROM[action.to!];
      const claimed = await db.engagement.updateMany({
        where: { id: action.engagementId, status: from },
        data: { status: action.to! },
      });
      if (claimed.count === 0) {
        outcome.details.push({ id: action.engagementId, ref: action.ref, action: "advance_stage", to: action.to, note: "lost claim — moved first elsewhere" });
        return;
      }
      await db.engagementEvent.create({
        data: { engagementId: action.engagementId, kind: "stage_changed", actor: "engine", detail: action.detail },
      });
      invalidateSnapshot();
      outcome.advanced += 1;
      advanceRefs.push(`${action.ref}→${action.to}`);
      outcome.details.push({ id: action.engagementId, ref: action.ref, action: "advance_stage", to: action.to, note: action.gate });
    } else {
      // Render: re-load the composite and re-verify — the plan may be stale;
      // the gate is the ledger, not the sweep.
      const fresh = await db.engagement.findUnique({
        where: { id: action.engagementId },
        include: {
          prospect: {
            select: {
              id: true,
              name: true,
              revenueEstimateUsd: true,
              scores: { take: 1, orderBy: { createdAt: "desc" }, select: { qlvScore: true } },
            },
          },
          documents: { orderBy: { createdAt: "asc" } },
          events: { orderBy: { createdAt: "desc" }, take: 14 },
        },
      });
      if (!fresh || fresh.guaranteeCleared == null || fresh.confirmedLeakageUsd == null || fresh.deliverableUrl != null) {
        outcome.details.push({ id: action.engagementId, ref: action.ref, action: "render_deliverable", note: "gate moved — skipped" });
        return;
      }
      const { lines, seal } = buildAuditBriefLines(fresh, new Date());
      const pdf = buildBriefPdf(lines);
      const dir = join(process.cwd(), "db", "deliverables");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${fresh.id}.pdf`), pdf);
      await db.engagement.update({ where: { id: fresh.id }, data: { deliverableUrl: `/api/portal/engagements/${fresh.id}/deliverable` } });
      await db.engagementEvent.create({
        data: {
          engagementId: fresh.id,
          kind: "deliverable_generated",
          actor: "engine",
          detail: `generated audit deliverable · ${(pdf.length / 1024).toFixed(1)} kb · seal ${seal}`,
        },
      });
      invalidateSnapshot();
      outcome.rendered += 1;
      justRendered.add(fresh.id);
      renderRefs.push(action.ref);
      outcome.details.push({ id: fresh.id, ref: fresh.ref, action: "render_deliverable", note: `${(pdf.length / 1024).toFixed(1)} kb · seal ${seal}` });
    }
  };

  for (const action of planTurnaround(rows, nowMs)) {
    try {
      await execute(action);
    } catch (err) {
      outcome.failures += 1;
      const msg = err instanceof Error ? err.message.slice(0, 120) : "unknown failure";
      (action.kind === "advance_stage" ? advanceFails : renderFails).push(`${action.ref}: ${msg}`);
      outcome.details.push({ id: action.engagementId, ref: action.ref, action: action.kind, to: action.to, note: `failed — ${msg}` });
    }
  }

  // ---- the guard — the engine reads the same clocks the tower rings ------ //
  // awaitingRelease counts work rendered here too — the sweep read the row
  // before the artifact existed, and the pulse must not lie about it.
  outcome.awaitingRelease = rows.filter(
    (r) => r.status === "verdict" && r.guaranteeCleared != null && (r.deliverableUrl != null || justRendered.has(r.id)),
  ).length;
  outcome.guard = slaGuard(rows, nowMs);

  // ---- heartbeats — three watches, one cadence, honest details ----------- //
  const beat = async (watchId: string, status: "ok" | "warn" | "fail", detail: string): Promise<void> => {
    try {
      const res = await writeEnginePulse({
        engineId: TURNAROUND_ENGINE_ID,
        pulseRef: pulseRef(watchId, nowMs),
        watchId,
        status,
        detail: detail.slice(0, 400),
        expectEveryMs: TURNAROUND_CADENCE_MS,
      });
      if (res.deduped) outcome.pulses.deduped += 1;
      else outcome.pulses.written += 1;
    } catch (err) {
      // A pulse failure must never fail the tick's work — the ledger is
      // written; the silence watch will speak for the missing heartbeat.
      console.error(`[tick/turnaround] pulse ${watchId} failed`, err);
    }
  };

  await beat(
    "stage_advance",
    advanceFails.length > 0 ? "fail" : "ok",
    advanceFails.length > 0
      ? `fail — ${advanceFails.length} advance failure(s) · ${refClause(advanceFails)}`
      : outcome.advanced > 0
        ? `${outcome.advanced} advanced · ${refClause(advanceRefs)}`
        : `nothing due · ${outcome.scanned} active — gates held by the operators, not the machine`,
  );
  await beat(
    "deliverable_render",
    renderFails.length > 0 ? "fail" : "ok",
    renderFails.length > 0
      ? `fail — ${renderFails.length} render failure(s) · ${refClause(renderFails)}`
      : outcome.rendered > 0
        ? `${outcome.rendered} rendered · ${refClause(renderRefs)} · ${outcome.awaitingRelease} awaiting release`
        : outcome.awaitingRelease > 0
          ? `${outcome.awaitingRelease} awaiting release — rendered, waiting on the operator`
          : "nothing to render — verdicts undecided or artifacts shipped",
  );
  await beat("sla_guard", outcome.guard.status, outcome.guard.detail);

  return outcome;
}
