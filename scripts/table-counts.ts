/** Row counts across core tables — damage assessment after the 06:42 recycle. */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const tables = ["operator", "operatorAction", "prospect", "enginePulse", "engagement", "telemetryEvent"];
  for (const t of tables) {
    try {
      const n = await (db as unknown as Record<string, { count(): Promise<number> }>)[t].count();
      console.log(`${t}: ${n}`);
    } catch (e) {
      console.log(`${t}: ERR ${(e as Error).message.slice(0, 60)}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
