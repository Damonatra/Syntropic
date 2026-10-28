import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { isOperator, OPERATOR_SESSION_COOKIE, OPERATOR_SESSION_TTL_MS, signSession, hashToken } from '@/lib/operator-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/callback?token=… — consumes a single-use operator magic
 * link: the token row must be unexpired and unused, and its email must
 * still be in OPERATOR_EMAILS. Success sets the HttpOnly operator session
 * cookie (7 days) and redirects to /backbone; anything else redirects to
 * /?auth=expired with no cookie.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get('token') ?? '';

  let email: string | null = null;
  if (raw) {
    await ensureDb();
    const row = await db.magicLinkToken.findUnique({ where: { tokenHash: await hashToken(raw) } });
    if (row && !row.usedAt && row.expiresAt > new Date() && row.scope === 'operator' && isOperator(row.email)) {
      await db.magicLinkToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
      email = row.email;
    }
  }

  if (!email) return NextResponse.redirect(new URL('/?auth=expired', url.origin));

  const res = NextResponse.redirect(new URL('/backbone', url.origin));
  res.cookies.set(OPERATOR_SESSION_COOKIE, await signSession(email), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(OPERATOR_SESSION_TTL_MS / 1000),
  });
  return res;
}
