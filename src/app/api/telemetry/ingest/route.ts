/**
 * POST /api/telemetry/ingest — Module 8 production intake.
 *
 * The Python engine (vertebra/telemetry/intent_tracker.py) posts portal
 * telemetry here. The ledger semantics live in portal-events.ts (shared
 * with the /l/<token> doors): event row, intent-heat bump, snapshot
 * invalidation, and the hour-deduped HIGH-INTENT alert — paged to the
 * operator's channels — when a high-signal event lands on QLV >= 85.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { guardWrite } from "@/lib/vertebra/guard";
import { recordPortalEvent } from "@/lib/vertebra/portal-events";

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

export async function POST(request: Request) {
  const denied = guardWrite(request, "telemetry/ingest", { limit: 60, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const json = await request.json();
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_payload", issues: parsed.error.issues }, { status: 400 });
    }
    const body = parsed.data;

    // Resolve the prospect filter first — a payload naming no prospect is
    // unresolvable (404), never an unfiltered scan and never a null where.
    const where = body.prospectId
      ? { id: body.prospectId }
      : body.domainKey
        ? { OR: [{ domainKey: body.domainKey }, { domain: body.domainKey }] }
        : undefined;
    if (!where) {
      return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });
    }
    const prospect = await db.prospect.findFirst({
      where,
      include: { scores: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!prospect) {
      return NextResponse.json({ error: "prospect_not_found" }, { status: 404 });
    }

    const outcome = await recordPortalEvent({
      prospectId: prospect.id,
      eventType: body.eventType,
      url: body.url ?? null,
      referrer: body.referrer ?? null,
      userAgent: body.userAgent ?? null,
      sessionId: body.sessionId ?? null,
      source: "ingest",
      city: body.city ?? null,
      country: body.country ?? null,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      device: body.device ?? null,
      durationMs: body.durationMs ?? null,
      payload: body.payload ?? null,
    });

    return NextResponse.json({
      ok: true,
      event: { id: outcome.eventId, eventType: outcome.eventType, occurredAt: outcome.occurredAt },
      prospect: { id: prospect.id, name: prospect.name, qlvScore: prospect.scores[0]?.qlvScore ?? 0, lastIntentHeat: outcome.heat },
      alert: outcome.alert,
    });
  } catch (error) {
    console.error("[api/telemetry/ingest] failed", error);
    return NextResponse.json({ error: "ingest_failed" }, { status: 500 });
  }
}
