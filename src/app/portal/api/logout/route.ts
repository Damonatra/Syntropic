import { NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_PATH } from '@/lib/portal-auth';

export const dynamic = 'force-dynamic';

/** POST /portal/api/logout — clears the enclave session cookie. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: SESSION_PATH, maxAge: 0 });
  return res;
}
