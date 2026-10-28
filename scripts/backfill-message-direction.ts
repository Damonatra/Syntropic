/**
 * Task 23 — backfill Message.direction for rows written before the column
 * existed. The derivation mirrors exactly what both write paths now record:
 * the portal's session-scoped route stamps sender "Client (...)", the tower's
 * operator route stamps "(Syntropic)" or any other team identity. Rows that
 * came from the client are 'client'; everything else is 'team'.
 *
 * One-off — idempotent by construction (only touches direction-ambiguous
 * rows, and after the first pass there are none).
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const rows = await db.message.findMany({ where: { direction: 'team' }, select: { id: true, sender: true } });
  let flipped = 0;
  for (const row of rows) {
    // Only portal client messages ever used the "Client (...)" sender shape.
    if (row.sender.startsWith('Client (')) {
      await db.message.update({ where: { id: row.id }, data: { direction: 'client' } });
      flipped += 1;
    }
  }
  const counts = await db.message.groupBy({ by: ['direction'], _count: { direction: true } });
  console.log(`[backfill-message-direction] scanned ${rows.length} team-flagged rows → ${flipped} flipped to client`);
  for (const c of counts) console.log(`  ${c.direction}: ${c._count.direction}`);
  if (counts.some((c) => c.direction !== 'team' && c.direction !== 'client')) {
    console.error('  !! unexpected direction value present');
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
