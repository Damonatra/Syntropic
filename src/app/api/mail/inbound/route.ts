/**
 * POST /api/mail/inbound — the canonical inbound-mail door.
 *
 * The enclave's own contract for received email, signed like every other
 * machine door (portal ingest, ops heartbeat): HMAC-SHA256(rawBody,
 * INBOUND_MAIL_SECRET), hex, sent as `x-vertebra-signature`. Any relay —
 * an IMAP poller, a Cloudflare Email Worker, a forwarding service — becomes
 * a ~20-line adapter that POSTs this envelope. No vendor lock, one door.
 *
 * Envelope:
 *   from       required  "Jane Roe <jane@acme.com>" or bare address
 *   subject    optional
 *   text       required  the plain-text body
 *   to         optional  the address the mail landed on
 *   messageId  optional  RFC Message-ID — doubles as the retry dedupe ref
 *   receivedAt optional  ISO 8601
 *
 * Routing: exact bestEmail match first, then the sender's own domain
 * (active-conversation evidence breaks ties — see matchProspectByEmail).
 * Matched mail runs the shared brain: classify → tiered autonomy.
 * Unmatched mail is still recorded, evidence preserved, nothing automated.
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { hmacDoorValid, parseAddressHeader } from "@/lib/vertebra/webhook-verify";
import { ingestReply, matchProspectByEmail, recordUnmatchedReply } from "@/lib/vertebra/replies";
import { writeEnginePulse } from "@/lib/vertebra/pulse";

const Envelope = z.object({
  from: z.string().min(3).max(400),
  subject: z.string().max(300).nullish(),
  text: z.string().min(1).max(8000),
  to: z.string().max(400).nullish(),
  messageId: z.string().max(300).nullish(),
  receivedAt: z.string().datetime().nullish(),
});

export async function POST(request: Request) {
  const raw = await request.text();
  if (!hmacDoorValid(raw, request.headers.get("x-vertebra-signature"), process.env.INBOUND_MAIL_SECRET)) {
    return NextResponse.json(
      {
        error: "missing_or_invalid_signature",
        hint: "sign the raw body with HMAC-SHA256(INBOUND_MAIL_SECRET), hex, in x-vertebra-signature",
      },
      { status: 401 },
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = Envelope.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
  }
  const envelope = parsed.data;

  const sender = parseAddressHeader(envelope.from);
  if (!sender) {
    return NextResponse.json({ error: "unparseable_from", hint: 'from must be "Name <addr>" or a bare address' }, { status: 400 });
  }

  try {
    // Retry dedupe on the EnginePulse ledger — same contract the heartbeat
    // door uses, so relay retries never double-ingest a reply.
    const pulseRef = envelope.messageId ?? createHash("sha256").update(`${sender.address}|${envelope.subject ?? ""}|${envelope.text}`).digest("hex").slice(0, 48);
    const seen = await db.enginePulse.findFirst({
      where: { engineId: "mail-relay", pulseRef },
      select: { id: true },
    });
    if (seen) {
      return NextResponse.json({ ok: true, duplicate: true, note: "messageId already ingested" });
    }

    const match = await matchProspectByEmail(sender.address);
    if (!match) {
      const replyId = await recordUnmatchedReply({
        fromEmail: sender.address,
        subject: envelope.subject ?? null,
        body: envelope.text,
        messageId: envelope.messageId ?? null,
        receivedAt: envelope.receivedAt ?? null,
      });
      await writeEnginePulse({
        engineId: "mail-relay",
        pulseRef,
        watchId: "relay_inbound",
        status: "warn",
        detail: `unmatched reply from ${sender.address} — recorded for operator link`,
      });
      return NextResponse.json({ ok: true, matched: false, replyId }, { status: 202 });
    }

    const result = await ingestReply({
      prospectId: match.prospectId,
      fromEmail: sender.address,
      subject: envelope.subject ?? null,
      body: envelope.text,
      messageId: envelope.messageId ?? null,
      receivedAt: envelope.receivedAt ?? null,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    await writeEnginePulse({
      engineId: "mail-relay",
      pulseRef,
      watchId: "relay_inbound",
      status: "ok",
      detail: `reply via ${match.via} → intent ${result.intent} (${result.action})`,
    });
    return NextResponse.json({
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
    });
  } catch (error) {
    console.error("[api/mail/inbound] failed", error);
    return NextResponse.json({ error: "inbound_ingest_failed" }, { status: 500 });
  }
}
