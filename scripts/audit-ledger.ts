/** Ledger audit — is the turnaround engine actually beating and moving metal? */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const pulses = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT engineId, watchId, status, substr(detail,1,90) AS detail, datetime(at) AS at FROM EnginePulse ORDER BY at DESC LIMIT 12",
  );
  console.log("=== engine pulses (newest 12) ===");
  for (const p of pulses) console.log(`${p.at} [${p.status}] ${p.engineId}/${p.watchId} — ${p.detail}`);
  const [{ c: total }] = await db.$queryRawUnsafe<Array<{ c: number }>>("SELECT COUNT(*) c FROM EnginePulse");
  console.log(`total pulses: ${total}`);

  const events = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT kind, substr(detail,1,100) AS detail, datetime(createdAt) AS at FROM EngagementEvent WHERE actor='engine' ORDER BY createdAt DESC LIMIT 12",
  );
  console.log("\n=== engine stage moves / renders (newest 12) ===");
  for (const e of events) console.log(`${e.at} ${e.kind} — ${e.detail}`);
  const [{ c: evTotal }] = await db.$queryRawUnsafe<Array<{ c: number }>>(
    "SELECT COUNT(*) c FROM EngagementEvent WHERE actor='engine'",
  );
  console.log(`total engine events: ${evTotal}`);

  const stages = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT status, COUNT(*) c FROM Engagement GROUP BY status ORDER BY c DESC",
  );
  console.log("\n=== engagement stages ===");
  for (const s of stages) console.log(`${s.status}: ${s.c}`);

  const rendered = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT ref, status, amountUsd FROM Engagement WHERE deliverableUrl IS NOT NULL",
  );
  console.log("\n=== rendered deliverables ===");
  for (const r of rendered) console.log(`${r.ref} · ${r.status} · $${r.amountUsd}`);

  const newest = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT engineId, watchId, status, at FROM EnginePulse ORDER BY at DESC LIMIT 6",
  );
  console.log("\n=== newest pulse timestamps ===");
  for (const r of newest) console.log(`${(r.at as Date).toISOString()} ${r.engineId}/${r.watchId} [${r.status}]`);
  const nowRow = await db.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT datetime('now') AS now");
  console.log(`db now: ${(nowRow[0] as Record<string, unknown>).now}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
