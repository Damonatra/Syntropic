/**
 * Seed per-operator enclave accounts.
 *
 * Usage:
 *   npx tsx scripts/seed-operators.ts --josias '<password>' --damon '<password>'
 *   (or env: JOSIAS_PASSWORD / DAMON_PASSWORD)
 *   Roles can be (re)signed without touching credentials:
 *   npx tsx scripts/seed-operators.ts --josias-role 'Executive Lead' --damon-role 'CEO'
 *
 * Passwords are hashed with scrypt and upserted into the Operator table —
 * plaintext is never persisted anywhere. Idempotent: re-running rotates the
 * hash (and only the hash) for an existing operator; displayName is preserved
 * on update so renames stay deliberate. A role arg updates the title alone —
 * passing no password never disturbs the sealed hash.
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword, normalizeUsername, OPERATOR_MIN_PASSWORD_LENGTH } from "../src/lib/vertebra/operators";

const db = new PrismaClient();

interface Spec {
  username: string;
  displayName: string;
  password: string | undefined;
  role: string | undefined;
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
    {
      username: "josias",
      displayName: "Josias",
      password: args.josias ?? process.env.JOSIAS_PASSWORD,
      role: args["josias-role"] ?? process.env.JOSIAS_ROLE,
    },
    {
      username: "damon",
      displayName: "Damon",
      password: args.damon ?? process.env.DAMON_PASSWORD,
      role: args["damon-role"] ?? process.env.DAMON_ROLE,
    },
  ];

  let provisioned = 0;
  for (const s of specs) {
    // Password optional when only the role is being (re)signed — a role edit
    // must never force a plaintext through the CLI, and vice versa.
    const rotatePassword = Boolean(s.password);
    if (s.password && s.password.length < OPERATOR_MIN_PASSWORD_LENGTH) {
      console.warn(`[seed-operators] SKIP ${s.username} — password shorter than ${OPERATOR_MIN_PASSWORD_LENGTH} chars`);
      continue;
    }
    if (s.password && s.password !== normalizeUsername(s.password) && s.password.length > 128) {
      console.warn(`[seed-operators] SKIP ${s.username} — password absurdly long`);
      continue;
    }
    if (!rotatePassword && !s.role) {
      console.warn(`[seed-operators] SKIP ${s.username} — nothing to do (no password, no role)`);
      continue;
    }
    const passwordHash = rotatePassword ? await hashPassword(s.password as string) : undefined;
    let row;
    if (passwordHash) {
      row = await db.operator.upsert({
        where: { username: s.username },
        create: { username: s.username, displayName: s.displayName, role: s.role ?? "", passwordHash },
        update: { ...(s.role !== undefined ? { role: s.role } : {}), passwordHash },
      });
    } else {
      // Role-only pass: update in place. An operator that doesn't exist yet
      // cannot be conjured without credentials — provisioning needs a hash.
      const existing = await db.operator.findUnique({ where: { username: s.username } });
      if (!existing) {
        console.warn(`[seed-operators] SKIP ${s.username} — no account row; first provisioning requires a password`);
        continue;
      }
      row = await db.operator.update({ where: { username: s.username }, data: { role: s.role } });
    }
    provisioned++;
    const title = row.role ? ` // ${row.role}` : "";
    if (passwordHash) {
      console.log(`[seed-operators] ${row.username} → "${row.displayName}"${title} hash sealed (${passwordHash.split("$").slice(0, 4).join("$")}$…)`);
    } else {
      console.log(`[seed-operators] ${row.username} → "${row.displayName}"${title} role signed — credentials untouched`);
    }
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
