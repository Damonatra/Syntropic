import { NextResponse } from 'next/server';
import { OPERATOR_SESSION_COOKIE } from '@/lib/operator-auth';

export const dynamic = 'force-dynamic';

/** POST /api/auth/logout — clears the operator session cookie. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(OPERATOR_SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
