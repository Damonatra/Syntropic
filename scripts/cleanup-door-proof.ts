/** Remove door-proof test pulses — verification instruments, not operational truth. */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const res = await db.$executeRawUnsafe(`DELETE FROM EnginePulse WHERE engineId = 'door-proof-engine'`);
  console.log(`removed ${res} door-proof test pulse(s)`);
  const remaining = await db.$queryRawUnsafe<Array<{ c: number }>>("SELECT COUNT(*) c FROM EnginePulse WHERE engineId = 'door-proof-engine'");
  console.log(`remaining door-proof rows: ${remaining[0]?.c ?? 0}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
