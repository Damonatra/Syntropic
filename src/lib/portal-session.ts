import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { SESSION_COOKIE, verifySession } from '@/lib/portal-auth';
import type { Tenant } from '@prisma/client';

/**
 * Server-side session resolution for the portal surface.
 *
 * The session cookie is resolved to a live Tenant row and the token's epoch
 * is checked against Tenant.sessionEpoch — issuing or revoking an invite
 * bumps the epoch, so rotated/revoked codes invalidate every live session
 * within one request (no waiting for TTL).
 *
 * Returns null for: missing/expired/garbled cookie, unknown tenant, or
 * epoch mismatch — callers answer 401 and the portal client re-logins.
 */
export async function sessionTenant(): Promise<Tenant | null> {
  await ensureDb();
  const store = await cookies();
  const session = verifySession(store.get(SESSION_COOKIE)?.value);
  if (!session) return null;

  const tenant = await db.tenant.findUnique({ where: { name: session.tenant } });
  if (!tenant || tenant.sessionEpoch !== session.epoch) return null;
  return tenant;
}
