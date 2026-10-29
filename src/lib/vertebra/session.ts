/**
 * Enclave session — optional password gate.
 *
 * When ENCLAVE_PASSWORD is unset (sandbox default) the console is open and
 * this module is inert. When set, middleware requires the enclave_session
 * cookie whose value is an HMAC of a fixed domain string under that
 * password — possession of a valid cookie proves knowledge of the password.
 *
 * Implemented with Web Crypto (async) so the module bundles safely into the
 * Edge middleware runtime as well as Node route handlers.
 */
export const SESSION_COOKIE = "enclave_session";
const SESSION_DOMAIN = "vertebra-enclave-v1";

/** Minimum accepted ENCLAVE_PASSWORD length — weaker locks are refused loudly. */
export const ENCLAVE_MIN_PASSWORD_LENGTH = 12;

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

export function enclavePassword(): string | null {
  return process.env.ENCLAVE_PASSWORD || null;
}

/** The cookie value a correct password produces — null when the gate is off. */
export async function expectedCookieValue(): Promise<string | null> {
  const password = enclavePassword();
  if (!password) return null;
  return hmacHex(SESSION_DOMAIN, password);
}

export async function checkSessionCookie(value: string | undefined): Promise<boolean> {
  const expected = await expectedCookieValue();
  if (!expected) return true; // gate disabled
  if (!value) return false;
  return hexEqual(value, expected);
}

export async function verifyPassword(candidate: string): Promise<boolean> {
  const password = enclavePassword();
  if (!password || !candidate) return false;
  return hexEqual(await hmacHex(candidate, password), await hmacHex(password, password));
}

/** Verify candidate AND produce the cookie value in one step. */
export async function sessionCookieFor(candidate: string): Promise<string | null> {
  const ok = await verifyPassword(candidate);
  if (!ok) return null;
  return expectedCookieValue();
}
