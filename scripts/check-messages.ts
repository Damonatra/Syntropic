import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  const rows = await db.message.findMany({
    where: { tenantName: 'Apex Piping & Supply' },
    orderBy: { createdAt: 'asc' },
  });
  for (const m of rows) {
    console.log(
      m.sender.slice(0, 22).padEnd(24),
      '| unread:', m.unread,
      '| readAt:', m.readAt ? m.readAt.toISOString() : null,
      '|', m.text.slice(0, 44),
    );
  }
  await db.$disconnect();
}

main();
