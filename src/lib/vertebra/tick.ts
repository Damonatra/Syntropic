/**
 * Sequence engine — the loop closer (shared by the engine/cron entry and the
 * operator's RUN TICK in Ops).
 *
 * Claims due Channel A dispatches (status queued, scheduledAt in the past):
 *   suppressed  → stopped (CASL ledger wins over everything)
 *   provider up → sent via the mailer (CASL footer + one-click headers)
 *   no provider → re-queued +15 min (honest backoff, never fake-sent)
 *   transport err → failed (surfaced in Ops)
 */
import { db } from "@/lib/db";
import { isSuppressed, mailProvider, sendEmail } from "@/lib/vertebra/mailer";
import { CLOSE_CTA, buildCaslFooter, subjectForHook } from "@/lib/vertebra/casl";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";

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
