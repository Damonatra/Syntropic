import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { utcDay } from '@/lib/traffic';

export const dynamic = 'force-dynamic';

/**
 * GET /api/backbone/geo — GEO-IP intelligence slice (Phase 11.9).
 *
 * Every figure is derived server-side from the TrafficEvent ledger for the
 * current UTC day — nothing hardcoded:
 *
 *   1 · PRIMARY HUB        — the city carrying the most LANDING events today,
 *                            with its share of geo-resolved landing traffic.
 *   2 · ACTIVE ENCLAVE HUB — cities of actively-served tenants (paid audit or
 *                            discovery-stage), each mapped to its latest
 *                            enclave traffic row; carries the pending HITL
 *                            review count per city.
 *   3 · EMERGING CORRIDOR  — the newest high-intent signal (intake, deposit,
 *                            payment, upload, portal login) from any city
 *                            OTHER than the primary hub.
 *   4 · TOP LOCATIONS      — today's five busiest geo-resolved cities.
 *
 * Operator-gated by src/middleware.ts when OPERATOR_AUTH=1.
 */
export async function GET() {
  await ensureDb();
  const since = new Date(`${utcDay()}T00:00:00.000Z`);

  // ── 1 · PRIMARY HUB ─────────────────────────────────────────────
  const landing = await db.trafficEvent.groupBy({
    by: ['city', 'country'],
    _count: { _all: true },
    where: { layer: 'LANDING', createdAt: { gte: since }, city: { not: null } },
    orderBy: { _count: { city: 'desc' } },
    take: 1,
  });
  const landingTotal = await db.trafficEvent.count({
    where: { layer: 'LANDING', createdAt: { gte: since }, city: { not: null } },
  });
  const primary = landing[0]
    ? {
        city: landing[0].city,
        country: landing[0].country,
        share: landingTotal ? Math.round((landing[0]._count._all / landingTotal) * 100) : 0,
        events: landing[0]._count._all,
      }
    : null;

  // ── 2 · ACTIVE ENCLAVE HUB ──────────────────────────────────────
  // Our ledger keeps pipeline labels as display strings; "actively served"
  // maps to a paid audit (live enclave) or an open discovery track.
  const activeTenants = await db.tenant.findMany({
    where: {
      OR: [{ paymentStatus: 'PAID' }, { status: { contains: 'Discovery' } }],
    },
    select: { name: true },
  });
  const tenantNames = activeTenants.map((t) => t.name);
  // HITL links by tenant name in this ledger — group pending reviews per city.
  const pendingByTenant = await db.hitlItem.groupBy({
    by: ['tenantName'],
    _count: { _all: true },
    where: { status: 'PENDING', tenantName: { in: tenantNames } },
  });
  const reviewsFor = (name: string) =>
    pendingByTenant.find((p) => p.tenantName === name)?._count._all ?? 0;
  const latestPerTenant = tenantNames.length
    ? await db.trafficEvent.findMany({
        where: { tenantId: { in: tenantNames }, city: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { tenantId: true, city: true, country: true },
      })
    : [];
  const tenantCity = new Map<string, string>();
  for (const e of latestPerTenant) {
    if (e.tenantId && !tenantCity.has(e.tenantId)) tenantCity.set(e.tenantId, `${e.city}|${e.country}`);
  }
  const enclaveByCity = new Map<string, { city: string; country: string; tenants: number; reviews: number }>();
  for (const t of activeTenants) {
    const key = tenantCity.get(t.name);
    if (!key) continue;
    const [city, country] = key.split('|');
    const cur = enclaveByCity.get(key) ?? { city, country, tenants: 0, reviews: 0 };
    cur.tenants += 1;
    cur.reviews += reviewsFor(t.name);
    enclaveByCity.set(key, cur);
  }
  const enclaveHub = [...enclaveByCity.values()].sort((a, b) => b.tenants - a.tenants)[0] ?? null;

  // ── 3 · EMERGING CORRIDOR ───────────────────────────────────────
  const intents = await db.trafficEvent.findMany({
    where: {
      createdAt: { gte: since },
      city: { not: null },
      eventType: {
        in: ['INTAKE_SUBMITTED', 'DEPOSIT_CLICKED', 'PAYMENT_SUCCESS', 'FILE_UPLOAD', 'AUDIT_SUBMITTED', 'PORTAL_LOGIN'],
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { city: true, country: true, eventType: true },
  });
  let emerging: { city: string; country: string; lastEventType: string } | null = null;
  for (const e of intents) {
    if (!primary || `${e.city}|${e.country}` !== `${primary.city}|${primary.country}`) {
      emerging = { city: e.city!, country: e.country!, lastEventType: e.eventType };
      break;
    }
  }

  // ── 4 · TOP LOCATIONS ───────────────────────────────────────────
  const top = await db.trafficEvent.groupBy({
    by: ['city', 'country'],
    _count: { _all: true },
    where: { createdAt: { gte: since }, city: { not: null } },
    orderBy: { _count: { city: 'desc' } },
    take: 5,
  });

  return NextResponse.json({
    primary,
    enclaveHub,
    emerging,
    topLocations: top.map((r) => ({ city: r.city, country: r.country, events: r._count._all })),
    generatedAt: new Date().toISOString(),
  });
}
