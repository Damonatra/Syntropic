import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const rows = await db.prospect.findMany({
  select: { id: true, name: true, city: true, stateProvince: true, country: true, region: true, latitude: true, longitude: true, clusterId: true },
  orderBy: { createdAt: "asc" },
});
console.log(JSON.stringify(rows, null, 1));
await db.$disconnect();
