import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { emit } from '@/lib/bus';
import { sanitizeIp } from '@/lib/geo';

/**
 * Traffic funnel analytics (privacy-first).
 *
 * Every capture writes an immutable TrafficEvent plus upserts the day's
 * LiveTelemetrySummary row in one transaction. Raw IPs are NEVER stored —
 * only sha256(ip | salt | epoch-day), where the salt rotates every
 * IP_HASH_SALT_ROTATE_DAYS (default 30) so long-term tracking is not
 * possible even for the operator.
 *
 * Layers: LANDING (marketing surface) → PORTAL (client enclave) → ENGINE
 * (payment/parsing milestones). Failures are non-fatal by design: a broken
 * analytics write must never take down a client action.
 */

export const TRAFFIC_LAYERS = ['LANDING', 'PORTAL', 'ENGINE'] as const;
export type TrafficLayer = (typeof TRAFFIC_LAYERS)[number];

export type TrafficEventType =
  | 'PAGE_VIEW'
  | 'SLIDER_CHANGE'
  | 'CTA_CLICK'
  | 'SCROLL_DEPTH'
  | 'INTAKE_SUBMITTED'
  | 'DEPOSIT_CLICKED'
  | 'PAYMENT_SUCCESS'
  | 'CALL_BOOKED'
  | 'PORTAL_LOGIN'
  | 'FILE_UPLOAD'
  | 'AUDIT_SUBMITTED'
  | 'BRIEFING_ATTENDED'
  | 'CONVERSION_RECORDED';

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

function daySalt(): string {
  const days = Math.max(1, Number(process.env.IP_HASH_SALT_ROTATE_DAYS ?? 30) || 30);
  const epoch = Math.floor(Date.now() / (days * 86_400e3));
  return `${process.env.IP_HASH_SALT_BASE ?? 'dev-salt'}:${epoch}`;
}

export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${ip}|${daySalt()}`).digest('hex');
}

export async function recordTraffic(input: {
  sessionId: string;
  layer: TrafficLayer;
  eventType: TrafficEventType;
  ip: string | null;
  tenantId?: string | null;
  metadata?: Record<string, unknown>;
  geo?: { city: string | null; country: string | null };
}): Promise<void> {
  try {
    await ensureDb();
    const day = utcDay();
    await db.$transaction([
      db.trafficEvent.create({
        data: {
          sessionId: input.sessionId,
          tenantId: input.tenantId ?? null,
          layer: input.layer,
          eventType: input.eventType,
          ipHash: hashIp(input.ip),
          ipAddress: sanitizeIp(input.ip),
          city: input.geo?.city ?? null,
          country: input.geo?.country ?? null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        },
      }),
      db.liveTelemetrySummary.upsert({
        where: { date: day },
        create: { date: day, totalVisitors: 1 },
        update: { totalVisitors: { increment: 1 } },
      }),
    ]);
    await syncSessions(day);
    if (input.eventType === 'INTAKE_SUBMITTED') await bump(day, 'auditsInitiated');
    if (input.eventType === 'PORTAL_LOGIN') await bump(day, 'portalLogins');
    if (input.eventType === 'FILE_UPLOAD') await bump(day, 'quotesIngested');
    // Live geo push (Phase 11.9): surface-side traffic feeds the
    // Inbound Industrial Hubs deck panel over the SSE stream.
    if (input.layer === 'LANDING' || input.layer === 'PORTAL') {
      emit({
        type: 'traffic',
        city: input.geo?.city ?? null,
        country: input.geo?.country ?? null,
        eventType: input.eventType,
      });
    }
  } catch (e) {
    console.error('[traffic] capture failed (non-fatal):', e);
  }
}

/** Keeps the day's uniqueSessions honest without waiting for recomputeDay —
 *  one indexed count per capture, trivial at this event rate. */
async function syncSessions(date: string) {
  const rows = await db.trafficEvent.findMany({
    where: {
      createdAt: { gte: new Date(`${date}T00:00:00.000Z`), lt: new Date(`${date}T23:59:59.999Z`) },
    },
    select: { sessionId: true },
  });
  await db.liveTelemetrySummary.updateMany({
    where: { date },
    data: { uniqueSessions: new Set(rows.map((r) => r.sessionId)).size },
  });
}

async function bump(date: string, field: 'auditsInitiated' | 'portalLogins' | 'quotesIngested') {
  try {
    await db.liveTelemetrySummary.update({ where: { date }, data: { [field]: { increment: 1 } } });
  } catch {
    // Summary row vanished — the next recomputeDay heals it from TrafficEvent.
  }
}

/** Rebuild a day's visitor/session counters from the immutable event log. */
export async function recomputeDay(date = utcDay()) {
  await ensureDb();
  const events = await db.trafficEvent.findMany({
    where: {
      createdAt: { gte: new Date(`${date}T00:00:00.000Z`), lt: new Date(`${date}T23:59:59.999Z`) },
    },
    select: { sessionId: true, ipHash: true },
  });
  const summary = await db.liveTelemetrySummary.findUnique({ where: { date } });
  await db.liveTelemetrySummary.upsert({
    where: { date },
    create: {
      date,
      totalVisitors: events.length,
      uniqueSessions: new Set(events.map((e) => e.sessionId)).size,
    },
    update: {
      totalVisitors: events.length,
      uniqueSessions: new Set(events.map((e) => e.sessionId)).size,
      auditsInitiated: summary?.auditsInitiated ?? 0,
      portalLogins: summary?.portalLogins ?? 0,
      quotesIngested: summary?.quotesIngested ?? 0,
    },
  });
  return { date, totalVisitors: events.length, uniqueSessions: new Set(events.map((e) => e.sessionId)).size };
}
