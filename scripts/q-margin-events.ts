/**
 * One-off probe: MARGIN_DEFENDED ledger row grain for the enclave dot-matrix
 * upgrade — how many rows per month, per day, and their size spread.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const rows = await db.ledgerEntry.findMany({
    where: { kind: 'MARGIN_DEFENDED' },
    orderBy: { createdAt: 'asc' },
    select: { amountCents: true, createdAt: true, tenantName: true, tenantId: true },
  });
  console.log(`total MARGIN_DEFENDED rows: ${rows.length}`);
  const byMonth = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const m = r.createdAt.toISOString().slice(0, 7);
    const d = r.createdAt.toISOString().slice(0, 10);
    byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  console.log('by month:', [...byMonth.entries()].map(([m, n]) => `${m}:${n}`).join('  '));
  console.log('by day:', [...byDay.entries()].map(([d, n]) => `${d}:${n}`).join('  '));
  const sizes = rows.map((r) => r.amountCents).sort((a, b) => a - b);
  console.log('size spread (cents): min', sizes[0], 'median', sizes[Math.floor(sizes.length / 2)], 'max', sizes[sizes.length - 1]);
  const apex = await db.tenant.findFirst({ where: { name: { contains: 'Apex' } }, select: { id: true, name: true } });
  if (apex) {
    const apexRows = rows.filter((r) => r.tenantId === apex.id || r.tenantName === apex.name);
    console.log(`\nApex rows: ${apexRows.length}`);
    for (const r of apexRows) console.log(' ', r.createdAt.toISOString(), (r.amountCents / 100).toFixed(2));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
