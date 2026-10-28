import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const rows = await db.prospect.findMany({
  select: { name: true, domainKey: true, lastIntentHeat: true, clusterId: true, scores: { take: 1, orderBy: { createdAt: "desc" }, select: { qlvScore: true, band: true } } },
  orderBy: { name: "asc" },
});
for (const r of rows) console.log(`${r.name} | key=${r.domainKey} | qlv=${r.scores[0]?.qlvScore ?? "-"} (${r.scores[0]?.band ?? "-"}) | heat=${r.lastIntentHeat} | cluster=${r.clusterId ? "yes" : "no"}`);
await db.$disconnect();
