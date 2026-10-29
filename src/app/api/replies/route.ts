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
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { AUTO_SEND_INTENTS, type ReplyIntent, money } from "@/lib/vertebra/command";
import { auditLeakage } from "@/lib/vertebra/leakage";
import { keywordClassify } from "@/lib/vertebra/reply-intent";
import { isSuppressed, mailProvider, sendEmail } from "@/lib/vertebra/mailer";
import { guardWrite } from "@/lib/vertebra/guard";

// --------------------------------------------------------------------------- //
// Classification
// --------------------------------------------------------------------------- //

const CLASSIFY_OUT = z.object({
  intent: z.enum([
    "interested",
    "out_of_office",
    "send_information",
    "not_interested",
    "objection_price",
    "objection_erp",
  ]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(400),
  draft_subject: z.string().max(200).nullish(),
  draft_body: z.string().max(4000).nullish(),
  return_date: z.string().max(40).nullish(),
});

const CLASSIFY_PROMPT = `You are the intent classifier and draft writer inside Vertebra, Syntropic's B2B quote-leakage engine. Classify the inbound reply from an industrial distributor executive into exactly one intent:
- interested: wants a call/meeting or asks to proceed
- out_of_office: an autoresponder or away notice
- send_information: asks for collateral/one-pager/pricing doc, explicitly deferring a call
- not_interested: declines or asks to be removed
- objection_price: pushes back on cost, demands ROI justification
- objection_erp: pushes back citing ERP complexity, a recent implementation, or integration risk

For interested / objection_price / objection_erp, also draft a reply email (max 160 words) in the voice of Josias — direct, numbers-first, zero fluff, references the prospect's own quote-leakage audit numbers. For objection_erp, address the zero-coupling integration concern. For objection_price, answer with their own leakage math, never a discount.
For out_of_office, extract the return_date (YYYY-MM-DD) if stated.
Respond with strict JSON only: {"intent", "confidence", "rationale", "draft_subject", "draft_body", "return_date"}. Nulls allowed for draft fields and return_date.`;

async function classifyWithLLM(context: string): Promise<z.infer<typeof CLASSIFY_OUT> | null> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: CLASSIFY_PROMPT },
        { role: "user", content: context },
      ],
      thinking: { type: "disabled" },
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;
    const jsonText = raw.replace(/```json|```/g, "").trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return CLASSIFY_OUT.parse(JSON.parse(jsonText.slice(start, end + 1)));
  } catch (error) {
    console.warn("[api/replies] LLM classification unavailable, using keyword fallback:", error);
    return null;
  }
}

// --------------------------------------------------------------------------- //
// Tier-2 draft templates (deterministic fallback when LLM unavailable)
// --------------------------------------------------------------------------- //

function templateDraft(intent: ReplyIntent, ctx: { name: string; contactFirst: string; erp: string; portal: string; leakage: number | null }): { subject: string; body: string } {
  const first = ctx.contactFirst || "there";
  if (intent === "interested") {
    return {
      subject: "Locked — bringing your leakage numbers",
      body: `${first} — good to hear. I'll bring the mystery-shop latency data for distributors your size, the ${ctx.erp} quote-sync walkthrough, and a one-page costed rollout. 20 minutes, your ops team welcome. Sending a calendar hold now. — Josias`,
    };
  }
  if (intent === "objection_erp") {
    return {
      subject: `Re: ${ctx.name} — the zero-coupling answer`,
      body: `${first} — fair challenge. The quote desk doesn't touch ${ctx.erp}: RFQs land structured, your team approves, and won quotes export as a clean ${ctx.erp}-ready order import. No API coupling, no breaking updates on your side. I'll send the two-paragraph integration memo your IT lead can veto line by line. — Josias`,
    };
  }
  if (intent === "objection_price") {
    return {
      subject: "The ROI case, in your own numbers",
      body: `${first} — here it is in your numbers: your audit puts annual net-margin leakage from manual quoting at roughly ${money(ctx.leakage)}. The desk costs a fraction of that, and the audit PDF shows the three leak points we'd close first. If the ratio isn't 5:1 on your own numbers, I'll say so and leave you alone. — Josias`,
    };
  }
  return { subject: `Re: ${ctx.name}`, body: `${first} — acknowledged. — Josias` };
}

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

    const prospect = await db.prospect.findUnique({
      where: { id: input.prospectId },
      include: {
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
        contacts: { take: 1 },
      },
    });
    if (!prospect) return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });

    const contact = prospect.contacts[0];
    const qlvScore = prospect.scores[0]?.qlvScore ?? null;
    const portalLabel = (prospect.quotePortalType ?? "manual_mailto").replace(/_/g, " ");
    const leakage = auditLeakage(prospect.revenueEstimateUsd, qlvScore)?.annual ?? null;

    const llm = await classifyWithLLM(
      [
        `Company: ${prospect.name} (${prospect.vertical ?? "unknown"}, ${prospect.city ?? ""} ${prospect.country ?? ""})`,
        `ERP: ${prospect.detectedErp ?? "unknown"} · quoting via ${portalLabel}`,
        `QLV score: ${qlvScore ?? "unscored"} · estimated annual leakage: ${leakage != null ? money(leakage) : "n/a"}`,
        `Contact: ${contact ? `${contact.firstName} ${contact.lastName}, ${contact.titleRaw ?? contact.role}` : "unknown"}`,
        ``,
        `Inbound reply —`,
        `Subject: ${input.subject ?? "(none)"}`,
        `Body: ${input.body}`,
      ].join("\n"),
    );
    const fallback = keywordClassify(`${input.subject ?? ""} ${input.body}`);
    const intent: ReplyIntent = llm?.intent ?? fallback.intent;
    const confidence = llm?.confidence ?? fallback.confidence;
    const rationale = llm?.rationale ?? fallback.rationale;
    const returnDate = llm?.return_date ?? null;

    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    const reply = await db.inboundReply.create({
      data: {
        prospectId: prospect.id,
        messageId: input.messageId ?? null,
        fromEmail: input.fromEmail,
        subject: input.subject ?? null,
        body: input.body,
        intent,
        intentConfidence: confidence,
        rationale: llm ? `${rationale} (model: console-llm-class)` : `${rationale} (keyword fallback)`,
        extractedJson: returnDate ? JSON.stringify({ return_date: returnDate }) : null,
        processedAt: new Date(),
        receivedAt,
      },
    });

    let draft: { id: string; status: string; subject: string; body: string } | null = null;
    let action: string;

    // Suppression ledger: record the reply, but never automate anything outbound.
    if (await isSuppressed(prospect.bestEmail, prospect.id)) {
      action = "suppressed_no_send";
      return NextResponse.json({
        ok: true,
        replyId: reply.id,
        intent,
        confidence,
        tier: 0,
        action,
        draft: null,
        prospect: { id: prospect.id, name: prospect.name, qlvScore },
      });
    }

    if ((AUTO_SEND_INTENTS as readonly string[]).includes(intent)) {
      // Tier 1 — resolve autonomously, no human gate.
      if (intent === "send_information") {
        const created = await db.agentDraft.create({
          data: {
            replyId: reply.id,
            prospectId: prospect.id,
            intent,
            subject: `The one-pager + audit sample, as requested`,
            body: `${contact?.firstName ?? "there"} — attached: the one-pager and a redacted audit sample from a distributor your size. No call scheduled; when you've circulated it, reply with a time and I'll work around your team. — Josias`,
            status: "sent",
            sentAt: new Date(),
          },
        });
        draft = { id: created.id, status: created.status, subject: created.subject, body: created.body };
      } else if (intent === "out_of_office") {
        const pushTo = returnDate ? new Date(returnDate) : new Date(Date.now() + 7 * 86_400_000);
        await db.dispatch.updateMany({
          where: { prospectId: prospect.id, channel: "channel_a_automated_email", status: { in: ["queued", "sent", "opened"] } },
          data: { status: "queued", scheduledAt: pushTo },
        });
      } else if (intent === "not_interested") {
        await db.dispatch.updateMany({
          where: { prospectId: prospect.id, channel: "channel_a_automated_email" },
          data: { status: "stopped" },
        });
      }
      action =
        intent === "out_of_office"
          ? "sequence_rescheduled"
          : intent === "not_interested"
            ? "sequences_stopped"
            : "auto_sent";
    } else {
      // Tier 2 — human gate: park a draft for review.
      const tpl = templateDraft(intent, {
        name: prospect.name,
        contactFirst: contact?.firstName ?? "",
        erp: prospect.detectedErp ?? "your",
        portal: portalLabel,
        leakage,
      });
      const created = await db.agentDraft.create({
        data: {
          replyId: reply.id,
          prospectId: prospect.id,
          intent,
          subject: llm?.draft_subject ?? tpl.subject,
          body: llm?.draft_body ?? tpl.body,
          status: "pending_human_review",
        },
      });
      draft = { id: created.id, status: created.status, subject: created.subject, body: created.body };
      action = "draft_pending_review";
    }

    return NextResponse.json({
      ok: true,
      replyId: reply.id,
      intent,
      confidence,
      tier: (AUTO_SEND_INTENTS as readonly string[]).includes(intent) ? 1 : 2,
      action,
      draft,
      prospect: { id: prospect.id, name: prospect.name, qlvScore },
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
