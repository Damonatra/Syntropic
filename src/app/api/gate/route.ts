/**
 * POST /api/gate — exchange the enclave password for a session cookie.
 * Rate-limited brute-force surface; only meaningful when ENCLAVE_PASSWORD is set.
 */
import { NextResponse } from "next/server";
import { sessionCookieFor, SESSION_COOKIE } from "@/lib/vertebra/session";
import { guardWrite } from "@/lib/vertebra/guard";

export async function POST(request: Request) {
  const denied = guardWrite(request, "gate", { key: false, limit: 8, windowMs: 60_000 });
  if (denied) return denied;

  if (!process.env.ENCLAVE_PASSWORD) {
    return NextResponse.json({ ok: true, gated: false });
  }
  let password = "";
  try {
    const body = (await request.json()) as { password?: string };
    password = body.password ?? "";
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const value = await sessionCookieFor(password);
  if (!value) {
    return NextResponse.json({ error: "bad_password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, gated: true });
  res.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
