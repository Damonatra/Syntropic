/**
 * Housekeeping — prune heartbeat verification artifacts.
 *
 * The heartbeat_verify.sh contract test wrote two pulses with refs
 * verify-run-001/002 on watchIds (parse_queue, pdf_render) that no real
 * engine watches. The silence watch keys on (engineId, watchId), so those
 * test rows would ring engine_silent crit forever. They are test fixtures,
 * not telemetry — the append-only law belongs to EngagementEvent, not here.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT pulseRef, watchId, status, at FROM EnginePulse ORDER BY at DESC",
  );
  console.log("pulses before:", rows.length);
  for (const r of rows) console.log(" ", r.pulseRef, r.watchId, r.status, r.at);
  const res = await db.$executeRawUnsafe(`DELETE FROM EnginePulse WHERE pulseRef LIKE 'verify-run-%'`);
  console.log("deleted:", res);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
