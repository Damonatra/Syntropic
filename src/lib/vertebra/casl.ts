/**
 * CASL compliance kit for the console — TypeScript parity with
 * `vertebra/enrichment/casl.py`. Channel A sends always carry the footer;
 * CASL-scope recipients additionally get RFC 8058 one-click headers.
 */

const UNSUBSCRIBE_BASE_URL = "https://syntropic-os.com/u";

const FOOTER_CA = `You are receiving this one-time business inquiry because Syntropic believes it is relevant to your role. Syntropic Engine LLC, compliance@syntropic.com. Prefer not to hear from us again? Unsubscribe instantly: {unsubscribe_url}`;
const FOOTER_US = `Sent by Syntropic Engine LLC. Don't want these emails? Unsubscribe: {unsubscribe_url}`;

/** Signed (HMAC-style digest) single-click unsubscribe URL. */
export function unsubscribeUrl(prospectId: string, address: string): string {
  const digest = simpleDigest(`${UNSUBSCRIBE_BASE_URL}:${prospectId}:${address}`);
  const p = encodeURIComponent(prospectId);
  const a = encodeURIComponent(address);
  return `${UNSUBSCRIBE_BASE_URL}?p=${p}&a=${a}&t=${digest}`;
}

export function buildCaslFooter(prospectId: string, address: string, region: string | null): string {
  const link = unsubscribeUrl(prospectId, address);
  const template = region === "ca" ? FOOTER_CA : FOOTER_US;
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

function simpleDigest(input: string): string {
  // FNV-1a 32-bit, hex — deterministic token binding URL to prospect+address.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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
