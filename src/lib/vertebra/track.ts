/**
 * Landing-page tracking tokens — the per-prospect funnel link.
 *
 * The cold email carries ONE tracked link: /l/<token>. The token is an
 * HMAC-SHA256 binding of the prospect id under the same secret family as
 * the unsubscribe footer (SYNTROPIC_UNSUBSCRIBE_SECRET, dev fallback keeps
 * the sandbox honest) — forgeable tokens would mean poisonable intent
 * heat, so verification is timing-safe and a bad token reads as a neutral
 * "link unavailable" page, never an enumeration oracle.
 *
 * The public base URL comes from VERTEBRA_PUBLIC_BASE_URL (the enclave has
 * no self-knowledge of its own hostname); localhost keeps the sandbox loop
 * closed until domain day.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { DEV_UNSUBSCRIBE_SECRET } from "@/lib/vertebra/casl";

const SECRET = process.env.SYNTROPIC_UNSUBSCRIBE_SECRET ?? DEV_UNSUBSCRIBE_SECRET;

export function publicBaseUrl(): string {
  return (process.env.VERTEBRA_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function landingToken(prospectId: string): string {
  const sig = createHmac("sha256", SECRET).update(`landing:${prospectId}`).digest("hex").slice(0, 32);
  return `${prospectId}.${sig}`;
}

export function verifyLandingToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const prospectId = token.slice(0, dot);
  const expected = landingToken(prospectId);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? prospectId : null;
}

/** The tracked link an email body carries — /l/<token>. */
export function landingUrlFor(prospectId: string): string {
  return `${publicBaseUrl()}/l/${landingToken(prospectId)}`;
}
