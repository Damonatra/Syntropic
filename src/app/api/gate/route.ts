/**
 * The enclave door — per-operator accounts.
 *
 * GET    /api/gate → { gate, operators: [{ username, displayName }], operator? }
 *                    roster (handles + display names only, never hashes) for
 *                    the /gate chooser, plus the signed-in operator if any.
 * POST   /api/gate { username, password } → scrypt-verified login; mints the
 *                    signed identity cookie. Generic 401 on any failure so
 *                    the endpoint never reveals whether a username exists.
 * DELETE /api/gate  → sign out (cookie cleared).
 *
 * Rate-limited brute-force surface; meaningful when ENCLAVE_SESSION_SECRET
 * is configured.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionCookieFor, SESSION_COOKIE, operatorFromRequest, gateArmed } from "@/lib/vertebra/session";
import { verifyPassword, normalizeUsername } from "@/lib/vertebra/operators";
import { guardWrite } from "@/lib/vertebra/guard";

const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;

export async function GET(request: Request) {
  const operators = await db.operator.findMany({
    select: { username: true, displayName: true },
    orderBy: { username: "asc" },
  });
  const sessionUsername = await operatorFromRequest(request);
  const operator = sessionUsername
    ? operators.find((o) => o.username === sessionUsername) ?? { username: sessionUsername, displayName: sessionUsername }
    : null;
  return NextResponse.json({ gate: gateArmed(), operators, operator });
}

export async function POST(request: Request) {
  const denied = guardWrite(request, "gate", { key: false, limit: 8, windowMs: 60_000 });
  if (denied) return denied;

  let username = "";
  let password = "";
  try {
    const body = (await request.json()) as { username?: string; password?: string };
    username = normalizeUsername(body.username ?? "");
    password = body.password ?? "";
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  if (!username || !password) {
    return NextResponse.json({ error: "bad_credentials" }, { status: 401 });
  }

  const row = await db.operator.findUnique({ where: { username } });
  if (!row) {
    return NextResponse.json({ error: "bad_credentials" }, { status: 401 });
  }
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "bad_credentials" }, { status: 401 });
  }

  const value = await sessionCookieFor(row.username);
  if (!value) {
    // Fail closed: no signing secret means the enclave cannot prove identity.
    return NextResponse.json(
      { error: "session_secret_missing", hint: "set ENCLAVE_SESSION_SECRET before the gate can issue sessions" },
      { status: 503 },
    );
  }
  await db.operator.update({ where: { username: row.username }, data: { lastLoginAt: new Date() } });

  const res = NextResponse.json({
    ok: true,
    operator: { username: row.username, displayName: row.displayName },
  });
  res.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE_S,
    path: "/",
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
  return res;
}
