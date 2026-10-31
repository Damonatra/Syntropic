/**
 * Reply ingestion core — the brain behind every inbound-mail door.
 *
 * /api/replies (the operator's manual door) and the machine doors
 * (/api/mail/inbound, /api/providers/resend/inbound) all feed this one
 * implementation: classify intent → write the InboundReply → apply tiered
 * autonomy (tier 1 resolves, tier 2 parks a draft for human review).
 * One brain, many doors, no drift.
 *
 * Also lives here: the address→prospect matcher the machine doors depend on
 * (exact bestEmail first, then the prospect's own domain), and the honest
 * unmatched path — a reply we can't tie to a prospect is still recorded,
 * evidence preserved, never discarded.
 */
import { db } from "@/lib/db";
import { AUTO_SEND_INTENTS, type ReplyIntent, money } from "@/lib/vertebra/command";
import { auditLeakage } from "@/lib/vertebra/leakage";
import { keywordClassify } from "@/lib/vertebra/reply-intent";
import { isSuppressed } from "@/lib/vertebra/mailer";
import { parseAddressHeader, addressDomain } from "@/lib/vertebra/webhook-verify";
import { deliverAlert } from "@/lib/vertebra/pager";
import { writeEnginePulse } from "@/lib/vertebra/pulse";
import { z } from "zod";

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
    const completion = zai.chat.completions.create({
      messages: [
        { role: "assistant", content: CLASSIFY_PROMPT },
        { role: "user", content: context },
      ],
      thinking: { type: "disabled" },
    });
    // Machine doors run inside webhook handling — an unbounded LLM call would
    // stall the delivery pipeline (providers retry, then suppress the endpoint).
    // Bound it: the deterministic keyword fallback covers a slow or absent LLM.
    const raced = await Promise.race([
      completion,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    if (!raced) return null;
    const raw = raced.choices[0]?.message?.content;
    if (!raw) return null;
    const jsonText = raw.replace(/```json|```/g, "").trim();
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return CLASSIFY_OUT.parse(JSON.parse(jsonText.slice(start, end + 1)));
  } catch (error) {
    console.warn("[vertebra/replies] LLM classification unavailable, using keyword fallback:", error);
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
// Address → prospect matching (the machine doors' router)
// --------------------------------------------------------------------------- //

export type ProspectMatch = { prospectId: string; via: "best_email" | "domain" } | null;

/**
 * Route an inbound address onto the prospect book.
 *   1. exact — the address is the prospect's bestEmail (the one we sent to)
 *   2. domain — the sender's domain is the prospect's own domain; prefer a
 *      prospect we're actively in conversation with (a live dispatch), then
 *      the most recently touched row. Multiple prospects on one domain are
 *      ambiguous — active-conversation evidence breaks the tie or we refuse
 *      to guess.
 */
export async function matchProspectByEmail(fromEmail: string): Promise<ProspectMatch> {
  const parsed = parseAddressHeader(fromEmail);
  const address = parsed?.address ?? fromEmail.trim().toLowerCase();
  if (!address.includes("@")) return null;

  // SQLite string filters are case-sensitive (no mode:"insensitive"), so the
  // fast path matches on the stored value and a JS-normalised sweep covers
  // anything the book holds in mixed case. Console book is modest; the
  // Postgres mirror can swap in insensitive filters without touching callers.
  let exact = await db.prospect.findFirst({
    where: { bestEmail: address },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!exact) {
    const rows = await db.prospect.findMany({
      where: { bestEmail: { not: null } },
      select: { id: true, bestEmail: true },
      orderBy: { updatedAt: "desc" },
    });
    const hit = rows.find((r) => r.bestEmail?.toLowerCase() === address);
    if (hit) exact = { id: hit.id };
  }
  if (exact) return { prospectId: exact.id, via: "best_email" };

  const domain = addressDomain(address);
  if (!domain) return null;
  const liveDispatches = { where: { status: { in: ["queued", "sent", "opened", "delivered"] } }, take: 1, select: { id: true } };
  let domainCandidates = await db.prospect.findMany({
    where: { domain },
    orderBy: { updatedAt: "desc" },
    select: { id: true, dispatches: liveDispatches },
  });
  if (domainCandidates.length === 0) {
    const rows = await db.prospect.findMany({
      where: { domain: { not: null } },
      select: { id: true, domain: true, dispatches: liveDispatches },
      orderBy: { updatedAt: "desc" },
    });
    domainCandidates = rows.filter((r) => r.domain?.toLowerCase() === domain);
  }
  if (domainCandidates.length === 0) return null;
  if (domainCandidates.length === 1) return { prospectId: domainCandidates[0].id, via: "domain" };
  const withLiveDispatch = domainCandidates.find((p) => p.dispatches.length > 0);
  if (withLiveDispatch) return { prospectId: withLiveDispatch.id, via: "domain" };
  return null; // several prospects share this domain and none is live — refuse to guess
}

// --------------------------------------------------------------------------- //
// The reply pager — a live reply is a human-moment, not a ledger row.
//
// Doctrine (operator decision, 2026-10-31): page on the LIVE intents only —
// interested, the two objections, and send_information (its one-pager auto-
// sends, but a human must know the conversation opened). Out-of-office and
// clean declines are ledger rows, not pages — the machine already handled
// them (reschedule / stop) and a page would be noise. Suppressed prospects
// are dead — recorded, never paged.
//
// Claim-first, convoy-style: the EnginePulse claim (UNIQUE engineId+
// pulseRef) is written BEFORE the page — a retried webhook can never
// double-page. Failure-isolated: the pager never throws into ingest —
// machine doors run inside webhook handling.
// --------------------------------------------------------------------------- //

export const REPLY_PAGER_ENGINE_ID = "reply-pager";
export const REPLY_PAGED_INTENTS: readonly ReplyIntent[] = [
  "interested",
  "objection_price",
  "objection_erp",
  "send_information",
];

export interface ReplyPageInput {
  company: string;
  qlvScore: number | null;
  intent: ReplyIntent;
  confidence: number;
  theirWords: string | null;
  machineAction: string; // "auto_sent" (one-pager out) | "draft_pending_review"
}

/** Plain text only — pager channels render it verbatim; no markdown escaping class of bugs. */
export function replyPageBody(input: ReplyPageInput): string {
  const lines = [
    `Company: ${input.company}${input.qlvScore != null ? ` · QLV ${input.qlvScore}/100` : ""}`,
    `Intent: ${input.intent} (${Math.round(input.confidence * 100)}% confident)`,
    `Their words: ${input.theirWords ? (input.theirWords.length > 160 ? `${input.theirWords.slice(0, 157)}…` : input.theirWords) : "(body not classifiable — read the reply in Ops)"}`,
    input.machineAction === "auto_sent"
      ? "Machine: the one-pager + audit sample already went out — no action owed unless they come back."
      : "Machine: a draft is parked for human review — approve, edit, or discard in Ops. Proceed accordingly.",
  ];
  return lines.join("\n");
}

function replyPageTitle(company: string): string {
  return `CHANNEL A · REPLY LANDED — ${company}`;
}

/**
 * Fire-and-forget page for a live reply. Claim-first (never double-pages a
 * retried webhook), fully failure-isolated (never throws into ingest).
 */
async function pageLiveReply(args: {
  replyId: string;
  company: string;
  qlvScore: number | null;
  intent: ReplyIntent;
  confidence: number;
  theirWords: string | null;
  machineAction: string;
}): Promise<void> {
  try {
    const claim = await writeEnginePulse({
      engineId: REPLY_PAGER_ENGINE_ID,
      pulseRef: `page:${args.replyId}`,
      watchId: "reply_page",
      status: "ok",
      detail: `${args.company} — ${args.intent} reply paged`,
    });
    if (claim.deduped) return; // a retry of the same reply absorbs
    await deliverAlert(replyPageTitle(args.company), replyPageBody(args));
  } catch {
    // A lost page is visible as a claimed pulse with no delivery — honest,
    // at-most-once. It must never fail the reply's ingest path.
  }
}

// --------------------------------------------------------------------------- //
// The one ingest path every door shares
// --------------------------------------------------------------------------- //

export interface ReplyIngestInput {
  prospectId: string;
  fromEmail: string;
  subject?: string | null;
  body: string;
  messageId?: string | null;
  receivedAt?: string | null; // ISO 8601
}

export interface ReplyIngestResult {
  ok: true;
  replyId: string;
  intent: ReplyIntent;
  confidence: number;
  tier: 0 | 1 | 2;
  action: string;
  draft: { id: string; status: string; subject: string; body: string } | null;
  prospect: { id: string; name: string; qlvScore: number | null };
}

export async function ingestReply(input: ReplyIngestInput): Promise<ReplyIngestResult | { ok: false; error: "prospect_not_found" }> {
  const prospect = await db.prospect.findUnique({
    where: { id: input.prospectId },
    include: {
      scores: { orderBy: { createdAt: "desc" }, take: 1 },
      contacts: { take: 1 },
    },
  });
  if (!prospect) return { ok: false, error: "prospect_not_found" };

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
    return {
      ok: true,
      replyId: reply.id,
      intent,
      confidence,
      tier: 0,
      action: "suppressed_no_send",
      draft: null,
      prospect: { id: prospect.id, name: prospect.name, qlvScore },
    };
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

  // The reply pager — live intents wake the humans (claim-first, never
  // throws). OOO and not_interested stay ledger-only by doctrine.
  if ((REPLY_PAGED_INTENTS as readonly string[]).includes(intent)) {
    await pageLiveReply({
      replyId: reply.id,
      company: prospect.name,
      qlvScore,
      intent,
      confidence,
      theirWords: input.body,
      machineAction: action === "auto_sent" ? "auto_sent" : "draft_pending_review",
    });
  }

  return {
    ok: true,
    replyId: reply.id,
    intent,
    confidence,
    tier: (AUTO_SEND_INTENTS as readonly string[]).includes(intent) ? 1 : 2,
    action,
    draft,
    prospect: { id: prospect.id, name: prospect.name, qlvScore },
  };
}

/**
 * The honest unmatched path: a real reply we can't tie to a prospect is still
 * written — evidence preserved, intent "unknown", nothing automated. The desk
 * sees it in the book and can link it by hand.
 */
export async function recordUnmatchedReply(input: { fromEmail: string; subject?: string | null; body: string; messageId?: string | null; receivedAt?: string | null }): Promise<string> {
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  const fallback = keywordClassify(`${input.subject ?? ""} ${input.body}`);
  const reply = await db.inboundReply.create({
    data: {
      prospectId: null,
      messageId: input.messageId ?? null,
      fromEmail: input.fromEmail,
      subject: input.subject ?? null,
      body: input.body,
      intent: fallback.intent,
      intentConfidence: fallback.confidence,
      rationale: `${fallback.rationale} (unmatched sender — no prospect link; operator review)`,
      processedAt: new Date(),
      receivedAt,
    },
  });
  return reply.id;
}
