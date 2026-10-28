/**
 * Operator magic-link auth primitives — edge-safe (Web Crypto only, no
 * node:crypto imports) so src/middleware.ts can verify sessions on the
 * edge runtime.
 *
 * Model: an operator requests a sign-in link at POST /api/auth/magic-link.
 * If the address is in OPERATOR_EMAILS, a single-use MagicLinkToken row is
 * minted (15-minute TTL) and the raw link is emailed — or, when no mail
 * provider is configured, logged to the server console (dev.log). Opening
 * the link consumes the token and sets an HMAC-signed HttpOnly session
 * cookie valid for 7 days.
 *
 * The /backbone surface is only gated when OPERATOR_AUTH=1 — the sandbox
 * demo runs open by default; production flips the flag (see .env.example).
 */

const enc = new TextEncoder();

export const OPERATOR_SESSION_COOKIE = 'syntropic_session';
export const OPERATOR_SESSION_TTL_MS = 7 * 24 * 3600e3;
export const MAGIC_LINK_TTL_MS = 15 * 60e3;

export function operatorEmails(): string[] {
  return (process.env.OPERATOR_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const isOperator = (email: string) => operatorEmails().includes(email.toLowerCase());

async function hmacKey() {
  const secret = process.env.AUTH_SECRET ?? 'dev-insecure-secret-change-me';
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64u = {
  enc: (buf: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

export async function signSession(email: string): Promise<string> {
  const payload = { scope: 'operator', email: email.toLowerCase(), exp: Date.now() + OPERATOR_SESSION_TTL_MS, jti: crypto.randomUUID() };
  const body = b64u.enc(enc.encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  return `${body}.${b64u.enc(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body)))}`;
}

export async function verifySession(token: string | undefined | null) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(), b64u.dec(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(b64u.dec(body))) as { scope?: string; email?: string; exp?: number };
    if (p.scope !== 'operator' || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    if (!p.email || !isOperator(p.email)) return null;
    return { email: p.email };
  } catch {
    return null;
  }
}

export async function hashToken(raw: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(raw)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
