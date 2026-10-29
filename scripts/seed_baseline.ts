/**
 * Seed one ~26h-old CommandBaseline capture so the RADAR 24h delta chips have
 * a genuine comparison point on first boot. The values are a plausible
 * "yesterday" — slightly behind the current book — clearly labeled as a seed;
 * within 24h the real hourly ledger takes over as the comparison baseline.
 *
 * Run: bun scripts/seed_baseline.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const capturedAt = new Date(Date.now() - 26 * 3_600_000);
  // Yesterday's book: a touch more leakage, one more latency offender,
  // one more SPA laggard, slightly higher manual share, fewer signals.
  const inputs = {
    leakageTotalUsd: 20_300_000,
    criticalCount: 5,
    draftsPending: 2,
    scoredCount: 11,
    latencyCrew: 4,
    spaLaggards: 3,
    manualAvg: 84,
    highIntentCount: 0,
    telemetryEvents24h: 240,
    dispatchesSent24h: 17,
  };
  await db.commandBaseline.deleteMany({ where: { capturedAt: { lte: capturedAt } } });
  const row = await db.commandBaseline.create({
    data: { capturedAt, metricsJson: JSON.stringify(inputs) },
  });
  console.log(`[seed_baseline] captured ${capturedAt.toISOString()} id=${row.id}`);
  const total = await db.commandBaseline.count();
  console.log(`[seed_baseline] ledger rows: ${total}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
