/**
 * CASL compliance kit for the console — TypeScript parity with
 * `vertebra/enrichment/casl.py`. Channel A sends always carry the footer;
 * CASL-scope recipients additionally get RFC 8058 one-click headers.
 *
 * Unsubscribe tokens are HMAC-SHA256 (secret-keyed) bindings of
 * prospect+address; the one-click endpoint is the console's own
 * /api/unsubscribe route (see src/app/api/unsubscribe/route.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const UNSUBSCRIBE_SECRET = process.env.VERTEBRA_UNSUBSCRIBE_SECRET ?? "vertebra-dev-unsubscribe-secret";

export function unsubscribePath(prospectId: string, address: string): string {
  const digest = tokenFor(prospectId, address);
  const p = encodeURIComponent(prospectId);
  const a = encodeURIComponent(address);
  return `/api/unsubscribe?p=${p}&a=${a}&t=${digest}`;
}

/** Absolute unsubscribe URL when the deployment origin is known. */
export function unsubscribeUrl(prospectId: string, address: string, origin?: string | null): string {
  const base = origin ?? process.env.VERTEBRA_PUBLIC_ORIGIN ?? "https://syntropic-os.com";
  return `${base.replace(/\/$/, "")}${unsubscribePath(prospectId, address)}`;
}

export function tokenFor(prospectId: string, address: string): string {
  return createHmac("sha256", UNSUBSCRIBE_SECRET).update(`${prospectId}:${address}`).digest("hex").slice(0, 32);
}

export function verifyToken(prospectId: string, address: string, token: string): boolean {
  const expected = Buffer.from(tokenFor(prospectId, address));
  const provided = Buffer.from(token ?? "");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function buildCaslFooter(prospectId: string, address: string, region: string | null): string {
  const link = unsubscribeUrl(prospectId, address);
  const template =
    region === "ca"
      ? `You are receiving this one-time business inquiry because Syntropic believes it is relevant to your role. Syntropic Engine LLC, compliance@syntropic.com. Prefer not to hear from us again? Unsubscribe instantly: {unsubscribe_url}`
      : `Sent by Syntropic Engine LLC. Don't want these emails? Unsubscribe: {unsubscribe_url}`;
  return template.replace("{unsubscribe_url}", link);
}

export function buildEmailHeaders(
  prospectId: string,
  address: string,
  caslScope: boolean,
): Record<string, string> {
  const link = unsubscribeUrl(prospectId, address);
  const headers: Record<string, string> = { "List-Unsubscribe": `<${link}>` };
  if (caslScope) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  return headers;
}

/** Subject line keyed off the top hook's flavor (parity with router.py). */
export function subjectForHook(flavor: string, company: string): string {
  switch (flavor) {
    case "rfq_latency":
      return `${company}: RFQ turnaround`;
    case "spa_leakage":
      return `${company}: vendor SPA gaps`;
    case "portal_drift":
      return `${company}: quoting through the portal`;
    case "peer_proof":
      return `a benchmark for ${company}`;
    default:
      return `${company}: quoting benchmark`;
  }
}

export const CLOSE_CTA =
  "If this is relevant, I will send a 3-slide teardown of where the leakage shows up in a quoting workflow like yours. If not, the unsubscribe link below is instant.";

/** Google Calendar "create event" template link used by Channel B follow-ups. */
export function calendarFollowupUrl(params: {
  company: string;
  contact: string;
  hook: string;
  qlvScore: number;
}): string {
  const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 45 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const text = `High-touch follow-up — ${params.company} (QLV ${params.qlvScore}/100)`;
  const details = `Josias high-touch queue follow-up.\n\nCompany: ${params.company}\nContact: ${params.contact}\nScore: QLV ${params.qlvScore}/100\n\nOpening hook on file:\n${params.hook}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(text)}&dates=${fmt(start)}/${fmt(end)}&details=${encodeURIComponent(details)}`;
}
