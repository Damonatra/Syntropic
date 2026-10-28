/**
 * Console mailer — the send side of Channel A / draft approval.
 *
 * Provider: Resend HTTP API when RESEND_API_KEY is configured; otherwise the
 * send is staged (returned with reason "no_provider") so callers can queue
 * or log it without pretending an email left the building. Every CASL-scope
 * send carries the identification footer + RFC 8058 one-click headers.
 */
import { db } from "@/lib/db";
import { buildCaslFooter, buildEmailHeaders } from "@/lib/vertebra/casl";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  prospectId?: string | null;
  caslScope?: boolean;
  region?: string | null;
  fromDisplayName?: string;
  fromDomain?: string | null;
  replyTo?: string | null;
}

export interface SendEmailResult {
  ok: boolean;
  status: "sent" | "staged" | "failed";
  providerMsgId?: string;
  reason?: string;
  footerApplied: string | null;
}

export function mailProvider(): "resend" | "none" {
  return process.env.RESEND_API_KEY ? "resend" : "none";
}

function senderAddress(domain: string | null | undefined, display: string): string {
  const d = domain ?? process.env.VERTEBRA_SEND_DOMAIN ?? "syntropic-os.com";
  const local = display.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "desk";
  return `${local}@${d}`;
}

/** True when the address (or its prospect) is suppressed — never email them. */
export async function isSuppressed(email: string | null | undefined, prospectId?: string | null): Promise<boolean> {
  if (!email) return false;
  const row = await db.suppressionRecord.findFirst({
    where: { OR: [{ email: email.toLowerCase() }, ...(prospectId ? [{ prospectId }] : [])] },
  });
  return row != null;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const display = input.fromDisplayName ?? process.env.VERTEBRA_FROM_DISPLAY ?? "Syntropic Industrial Growth";
  const from = senderAddress(input.fromDomain, display);
  const footer = buildCaslFooter(input.prospectId ?? "anon", input.to, input.region);
  const headers = buildEmailHeaders(input.prospectId ?? "anon", input.to, Boolean(input.caslScope));
  const text = `${input.text.trim()}\n\n— ${display}\n\n${footer}`;

  if (mailProvider() === "none") {
    return { ok: false, status: "staged", reason: "no_provider", footerApplied: "casl" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...headers,
      },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        from: `${display} <${from}>`,
        to: [input.to],
        subject: input.subject,
        text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, status: "failed", reason: `resend_${res.status}: ${detail.slice(0, 200)}`, footerApplied: "casl" };
    }
    const data = (await res.json()) as { id?: string };
    return { ok: true, status: "sent", providerMsgId: data.id, footerApplied: "casl" };
  } catch (error) {
    return { ok: false, status: "failed", reason: `transport: ${String(error).slice(0, 200)}`, footerApplied: "casl" };
  }
}
