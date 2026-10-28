import { NextResponse, type NextRequest } from 'next/server';
import { OPERATOR_SESSION_COOKIE, verifySession } from '@/lib/operator-auth';

/**
 * Operator gate — ACTIVE ONLY when OPERATOR_AUTH=1 (see .env.example).
 *
 * When enabled, the Command Tower page and its operator APIs require a
 * valid magic-link session: browser requests redirect to /?auth=required,
 * API requests answer 401. The sandbox/demo default (flag unset) keeps the
 * surface open — the auth machinery itself (magic-link, callback, logout,
 * telegram/setup) is live either way.
 */
const PROTECTED_PREFIXES = ['/backbone', '/api/telemetry/stream', '/api/hitl', '/api/team', '/api/backbone',
  // Task 23 — the unified inbox is operator state: reading every tenant
  // thread and posting to one is not an anonymous surface.
  '/api/messages'];

export async function middleware(req: NextRequest) {
  if (process.env.OPERATOR_AUTH !== '1') return NextResponse.next();

  const { pathname } = req.nextUrl;
  const hit = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!hit) return NextResponse.next();

  const session = await verifySession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/';
  url.search = '?auth=required';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/backbone', '/backbone/:path*', '/api/telemetry/stream', '/api/hitl/:path*', '/api/team/:path*', '/api/backbone/:path*', '/api/messages', '/api/messages/:path*'],
};
