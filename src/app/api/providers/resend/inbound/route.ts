/**
 * POST /api/providers/resend/inbound — Resend's native receiving door.
 *
 * Resend delivers inbound mail as an `email.received` Svix-signed webhook.
 * The webhook carries metadata only (from, to, subject, message_id) — the
 * body must be fetched from the Received emails API with the same
 * RESEND_API_KEY the egress mailer already holds. So this door:
 *
 *   1. verifies the Svix signature (svix-id / svix-timestamp / svix-signature
 *      against RESEND_WEBHOOK_SECRET, 5-minute replay tolerance),
 *   2. dedupes on the svix-id via the EnginePulse ledger (Resend retries keep
 *      the same svix-id — a retry never double-ingests),
 *   3. fetches the body (GET /emails/receiving/:email_id),
 *   4. routes the parsed envelope into the shared brain (lib/vertebra/
 *      replies.ts) — identical behaviour to the canonical relay door.
 *
 * A body-fetch failure returns 502 so Resend's retry machinery does the
 * re-drive; the dedupe row is only written after the reply is safe.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifySvix, parseAddressHeader } from "@/lib/vertebra/webhook-verify";
import { ingestReply, matchProspectByEmail, recordUnmatchedReply } from "@/lib/vertebra/replies";
import { writeEnginePulse } from "@/lib/vertebra/pulse";

const ReceivedEvent = z.object({
  type: z.literal("email.received"),
  created_at: z.string().optional(),
  data: z.object({
    email_id: z.string().min(1),
    from: z.string().min(3),
    to: z.array(z.string()).nullish(),
    subject: z.string().nullish(),
    message_id: z.string().nullish(),
    created_at: z.string().nullish(),
  }),
});

/** Naive HTML → text for the case the received email is html-only. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchReceivedBody(emailId: string): Promise<{ text: string } | { error: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { error: "resend_api_key_required" };
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { error: `resend_${res.status}: ${detail.slice(0, 200)}` };
    }
    const j = (await res.json()) as Record<string, unknown>;
    const rawText = typeof j.text === "string" ? j.text : typeof j.text_body === "string" ? j.text_body : null;
    const rawHtml = typeof j.html === "string" ? j.html : typeof j.html_body === "string" ? j.html_body : null;
    const text = rawText?.trim() ? rawText.trim() : rawHtml ? htmlToText(rawHtml) : "";
    if (!text) return { error: "empty_body" };
    return { text: text.slice(0, 8000) };
  } catch (error) {
    return { error: `transport: ${String(error).slice(0, 200)}` };
  }
}

export async function POST(request: Request) {
  const raw = await request.text();
  const verdict = verifySvix(
    raw,
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    process.env.RESEND_WEBHOOK_SECRET,
  );
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = ReceivedEvent.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
  }
  const evt = parsed.data;

  const sender = parseAddressHeader(evt.data.from);
  if (!sender) {
    return NextResponse.json({ error: "unparseable_from" }, { status: 400 });
  }

  try {
    // Retry short-circuit: same svix-id never processes twice.
    const seen = await db.enginePulse.findFirst({
      where: { engineId: "resend-inbound", pulseRef: verdict.eventId },
      select: { id: true },
    });
    if (seen) {
      return NextResponse.json({ ok: true, duplicate: true, note: "svix-id already ingested" });
    }

    const body = await fetchReceivedBody(evt.data.email_id);
    if ("error" in body) {
      // No dedupe row written — Resend's retry will re-drive this delivery.
      return NextResponse.json({ error: "body_fetch_failed", detail: body.error }, { status: 502 });
    }

    const match = await matchProspectByEmail(sender.address);
    let payload: Record<string, unknown>;
    let pulseStatus: "ok" | "warn" = "ok";

    if (!match) {
      const replyId = await recordUnmatchedReply({
        fromEmail: sender.address,
        subject: evt.data.subject ?? null,
        body: body.text,
        messageId: evt.data.message_id ?? null,
        receivedAt: evt.data.created_at ?? evt.created_at ?? null,
      });
      payload = { ok: true, matched: false, replyId };
      pulseStatus = "warn";
    } else {
      const result = await ingestReply({
        prospectId: match.prospectId,
        fromEmail: sender.address,
        subject: evt.data.subject ?? null,
        body: body.text,
        messageId: evt.data.message_id ?? null,
        receivedAt: evt.data.created_at ?? evt.created_at ?? null,
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 404 });
      }
      payload = {
        ok: true,
        matched: true,
        matchedVia: match.via,
        replyId: result.replyId,
        intent: result.intent,
        confidence: result.confidence,
        tier: result.tier,
        action: result.action,
        draft: result.draft,
        prospect: result.prospect,
      };
    }

    await writeEnginePulse({
      engineId: "resend-inbound",
      pulseRef: verdict.eventId,
      watchId: "resend_inbound",
      status: pulseStatus,
      detail:
        pulseStatus === "warn"
          ? `unmatched reply from ${sender.address} — recorded for operator link`
          : `reply via ${match?.via} → intent ${(payload as { intent?: string }).intent} (${(payload as { action?: string }).action})`,
    });
    return NextResponse.json(payload, { status: payload.matched ? 200 : 202 });
  } catch (error) {
    console.error("[api/providers/resend/inbound] failed", error);
    return NextResponse.json({ error: "inbound_ingest_failed" }, { status: 500 });
  }
}
