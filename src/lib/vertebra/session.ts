/**
 * Enclave session — per-operator identity.
 *
 * The door is identity, not a shared password: each operator signs in with
 * their own credentials (scrypt-verified against the Operator table by the
 * Node route handler) and the enclave mints a cookie that PROVES WHO they
 * are, not merely that someone knows a secret.
 *
 * Cookie value: `<username>.<hex HMAC("vertebra-operator-v1:" + username,
 * ENCLAVE_SESSION_SECRET)>` — possession of a valid cookie proves the
 * secret signed that username, so trails and acks can attribute actions to
 * "josias" or "damon" without a session store (stateless, Edge-safe).
 *
 * Implemented with Web Crypto (async) so the module bundles safely into the
 * Edge middleware runtime as well as Node route handlers.
 */
export const SESSION_COOKIE = "enclave_session";
const SESSION_DOMAIN = "vertebra-operator-v1";

async function hmacHex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish hex compare (no early exit on content). */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The gate is armed only when a session secret exists to sign identities with. */
export function gateArmed(): boolean {
  return Boolean(process.env.ENCLAVE_SESSION_SECRET);
}

/** The cookie value that proves `username` signed in — null while the gate is off. */
export async function sessionCookieFor(username: string): Promise<string | null> {
  const secret = process.env.ENCLAVE_SESSION_SECRET;
  if (!secret || !username) return null;
  return `${username}.${await hmacHex(`${SESSION_DOMAIN}:${username}`, secret)}`;
}

/** Verify a cookie's signature and return the operator username it carries. */
export async function operatorFromCookie(value: string | undefined): Promise<string | null> {
  const secret = process.env.ENCLAVE_SESSION_SECRET;
  if (!secret || !value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const username = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = await hmacHex(`${SESSION_DOMAIN}:${username}`, secret);
  return hexEqual(sig, expected) ? username : null;
}

/** Middleware check — true when the gate is off, else the cookie must verify. */
export async function checkSessionCookie(value: string | undefined): Promise<boolean> {
  if (!gateArmed()) return true; // gate disabled
  return (await operatorFromCookie(value)) !== null;
}

/** Server-side read of the signed-in operator from a Request's Cookie header. */
export async function operatorFromRequest(request: Request): Promise<string | null> {
  const header = request.headers.get("cookie") ?? "";
  const m = header.match(/(?:^|;\s*)enclave_session=([^;]*)/);
  if (!m || !m[1]) return null;
  try {
    return operatorFromCookie(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
}
