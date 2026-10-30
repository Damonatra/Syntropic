/** Print the operator roster (no hashes — prefix only). */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const rows = await db.operator.findMany({ orderBy: { username: "asc" } });
  console.log(`operator rows: ${rows.length}`);
  for (const r of rows) {
    console.log(`- ${r.username} | "${r.displayName}" | lastLogin=${r.lastLoginAt?.toISOString() ?? "never"} | hash=${r.passwordHash.split("$").slice(0, 3).join("$")}$…`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
