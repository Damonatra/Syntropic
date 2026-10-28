import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const rows = await db.ledgerEntry.findMany({ where: { kind: 'MARGIN_DEFENDED' }, orderBy: { createdAt: 'desc' }, take: 4 });
for (const r of rows) console.log(r.createdAt.toISOString().slice(5, 16), r.tenantName?.slice(0, 12), (r.amountCents / 100).toFixed(2), '|', (r.note ?? '').slice(0, 60));
await db.$disconnect();
