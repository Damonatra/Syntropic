/**
 * Quick DB inspection / fixture helper for M4+M6 verification.
 * Usage: bun scripts/db_query.ts <query-key> [args]
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const key = process.argv[2] ?? "prospects";

async function main() {
  if (key === "prospects") {
    const rows = await db.prospect.findMany({
      where: { bestEmail: { not: null } },
      select: { id: true, name: true, country: true, region: true, caslScope: true, bestEmail: true },
      take: 8,
    });
    console.log(JSON.stringify(rows, null, 1));
  } else if (key === "ca_no_consent") {
    const rows = await db.prospect.findMany({
      where: { country: { contains: "Canada" }, caslScope: false },
      select: { id: true, name: true, country: true, caslScope: true },
    });
    console.log(JSON.stringify(rows, null, 1));
  } else if (key === "flip_casl") {
    const id = process.argv[3];
    await db.prospect.update({ where: { id }, data: { caslScope: false } });
    console.log("flipped", id);
  } else if (key === "restore_casl") {
    const id = process.argv[3];
    await db.prospect.update({ where: { id }, data: { caslScope: true } });
    console.log("restored", id);
  } else if (key === "suppress") {
    const [email, prospectId] = [process.argv[3], process.argv[4]];
    const row = await db.suppressionRecord.create({ data: { email: email.toLowerCase(), prospectId, reason: "manual_test" } });
    console.log("suppressed", row.id);
  } else if (key === "unsuppress") {
    await db.suppressionRecord.deleteMany({ where: { reason: "manual_test" } });
    console.log("cleaned");
  } else if (key === "dispatches") {
    const rows = await db.dispatch.findMany({
      where: { channel: "operator_manual_email" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, prospectId: true, status: true, subject: true, provider: true, error: true, createdAt: true },
    });
    console.log(JSON.stringify(rows, null, 1));
  } else if (key === "actions") {
    const rows = await db.operatorAction.findMany({
      where: { action: "emailed" },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    console.log(JSON.stringify(rows, null, 1));
  } else if (key === "cleanup") {
    const d = await db.dispatch.deleteMany({ where: { channel: "operator_manual_email" } });
    const a = await db.operatorAction.deleteMany({ where: { action: "emailed" } });
    console.log("cleaned", d.count, a.count);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
