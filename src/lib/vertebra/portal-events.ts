/**
 * Portal telemetry — the one recorder for prospect-side events.
 *
 * Every door that learns a prospect touched the funnel (the Python engine's
 * ingest API, the per-prospect landing page, the sealed-audit delivery)
 * funnels through here so the ledger semantics exist exactly once:
 * an event row, an intent-heat bump, a snapshot invalidation, and — when a
 * high-signal event lands on a critical-band prospect (QLV >= 85) — the
 * hour-deduped HIGH-INTENT alert fanned out to the operator's pagers.
 *
 * Fire-and-forget at the call site: this function never throws into a
 * render path — callers wrap or void() it.
 */
import { db } from "@/lib/db";
import { isHighSignal } from "@/lib/vertebra/command";
import { invalidateSnapshot } from "@/lib/vertebra/snapshot-cache";
import { deliverAlert } from "@/lib/vertebra/pager";

export type PortalEventType = "portal_visit" | "audit_view" | "document_download" | "pricing_view" | "session_end";

export const HEAT_BUMP: Record<PortalEventType, number> = {
  portal_visit: 6,
  audit_view: 9,
  document_download: 12,
  pricing_view: 4,
  session_end: 2,
};

export interface PortalEventInput {
  prospectId: string;
  eventType: PortalEventType;
  url?: string | null;
  referrer?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  /** provenance — which door recorded it ("landing" | "audit" | "ingest") */
  source?: string;
  payload?: Record<string, unknown> | null;
  /** ingest-API overrides — the engine may geo-resolve better than the ledger */
  city?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  device?: "desktop" | "mobile" | "tablet" | null;
  durationMs?: number | null;
}

export interface PortalEventOutcome {
  eventId: string;
  eventType: string;
  occurredAt: string;
  heat: number;
  alert: { id: string; title: string; body: string } | null;
}

export async function recordPortalEvent(input: PortalEventInput): Promise<PortalEventOutcome> {
  const prospect = await db.prospect.findUnique({
    where: { id: input.prospectId },
    include: {
      scores: { orderBy: { createdAt: "desc" }, take: 1 },
      contacts: { take: 1 },
    },
  });
  if (!prospect) throw new Error(`portal_event_prospect_missing: ${input.prospectId}`);

  const event = await db.telemetryEvent.create({
    data: {
      prospectId: prospect.id,
      sessionId: input.sessionId ?? `door-${Date.now().toString(36)}`,
      eventType: input.eventType,
      url: input.url ?? null,
      referrer: input.referrer ?? null,
      city: input.city ?? prospect.city,
      country: input.country ?? prospect.country,
      latitude: input.latitude ?? prospect.latitude,
      longitude: input.longitude ?? prospect.longitude,
      userAgent: input.userAgent ?? null,
      device: input.device ?? null,
      durationMs: input.durationMs ?? null,
      payloadJson: input.payload ? JSON.stringify({ ...input.payload, door: input.source ?? "ingest" }) : null,
    },
  });

  const heat = Math.min(100, prospect.lastIntentHeat + (HEAT_BUMP[input.eventType] ?? 2));
  await db.prospect.update({ where: { id: prospect.id }, data: { lastIntentHeat: heat } });
  invalidateSnapshot();

  const qlvScore = prospect.scores[0]?.qlvScore ?? 0;
  let alert: PortalEventOutcome["alert"] = null;
  if (isHighSignal(input.eventType) && qlvScore >= 85) {
    const contact = prospect.contacts[0];
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    const dedupeKey = `hi:${prospect.id}:${input.eventType}:${hourBucket}`;
    const existing = await db.intentAlert.findFirst({ where: { dedupeKey } });
    if (!existing) {
      const exec = contact
        ? `${contact.firstName} ${contact.lastName} (${contact.titleRaw ?? contact.role}) — ${contact.phone ?? "direct line pending"}`
        : "Primary contact pending";
      const alertBody = [
        `Company: ${prospect.name}`,
        `Executive: ${exec}`,
        `Location: ${prospect.city ?? "unknown"}, ${prospect.country ?? "unknown"}`,
        `Action: Call direct line immediately.`,
      ].join("\n");
      const pager = await deliverAlert("HIGH-INTENT PROSPECT ON PORTAL", alertBody);
      const created = await db.intentAlert.create({
        data: {
          prospectId: prospect.id,
          title: "HIGH-INTENT PROSPECT ON PORTAL",
          body: alertBody,
          dedupeKey,
          channelsAttempted: JSON.stringify(["in_app", ...pager.attempted]),
          channelsDelivered: JSON.stringify(["in_app", ...pager.delivered]),
          delivered: true,
        },
      });
      alert = { id: created.id, title: created.title, body: created.body };
    }
  }

  return { eventId: event.id, eventType: event.eventType, occurredAt: event.occurredAt.toISOString(), heat, alert };
}
