/**
 * One-off E2E helper: mint a valid enclave session cookie for a tenant using
 * the project's own signing primitives (same HMAC, same secret resolution as
 * the dev server). Prints the cookie header ready for curl / agent-browser.
 */
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const SECRET = process.env.PORTAL_AUTH_SECRET || 'backbone-dev-secret-change-me';
const tenantName = process.argv[2] ?? 'Apex Piping & Supply';

const db = new PrismaClient();
const tenant = await db.tenant.findUnique({ where: { name: tenantName } });
if (!tenant) {
  console.error(`tenant not found: ${tenantName}`);
  process.exit(1);
}
const payload = Buffer.from(
  JSON.stringify({ t: tenant.name, e: tenant.sessionEpoch, exp: Date.now() + 7 * 24 * 3600 * 1000 }),
).toString('base64url');
const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
console.log(`enclave_session=${payload}.${sig}`);
await db.$disconnect();
