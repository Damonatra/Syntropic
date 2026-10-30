/**
 * Module 9 — Autonomous Closed-Loop Follow-Up Agent (console parity of
 * vertebra/ai/reply_agent.py).
 *
 * POST  /api/replies  — ingest an inbound reply: classify intent (LLM with a
 *                       deterministic keyword fallback), then apply tiered
 *                       autonomy. Tier 1 (send_information / out_of_office /
 *                       not_interested) resolves automatically; tier 2
 *                       (interested / objection_price / objection_erp) parks
 *                       an AI draft in pending_human_review.
 * PATCH /api/replies  — operator triage decision on a draft (approve/discard).
 *
 * This is the operator's manual door — machine mail arrives through the
 * relay doors (/api/mail/inbound, /api/providers/resend/inbound) and feeds
 * the same shared brain: lib/vertebra/replies.ts.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { operatorFromRequest } from "@/lib/vertebra/session";
import { isSuppressed, mailProvider, sendEmail } from "@/lib/vertebra/mailer";
import { ingestReply } from "@/lib/vertebra/replies";
import { guardWrite } from "@/lib/vertebra/guard";

// --------------------------------------------------------------------------- //
// POST — ingest reply
// --------------------------------------------------------------------------- //

const PostSchema = z.object({
  prospectId: z.string().min(1),
  fromEmail: z.string().email(),
  subject: z.string().max(300).nullish(),
  body: z.string().min(1).max(8000),
  messageId: z.string().max(300).nullish(),
  receivedAt: z.string().datetime().nullish(),
});

export async function POST(request: Request) {
  const denied = guardWrite(request, "replies/post", { limit: 20, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const parsed = PostSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const input = parsed.data;

    const result = await ingestReply(input);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      replyId: result.replyId,
      intent: result.intent,
      confidence: result.confidence,
      tier: result.tier,
      action: result.action,
      draft: result.draft,
      prospect: result.prospect,
    });
  } catch (error) {
    console.error("[api/replies] POST failed", error);
    return NextResponse.json({ error: "reply_ingest_failed" }, { status: 500 });
  }
}

// --------------------------------------------------------------------------- //
// PATCH — operator triage decision
// --------------------------------------------------------------------------- //

const PatchSchema = z.object({
  draftId: z.string().min(1),
  decision: z.enum(["approved", "discarded"]),
  subject: z.string().max(300).optional(),
  body: z.string().max(8000).optional(),
});

export async function PATCH(request: Request) {
  const denied = guardWrite(request, "replies/patch", { key: false, limit: 40, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const { draftId, decision, subject, body } = parsed.data;

    const draft = await db.agentDraft.findUnique({
      where: { id: draftId },
      include: {
        reply: {
          include: {
            prospect: {
              select: { id: true, name: true, caslScope: true, contacts: { take: 1 } },
            },
          },
        },
      },
    });
    if (!draft) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });

    // Suppression ledger wins: approving a draft for a suppressed address is refused.
    const toAddress = draft.reply.fromEmail;
    if (decision === "approved" && (await isSuppressed(toAddress, draft.prospectId))) {
      return NextResponse.json({ error: "address_suppressed", hint: "this address unsubscribed; sends are refused" }, { status: 409 });
    }

    const updated = await db.agentDraft.update({
      where: { id: draftId },
      data: {
        status: decision,
        subject: subject ?? draft.subject,
        body: body ?? draft.body,
        reviewerNote: decision === "approved" ? "approved in command centre" : "discarded in command centre",
        sentAt: decision === "approved" ? new Date() : draft.sentAt,
      },
    });

    // Approved tier-2 drafts leave through the real mailer when a provider is
    // configured; otherwise the approval is recorded honestly as staged.
    let delivery: { status: string; reason?: string; providerMsgId?: string } = { status: "not_applicable" };
    if (decision === "approved") {
      const prospect = draft.reply.prospect;
      const result = await sendEmail({
        to: toAddress,
        subject: updated.subject,
        text: updated.body,
        prospectId: prospect?.id ?? null,
        caslScope: prospect?.caslScope ?? false,
        region: prospect?.caslScope ? "ca" : "us",
        replyTo: process.env.VERTEBRA_REPLY_TO ?? null,
      });
      delivery = { status: result.status, reason: result.reason, providerMsgId: result.providerMsgId };
      if (result.status === "staged") {
        await db.agentDraft.update({
          where: { id: draftId },
          data: { reviewerNote: `approved in command centre · staged (${mailProvider()})` },
        });
      }
    }

    if (draft.prospectId) {
      await db.operatorAction.create({
        data: {
          prospectId: draft.prospectId,
          action: "note",
          note:
            decision === "approved"
              ? `Draft approved and sent: "${updated.subject}" (${delivery.status})`
              : `Draft discarded: "${draft.subject}"`,
          actor: (await operatorFromRequest(request)) ?? "operator",
        },
      });
    }

    return NextResponse.json({
      ok: true,
      draft: { id: updated.id, status: updated.status, subject: updated.subject, body: updated.body },
      delivery,
      prospect: draft.reply.prospect,
    });
  } catch (error) {
    console.error("[api/replies] PATCH failed", error);
    return NextResponse.json({ error: "triage_failed" }, { status: 500 });
  }
}
