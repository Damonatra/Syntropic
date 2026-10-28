import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const ts = await db.tenant.findMany({ select: { name: true, mailboxStatus: true } });
for (const t of ts) console.log(t.mailboxStatus, '|', t.name);
await db.$disconnect();
