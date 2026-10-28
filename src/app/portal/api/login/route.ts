import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { hashCode, SESSION_COOKIE, SESSION_PATH, SESSION_TTL_MS, signSession } from '@/lib/portal-auth';
import { clearFailures, clientIp, FAIL_MAX, ipGate, lockState, recordFailure } from '@/lib/rate-limit';
import { recordTraffic } from '@/lib/traffic';
import { resolveGeo } from '@/lib/geo';

export const dynamic = 'force-dynamic';

const tooMany = (retryAfterSec: number, error: string) =>
  NextResponse.json({ error }, {
    status: 429,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) },
  });

/**
 * POST /portal/api/login — { tenantName, accessCode }.
 *
 * Hardened surface:
 *  - Per-IP burst cap (30 POSTs/min) answers 429 before any DB work.
 *  - Per (tenant × IP) lockout: 5 wrong codes in 15 min → 429 for 15 min,
 *    with a SECURITY row in the Notification ledger for the Tower.
 *  - Disabled portal (accessCodeHash cleared via invite revoke) answers 403
 *    with operator guidance instead of a generic code error.
 *  - Success sets an HttpOnly session cookie scoped to path=/portal, bound
 *    to the tenant's session epoch.
 */
export async function POST(req: Request) {
  await ensureDb();

  const ip = clientIp(req);
  const burst = ipGate(ip);
  if (burst.locked) {
    return tooMany(burst.retryAfterSec, `Too many sign-in attempts — wait ${Math.ceil(burst.retryAfterSec / 60)} min and try again.`);
  }

  const body = await req.json().catch(() => null);
  const tenantName = typeof body?.tenantName === 'string' ? body.tenantName : '';
  const accessCode = typeof body?.accessCode === 'string' ? body.accessCode : '';
  if (!tenantName || !accessCode) {
    return NextResponse.json({ error: 'tenantName and accessCode are required' }, { status: 400 });
  }

  const key = `${tenantName}|${ip}`;
  const lock = lockState(key);
  if (lock.locked) {
    return tooMany(lock.retryAfterSec, `Too many failed attempts for this enclave — locked. Try again in ${Math.ceil(lock.retryAfterSec / 60)} min.`);
  }

  const tenant = await db.tenant.findUnique({ where: { name: tenantName } });

  if (!tenant) {
    recordFailure(key); // count probes at unknown tenants too — no free enumeration
    return NextResponse.json({ error: 'Access code not recognized for this enclave' }, { status: 401 });
  }

  if (!tenant.accessCodeHash) {
    return NextResponse.json(
      { error: 'Portal access is currently disabled for this enclave — ask your Syntropic operator for a fresh invite.' },
      { status: 403 },
    );
  }

  if (hashCode(accessCode) !== tenant.accessCodeHash) {
    const attempt = recordFailure(key);
    if (attempt.locked && attempt.failures === FAIL_MAX) {
      // Lock just engaged on this (5th) strike — audit it. This attempt still
      // gets its honest 401; every further request is refused at the gate.
      await db.notification.create({
        data: {
          channel: 'SECURITY',
          target: tenantName,
          text: `Login lockout — ${attempt.failures} failed access codes from ${ip}. Enclave sign-in locked for 15 minutes.`,
          payload: JSON.stringify({ tenant: tenantName, ip, failures: attempt.failures, kind: 'LOGIN_LOCKOUT' }),
          deliveryStatus: 'LOGGED',
        },
      });
    }
    return NextResponse.json({ error: 'Access code not recognized for this enclave' }, { status: 401 });
  }

  clearFailures(key);
  // Phase 11.8: edge-first geo rides along with the enclave sign-in.
  const { geo } = resolveGeo(req.headers, ip === 'local' ? null : ip);
  void recordTraffic({
    sessionId: tenant.name,
    layer: 'PORTAL',
    eventType: 'PORTAL_LOGIN',
    ip,
    tenantId: tenant.name,
    geo,
  });
  const res = NextResponse.json({
    ok: true,
    tenant: { name: tenant.name, contactName: tenant.contactName },
  });
  res.cookies.set(SESSION_COOKIE, signSession(tenant.name, tenant.sessionEpoch), {
    httpOnly: true,
    sameSite: 'lax',
    path: SESSION_PATH,
    maxAge: SESSION_TTL_MS / 1000,
  });
  return res;
}
