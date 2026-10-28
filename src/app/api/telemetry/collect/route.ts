import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { recordTraffic, TRAFFIC_LAYERS, type TrafficEventType } from '@/lib/traffic';
import { resolveGeo } from '@/lib/geo';

export const dynamic = 'force-dynamic';

/**
 * POST /api/telemetry/collect — public funnel-beacon intake for the landing
 * surface and portal client. Phase 11.8 final form: body is
 * { sessionId, layer, eventType, tenantId?, metadata? } — the tenant is
 * validated against the ledger before the event links to it, string metadata
 * is tolerated (JSON-decoded), and edge-first geo (Vercel/CF/Nginx headers →
 * cached provider → env fallback) rides along onto the stored row.
 * Rate-limited per IP (120 events/min); raw IPs are never persisted.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`traffic:${ip}`, 120, 60e3)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const b = (await req.json().catch(() => null)) as
    | { sessionId?: unknown; eventType?: unknown; layer?: unknown; tenantId?: unknown; metadata?: unknown }
    | null;
  if (!b?.sessionId || !b?.eventType || typeof b.sessionId !== 'string') {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  if (!TRAFFIC_LAYERS.includes(b.layer as (typeof TRAFFIC_LAYERS)[number])) {
    return NextResponse.json({ error: 'invalid_layer' }, { status: 422 });
  }

  await ensureDb();
  let tenantId: string | null = null;
  if (typeof b.tenantId === 'string' && b.tenantId.trim()) {
    const tenant = await db.tenant.findFirst({
      where: { OR: [{ name: b.tenantId.trim() }, { id: b.tenantId }] },
      select: { name: true },
    });
    tenantId = tenant?.name ?? null;
  }

  const { geo } = resolveGeo(req.headers, ip === 'local' ? null : ip);

  await recordTraffic({
    sessionId: b.sessionId.slice(0, 64),
    layer: b.layer as (typeof TRAFFIC_LAYERS)[number],
    eventType: String(b.eventType).toUpperCase() as TrafficEventType,
    ip,
    tenantId,
    geo,
    metadata:
      typeof b.metadata === 'object' && b.metadata !== null
        ? (b.metadata as Record<string, unknown>)
        : typeof b.metadata === 'string'
          ? safeParse(b.metadata)
          : undefined,
  });

  return NextResponse.json({ ok: true, geo });
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try {
    const p = JSON.parse(s);
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
