/**
 * Login throttling for the portal sign-in surface.
 *
 * Two independent gates:
 *  1. Per (tenant × IP) failure lockout — 5 failed codes in a 15-min window
 *     locks that tenant+IP pair out for 15 minutes. Locks survive the window
 *     until they expire; a successful login clears the bucket.
 *  2. Per-IP burst cap — 30 login POSTs/min from one address, blind to
 *     validity, blunts distributed guessing and credential stuffing.
 *
 * Single-process SQLite deployment: the in-process Map is authoritative.
 * When the backbone scales past one node, swap the maps for Redis — the
 * call sites stay identical. Every lockout is written to the Notification
 * ledger (channel SECURITY) by the login route, not here, so this module
 * stays dependency-free and unit-testable.
 */

const failures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
const ipHits = new Map<string, number[]>();

export const FAIL_WINDOW_MS = 15 * 60_000;
export const FAIL_MAX = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const IP_WINDOW_MS = 60_000;
export const IP_MAX = 30;

export interface GateState {
  locked: boolean;
  retryAfterSec: number;
  failures: number;
}

/** First-hop client IP (x-forwarded-for behind a proxy; local otherwise). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || 'local';
}

/** Per-IP burst gate — counts every attempt (valid or not). */
export function ipGate(ip: string): GateState {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_MAX) {
    ipHits.set(ip, hits);
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((IP_WINDOW_MS - (now - hits[0])) / 1000)),
      failures: hits.length,
    };
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return { locked: false, retryAfterSec: 0, failures: hits.length };
}

/** Pre-check without recording — answers "is this pair currently locked?". */
export function lockState(key: string): GateState {
  const rec = failures.get(key);
  if (!rec) return { locked: false, retryAfterSec: 0, failures: 0 };
  const now = Date.now();
  if (rec.lockedUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000), failures: rec.count };
  }
  if (now - rec.firstAt > FAIL_WINDOW_MS) {
    failures.delete(key);
    return { locked: false, retryAfterSec: 0, failures: 0 };
  }
  return { locked: false, retryAfterSec: 0, failures: rec.count };
}

/** Records one failed attempt; flips to locked when FAIL_MAX is reached. */
export function recordFailure(key: string): GateState {
  const now = Date.now();
  const rec = failures.get(key);
  if (!rec || now - rec.firstAt > FAIL_WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return { locked: false, retryAfterSec: 0, failures: 1 };
  }
  rec.count += 1;
  if (rec.count >= FAIL_MAX) {
    rec.lockedUntil = now + LOCKOUT_MS;
    return { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000), failures: rec.count };
  }
  return { locked: false, retryAfterSec: 0, failures: rec.count };
}

/** Successful login — clear the pair's failure history. */
export function clearFailures(key: string): void {
  failures.delete(key);
}

/* ── Generic token bucket (public surfaces: intake, collect, magic-link) ── */

const buckets = new Map<string, { tokens: number; last: number }>();

/** Refill-per-window token bucket. Returns false when the caller is over
 *  the limit — route answers 429. Same in-process Map caveat as above. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: limit, last: now };
  b.tokens = Math.min(limit, b.tokens + ((now - b.last) / windowMs) * limit);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
