/**
 * POST /api/telemetry/ingest — Module 8 production intake.
 *
 * The Python engine (vertebra/telemetry/intent_tracker.py) posts portal
 * telemetry here; the Executive Enclave's socket bridge fans it out to the
 * command centre. High-signal events on critical-band prospects (QLV >= 85)
 * raise an IntentAlert using the fixed high-intent format.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { isHighSignal } from "@/lib/vertebra/command";

const BodySchema = z.object({
  prospectId: z.string().min(1).optional(),
  domainKey: z.string().min(1).optional(),
  eventType: z.enum(["portal_visit", "audit_view", "document_download", "pricing_view", "session_end"]),
  sessionId: z.string().min(1).optional(),
  url: z.string().max(500).nullish(),
  referrer: z.string().max(500).nullish(),
  city: z.string().max(120).nullish(),
  country: z.string().max(120).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  userAgent: z.string().max(400).nullish(),
  device: z.enum(["desktop", "mobile", "tablet"]).nullish(),
  durationMs: z.number().int().min(0).max(86_400_000).nullish(),
  payload: z.record(z.string(), z.unknown()).nullish(),
});

const HEAT_BUMP: Record<string, number> = {
  portal_visit: 6,
  audit_view: 9,
  document_download: 12,
  pricing_view: 4,
  session_end: 2,
};

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const body = parsed.data;

    const prospect = await db.prospect.findFirst({
      where: body.prospectId
        ? { id: body.prospectId }
        : body.domainKey
          ? { OR: [{ domainKey: body.domainKey }, { domain: body.domainKey }] }
          : null,
      include: {
        scores: { orderBy: { createdAt: "desc" }, take: 1 },
        contacts: { take: 1 },
        cluster: true,
      },
    });
    if (!prospect) {
      return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });
    }

    const event = await db.telemetryEvent.create({
      data: {
        prospectId: prospect.id,
        sessionId: body.sessionId ?? `ingest-${Date.now().toString(36)}`,
        eventType: body.eventType,
        url: body.url ?? null,
        referrer: body.referrer ?? null,
        city: body.city ?? prospect.city,
        country: body.country ?? prospect.country,
        latitude: body.latitude ?? prospect.latitude,
        longitude: body.longitude ?? prospect.longitude,
        userAgent: body.userAgent ?? null,
        device: body.device ?? null,
        durationMs: body.durationMs ?? null,
        payloadJson: body.payload ? JSON.stringify(body.payload) : null,
      },
    });

    const bump = HEAT_BUMP[body.eventType] ?? 2;
    const heat = Math.min(100, prospect.lastIntentHeat + bump);
    await db.prospect.update({ where: { id: prospect.id }, data: { lastIntentHeat: heat } });

    const qlvScore = prospect.scores[0]?.qlvScore ?? 0;
    let alert: { id: string; title: string; body: string } | null = null;
    if (isHighSignal(body.eventType) && qlvScore >= 85) {
      const contact = prospect.contacts[0];
      const hourBucket = Math.floor(Date.now() / 3_600_000);
      const dedupeKey = `hi:${prospect.id}:${body.eventType}:${hourBucket}`;
      const existing = await db.intentAlert.findFirst({ where: { dedupeKey } });
      if (!existing) {
        const exec = contact
          ? `${contact.firstName} ${contact.lastName} (${contact.titleRaw ?? contact.role}) — ${contact.phone ?? "direct line pending"}`
          : "Primary contact pending";
        const created = await db.intentAlert.create({
          data: {
            prospectId: prospect.id,
            title: "HIGH-INTENT PROSPECT ON PORTAL",
            body: [
              `Company: ${prospect.name}`,
              `Executive: ${exec}`,
              `Location: ${prospect.city ?? "unknown"}, ${prospect.country ?? "unknown"}`,
              `Action: Call direct line immediately.`,
            ].join("\n"),
            dedupeKey,
            channelsAttempted: JSON.stringify(["in_app", "telegram", "slack"]),
            channelsDelivered: JSON.stringify(["in_app"]),
            delivered: true,
          },
        });
        alert = { id: created.id, title: created.title, body: created.body };
      }
    }

    return NextResponse.json({
      ok: true,
      event: { id: event.id, eventType: event.eventType, occurredAt: event.occurredAt.toISOString() },
      prospect: { id: prospect.id, name: prospect.name, qlvScore, lastIntentHeat: heat },
      alert,
    });
  } catch (error) {
    console.error("[api/telemetry/ingest] failed", error);
    return NextResponse.json({ error: "ingest_failed" }, { status: 500 });
  }
}
