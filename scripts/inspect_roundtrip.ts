/**
 * Round-trip inspector — the engine's footprints in one view:
 * engagement stage, the ledger trail (actor-stamped), deliverable state,
 * and the EnginePulse table. Read-only.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const id = process.argv[2] ?? "cmvu6lqt30001m31nmwqwhv7w";

async function main() {
  const e = await db.engagement.findUnique({
    where: { id },
    include: { events: { orderBy: { createdAt: "asc" } } },
  });
  if (!e) return console.log("engagement not found");
  console.log(`── ${e.ref} ── status ${e.status} · deliverable ${e.deliverableUrl ?? "—"}`);
  for (const ev of e.events) {
    console.log(`  [${ev.actor.padEnd(7)}] ${ev.kind} · ${ev.detail}`);
  }
  const pulses = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "SELECT watchId, status, detail, expectEveryMs, at FROM EnginePulse WHERE engineId = 'turnaround-core' ORDER BY at DESC LIMIT 8",
  );
  console.log("── pulses (newest first) ──");
  for (const p of pulses) console.log(`  ${p.watchId} · ${p.status} · ${p.detail}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
