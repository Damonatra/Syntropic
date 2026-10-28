import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Layer 3 portal auth primitives (pure crypto — no Next runtime imports,
 * so scripts/seed.ts can reuse the exact same hashing).
 *
 * Model: each Tenant carries an access code (hashed at rest). A successful
 * login issues an HMAC-signed session token stored in an HttpOnly cookie
 * scoped to path=/portal — so the Command Tower's cross-tenant APIs
 * (/api/*) never see portal credentials and remain internal.
 */

export const SESSION_COOKIE = 'enclave_session';
export const SESSION_PATH = '/portal';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SECRET = process.env.PORTAL_AUTH_SECRET || 'backbone-dev-secret-change-me';
export const CODE_SALT = 'syntropic-enclave-v1';

export function hashCode(plain: string): string {
  return createHash('sha256').update(CODE_SALT + plain).digest('hex');
}

/** HMAC-signed token: base64url(payload).base64url(sig), payload = {t, e, exp}.
 *  `epoch` binds the token to Tenant.sessionEpoch — rotating or revoking an
 *  invite bumps the epoch and instantly invalidates every live session. */
export function signSession(tenantName: string, epoch: number, ttlMs = SESSION_TTL_MS): string {
  const payload = Buffer.from(
    JSON.stringify({ t: tenantName, e: epoch, exp: Date.now() + ttlMs }),
  ).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Returns { tenant, epoch } for a valid, unexpired token — else null.
 *  Callers must still check epoch against the tenant's current value. */
export function verifySession(token: string | null | undefined): { tenant: string; epoch: number } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      t?: string;
      e?: number;
      exp?: number;
    };
    if (!parsed.t || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    if (typeof parsed.e !== 'number') return null; // pre-epoch tokens are invalid
    return { tenant: parsed.t, epoch: parsed.e };
  } catch {
    return null;
  }
}
