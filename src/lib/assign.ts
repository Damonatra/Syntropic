import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';

/**
 * Least-loaded founder assignment for inbound intake.
 *
 * Load = open tenants currently assigned to the founder (the live book of
 * accounts they must personally run the 48-hour audit loop for), tie-broken
 * by lifetime audits closed so the heavier closer absorbs the next account.
 * Offline members are only considered when nobody is online — intake must
 * never fail for want of an owner.
 */
export async function assignFounder() {
  await ensureDb();
  const online = await db.teamMember.findMany({ where: { isOnline: true }, orderBy: { sortOrder: 'asc' } });
  const pool = online.length ? online : await db.teamMember.findMany({ orderBy: { sortOrder: 'asc' } });
  if (!pool.length) throw new Error('No TeamMembers seeded — run `bun run scripts/seed.ts`');

  const active = await db.tenant.groupBy({
    by: ['assignedToId'],
    _count: { _all: true },
    where: { assignedToId: { in: pool.map((m) => m.id) }, paymentStatus: { not: 'PAID' } },
  });
  const load = new Map(active.map((a) => [a.assignedToId, a._count._all]));
  return pool.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.auditsClosed - b.auditsClosed)[0];
}
