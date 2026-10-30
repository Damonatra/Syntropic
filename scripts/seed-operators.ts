/**
 * Seed per-operator enclave accounts.
 *
 * Usage:
 *   npx tsx scripts/seed-operators.ts --josias '<password>' --damon '<password>'
 *   (or env: JOSIAS_PASSWORD / DAMON_PASSWORD)
 *
 * Passwords are hashed with scrypt and upserted into the Operator table —
 * plaintext is never persisted anywhere. Idempotent: re-running rotates the
 * hash (and only the hash) for an existing operator; displayName is preserved
 * on update so renames stay deliberate.
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword, normalizeUsername, OPERATOR_MIN_PASSWORD_LENGTH } from "../src/lib/vertebra/operators";

const db = new PrismaClient();

interface Spec {
  username: string;
  displayName: string;
  password: string | undefined;
}

function readArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith("--") && argv[i + 1] !== undefined) {
      out[(argv[i] as string).slice(2)] = argv[i + 1] as string;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = readArgs();
  const specs: Spec[] = [
    { username: "josias", displayName: "Josias", password: args.josias ?? process.env.JOSIAS_PASSWORD },
    { username: "damon", displayName: "Damon", password: args.damon ?? process.env.DAMON_PASSWORD },
  ];

  let provisioned = 0;
  for (const s of specs) {
    if (!s.password || s.password.length < OPERATOR_MIN_PASSWORD_LENGTH) {
      console.warn(`[seed-operators] SKIP ${s.username} — no password arg/env or shorter than ${OPERATOR_MIN_PASSWORD_LENGTH} chars`);
      continue;
    }
    if (s.password !== normalizeUsername(s.password) && s.password.length > 128) {
      console.warn(`[seed-operators] SKIP ${s.username} — password absurdly long`);
      continue;
    }
    const passwordHash = await hashPassword(s.password);
    const row = await db.operator.upsert({
      where: { username: s.username },
      create: { username: s.username, displayName: s.displayName, passwordHash },
      update: { passwordHash },
    });
    provisioned++;
    console.log(`[seed-operators] ${row.username} → "${row.displayName}" hash sealed (${passwordHash.split("$").slice(0, 4).join("$")}$…)`);
  }

  if (provisioned === 0) {
    console.error("[seed-operators] nothing provisioned — pass --josias/--damon passwords or set env");
    process.exit(1);
  }
  const total = await db.operator.count();
  console.log(`[seed-operators] operator table now holds ${total} account(s)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
