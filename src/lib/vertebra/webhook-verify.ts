/**
 * Webhook door crypto — shared by every externally-fed door in the enclave.
 *
 * Two schemes live here:
 *
 *   1. verifySvix      — Resend (and any Svix-based provider) signs with
 *                        `svix-id`, `svix-timestamp`, `svix-signature`
 *                        headers. Signed content is `id.timestamp.payload`,
 *                        HMAC-SHA256 over a base64 key unwrapped from the
 *                        `whsec_…` signing secret, compared timing-safe
 *                        against each `v1,<b64>` candidate in the header.
 *                        Stale timestamps are rejected (replay guard).
 *
 *   2. hmacDoorValid   — the enclave's own door contract, shared with
 *                        /api/portal/ingest and /api/ops/heartbeat:
 *                        HMAC-SHA256(rawBody, secret), hex, sent as
 *                        `x-vertebra-signature` (sha256= prefix tolerated).
 *
 * New doors use these helpers instead of hand-rolling crypto — one
 * implementation, one set of tests, no drift between doors.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SVIX_TIMESTAMP_TOLERANCE_MS = 5 * 60_000; // Svix default

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type VerifyResult = { ok: true; eventId: string } | { ok: false; reason: string };

function timingSafeMatch(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function unwrapSvixSecret(secret: string): Buffer {
  const s = secret.trim();
  if (s.startsWith("whsec_")) return Buffer.from(s.slice("whsec_".length), "base64");
  // Bare secrets are accepted raw — the sandbox and test harness never
  // receive a real whsec_ envelope; production secrets always carry it.
  return Buffer.from(s, "utf8");
}

/**
 * Verify a Svix-signed webhook (Resend event + receiving webhooks).
 * Returns the svix-id on success — it doubles as the retry dedupe ref.
 */
export function verifySvix(
  rawBody: string,
  headers: SvixHeaders,
  secret: string | undefined,
  toleranceMs: number = SVIX_TIMESTAMP_TOLERANCE_MS,
): VerifyResult {
  if (!secret) return { ok: false, reason: "webhook_secret_not_configured" };
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "missing_svix_headers" };
  }
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_timestamp" };
  const skew = Math.abs(Date.now() - ts * 1000);
  if (skew > toleranceMs) {
    return { ok: false, reason: `stale_timestamp: skew ${Math.round(skew / 1000)}s exceeds ${Math.round(toleranceMs / 1000)}s tolerance` };
  }

  const key = unwrapSvixSecret(secret);
  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", key).update(signedContent, "utf8").digest("base64");

  // The signature header is a space-separated list: `v1,<b64> v1,<b64> …`
  // (key rotation produces several candidates; any valid one authenticates).
  const candidates = headers.signature
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const comma = entry.indexOf(",");
      return comma === -1 ? entry : entry.slice(comma + 1);
    });

  const expectedBuf = Buffer.from(expected, "utf8");
  for (const candidate of candidates) {
    if (timingSafeMatch(expectedBuf, Buffer.from(candidate, "utf8"))) {
      return { ok: true, eventId: headers.id };
    }
  }
  return { ok: false, reason: "invalid_signature" };
}

/** The enclave door contract: HMAC-SHA256(rawBody, secret), hex, x-vertebra-signature. */
export function hmacDoorValid(rawBody: string, provided: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !provided) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeMatch(Buffer.from(expected, "utf8"), Buffer.from(provided.trim().toLowerCase().replace(/^sha256=/, ""), "utf8"));
}

/**
 * Pull an email address out of a raw From/To header value:
 * `"Damon Vale" <d@acme.com>` → `{ address: "d@acme.com", name: "Damon Vale" }`.
 * A bare address passes through untouched.
 */
export function parseAddressHeader(value: string | null | undefined): { address: string; name: string | null } | null {
  if (!value) return null;
  const angle = value.match(/<([^>]+)>/);
  const address = (angle ? angle[1] : value).trim().toLowerCase();
  if (!address || !address.includes("@")) return null;
  const name = angle ? value.slice(0, angle.index).trim().replace(/^"|"$/g, "") || null : null;
  return { address, name };
}

/** The domain half of an email address — the inbound matcher's last resort. */
export function addressDomain(address: string): string {
  return address.split("@")[1]?.toLowerCase().trim() ?? "";
}
