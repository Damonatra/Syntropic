/**
 * Edge-guard for Vertebra write endpoints — ingest-key auth + rate limiting.
 *
 * Ingest key: engine-to-console writes (/api/telemetry/ingest, /api/replies
 * POST, /api/cron/tick) must present the shared key when VERTEBRA_INGEST_KEY
 * is configured. Unset = open dev mode so the sandbox and the socket bridge
 * keep working out of the box.
 *
 * Rate limiting: in-memory token bucket per client+route. Single-instance
 * honest protection for the sandbox; swap for Redis when multi-instance.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

// --------------------------------------------------------------------------- //
// Ingest key
// --------------------------------------------------------------------------- //

export function ingestKeyConfigured(): boolean {
  return Boolean(process.env.VERTEBRA_INGEST_KEY);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when the request may proceed (no key configured or key matches). */
export function checkIngestKey(request: Request): boolean {
  const expected = process.env.VERTEBRA_INGEST_KEY;
  if (!expected) return true;
  const header = request.headers.get("x-vertebra-key");
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const provided = header ?? bearer;
  return provided != null && safeEqual(provided, expected);
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized", hint: "present the shared key in the x-vertebra-key header" }, { status: 401 });
}

// --------------------------------------------------------------------------- //
// Token-bucket rate limiter
// --------------------------------------------------------------------------- //

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();
const BUCKET_SWEEP_INTERVAL = 5 * 60_000;
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < BUCKET_SWEEP_INTERVAL) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (now - b.lastRefill > 60 * 60_000) buckets.delete(k);
}

/** Client identity for bucketing — X-Forwarded-For aware (Caddy gateway). */
export function clientKey(request: Request, route: string): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${route}:${fwd || "local"}`;
}

/**
 * Consume one token. `limit` events per `windowMs` per client.
 * Returns false when the client is over budget.
 */
export function rateLimit(request: Request, route: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  sweep(now);
  const key = clientKey(request, route);
  const bucket = buckets.get(key) ?? { tokens: limit, lastRefill: now };
  const elapsed = now - bucket.lastRefill;
  if (elapsed > 0) {
    bucket.tokens = Math.min(limit, bucket.tokens + (elapsed / windowMs) * limit);
    bucket.lastRefill = now;
  }
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

export function tooMany(): NextResponse {
  return NextResponse.json({ error: "rate_limited" }, { status: 429 });
}

/** Convenience: guard a write handler. Returns a NextResponse to bail with, or null to proceed. */
export function guardWrite(request: Request, route: string, opts?: { key?: boolean; limit?: number; windowMs?: number }): NextResponse | null {
  if (opts?.key !== false && !checkIngestKey(request)) return unauthorized();
  if (!rateLimit(request, route, opts?.limit ?? 30, opts?.windowMs ?? 60_000)) return tooMany();
  return null;
}
