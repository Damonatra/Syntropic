/**
 * Enclave gate middleware — active only when ENCLAVE_PASSWORD is configured.
 * Unauthenticated traffic is redirected to /gate; the unsubscribe endpoint
 * stays public regardless (CASL requires the one-click link to always work).
 */
import { NextRequest, NextResponse } from "next/server";
import { checkSessionCookie, SESSION_COOKIE } from "@/lib/vertebra/session";

export async function middleware(request: NextRequest) {
  const passwordSet = Boolean(process.env.ENCLAVE_PASSWORD);
  if (!passwordSet) return NextResponse.next();

  const { pathname } = request.nextUrl;
  // /api/ops/heartbeat authenticates itself — the route's own timing-safe
  // HMAC check against OPS_HEARTBEAT_SECRET IS the auth (engines can't hold
  // browser sessions). The gate must not stand in front of the engine door;
  // an unsigned request there still gets 401, from the signature check.
  const alwaysPublic = ["/gate", "/api/gate", "/api/unsubscribe", "/api/health", "/api/ops/heartbeat"];
  if (alwaysPublic.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (await checkSessionCookie(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized", hint: "session required" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/gate";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
