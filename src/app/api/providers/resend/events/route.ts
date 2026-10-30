/**
 * POST /api/providers/resend/events — the egress feedback loop.
 *
 * Resend reports what happened to the mail that left the building (sent,
 * delivered, opened, bounced, complained) as Svix-signed webhooks. The
 * enclave was blind to all of it until now: bounces decayed the sending
 * domains silently, complaints never reached the suppression ledger.
 *
 *   1. Svix verify against RESEND_WEBHOOK_SECRET (5-min replay tolerance)
 *   2. dedupe on svix-id via the EnginePulse ledger (retries keep the id)
 *   3. translate the event through resolveEventEffect (lib/vertebra/
 *      resend-events.ts) — dispatch status transitions by providerMsgId,
 *      permanent bounces / complaints land in SuppressionRecord and stop
 *      the prospect's active Channel A sequences, same semantics as an
 *      unsubscribe
 *   4. pulse the watchtower (resend_events watch) so delivery health is
 *      visible on the ops deck
 *
 * Unknown event types are acknowledged and ignored — a webhook must 200.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";
import { verifySvix, parseAddressHeader } from "@/lib/vertebra/webhook-verify";
import { resolveEventEffect } from "@/lib/vertebra/resend-events";
import { writeEnginePulse } from "@/lib/vertebra/pulse";

const EventEnvelope = z.object({
  type: z.string().min(1),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().nullish(),
      to: z.array(z.string()).nullish(),
      bounce: z
        .object({
          type: z.string().nullish(),
          subType: z.string().nullish(),
          message: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

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
  const parsed = EventEnvelope.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
  }
  const evt = parsed.data;

  const effect = resolveEventEffect(evt.type, evt.data?.bounce?.type ?? null);
  if (!effect) {
    // Acknowledge-and-ignore: unknown types are real, just not ours to act on.
    return NextResponse.json({ ok: true, ignored: true, type: evt.type });
  }

  try {
    // Retry short-circuit: same svix-id never applies twice.
    const seen = await db.enginePulse.findFirst({
      where: { engineId: "resend-events", pulseRef: verdict.eventId },
      select: { id: true },
    });
    if (seen) {
      return NextResponse.json({ ok: true, duplicate: true, note: "svix-id already applied" });
    }

    const recipient = parseAddressHeader(evt.data?.to?.[0] ?? null);
    const emailId = evt.data?.email_id ?? null;

    // The dispatch that left the building — our mailer stores Resend's id
    // as providerMsgId, so the webhook's email_id is the join key.
    const dispatch = emailId ? await db.dispatch.findFirst({ where: { providerMsgId: emailId } }) : null;
    const prospectId = dispatch?.prospectId ?? null;

    let suppressed = false;
    if (effect.suppressionReason && recipient) {
      const address = recipient.address;
      const already = await db.suppressionRecord.findUnique({ where: { email: address } });
      if (!already) {
        await db.suppressionRecord.create({
          data: {
            email: address,
            prospectId,
            reason: effect.suppressionReason,
            source: "engine",
          },
        });
        suppressed = true;
      }
    }

    if (dispatch && effect.dispatchStatus) {
      const data: { status: string; error?: string } = { status: effect.dispatchStatus };
      if (effect.dispatchStatus === "failed") {
        data.error = (evt.data?.bounce?.message ?? `${evt.type} reported by provider`).slice(0, 300);
      } else if (effect.dispatchStatus === "stopped") {
        data.error = "complaint reported by provider";
      }
      const active = dispatch.status === "sent" || dispatch.status === "queued" || dispatch.status === "opened" || dispatch.status === "delivered";
      const transitionable = effect.fromStatuses.length === 0 ? true : effect.fromStatuses.includes(dispatch.status);
      if (active && transitionable) {
        await db.dispatch.update({ where: { id: dispatch.id }, data });
      }
    }

    if (effect.stopSequences && prospectId) {
      await db.dispatch.updateMany({
        where: {
          prospectId,
          channel: "channel_a_automated_email",
          status: { in: ["queued", "sent", "opened"] },
        },
        data: {
          status: "stopped",
          error: effect.suppressionReason === "complaint" ? "complaint reported by provider" : "hard bounce reported by provider",
        },
      });
    }

    await writeEnginePulse({
      engineId: "resend-events",
      pulseRef: verdict.eventId,
      watchId: "resend_events",
      status: effect.pulseStatus,
      detail: [
        evt.type,
        recipient?.address ?? "unknown-recipient",
        dispatch ? "dispatch linked" : "no dispatch row",
        suppressed ? `suppressed (${effect.suppressionReason})` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });

    invalidateSnapshot();
    return NextResponse.json({
      ok: true,
      type: evt.type,
      dispatch: dispatch ? { id: dispatch.id, from: dispatch.status, to: effect.dispatchStatus } : null,
      suppressed,
      prospectId,
    });
  } catch (error) {
    console.error("[api/providers/resend/events] failed", error);
    return NextResponse.json({ error: "event_apply_failed" }, { status: 500 });
  }
}
