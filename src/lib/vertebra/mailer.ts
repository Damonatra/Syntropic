/**
 * Console mailer — the send side of Channel A / draft approval.
 *
 * Provider: Resend HTTP API when RESEND_API_KEY is configured; otherwise the
 * send is staged (returned with reason "no_provider") so callers can queue
 * or log it without pretending an email left the building. Every CASL-scope
 * send carries the identification footer + RFC 8058 one-click headers.
 *
 * Third interlock (with the unsubscribe secret and the egress arm): the
 * sending-domain ledger. Live egress resolves the effective from-domain and
 * asks the warmup gate whether this domain may send today — unregistered,
 * unverified-DNS, paused, burned, or over-cap domains all refuse with a
 * named reason. A fresh domain blasted to volume looks like a spam farm to
 * every mailbox provider; the ledger makes the ramp structural instead of
 * a matter of memory. Staged mode (no provider) is untouched.
 */
import { db } from "@/lib/db";
import { buildCaslFooter, buildEmailHeaders, unsubscribeSecretStatus } from "@/lib/vertebra/casl";
import { resolveEgressVerdict, startOfUtcDay } from "@/lib/vertebra/warmup";

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
  /** Provider message id of the email this send replies to — thread continuity. */
  inReplyTo?: string | null;
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
  // --- Live-egress interlocks ---------------------------------------------- //
  // Real mail only leaves a locked enclave with real unsubscribe signing.
  // Staged mode (no RESEND key) is unaffected — the sandbox stays honest.
  if (mailProvider() === "resend") {
    const secretStatus = unsubscribeSecretStatus();
    if (secretStatus !== "custom") {
      return {
        ok: false,
        status: "failed",
        reason: `unsubscribe_secret_required: SYNTROPIC_UNSUBSCRIBE_SECRET is ${secretStatus} — forgeable one-click links mean suppression-list poisoning`,
        footerApplied: null,
      };
    }
    if (process.env.ENCLAVE_EGRESS_ARMED !== "1") {
      return {
        ok: false,
        status: "failed",
        reason: "enclave_egress_disarmed: set ENCLAVE_EGRESS_ARMED=1 before live egress — no real mail from a disarmed enclave",
        footerApplied: null,
      };
    }
    // Interlock 3 — the sending-domain ledger. Resolve the exact domain this
    // send would use, then ask the warmup gate. Counted volume is the
    // domain's dispatch rows that landed today (sent/delivered/opened) —
    // the same rows the ops board and the warmup watch read. Raw SQL on
    // purpose (schema pushes never require a restart) and fail-closed on
    // purpose: a ledger the gate cannot read refuses, it never waves through.
    const fromDomain = input.fromDomain ?? process.env.VERTEBRA_SEND_DOMAIN ?? "syntropic-os.com";
    type LedgerRow = { domain: string; role: string; dnsStatus: string; status: string; warmupStartedAt: Date | string | null };
    const [ledgerRows, countRows] = await Promise.all([
      db
        .$queryRawUnsafe<LedgerRow[]>(`SELECT domain, role, dnsStatus, status, warmupStartedAt FROM SendingDomain WHERE domain = ? LIMIT 1`, fromDomain)
        .catch(() => null as LedgerRow[] | null),
      db
        .$queryRawUnsafe<{ c: number }[]>(
          `SELECT COUNT(*) as c FROM Dispatch WHERE fromDomain = ? AND status IN ('sent','delivered','opened') AND updatedAt >= ?`,
          fromDomain,
          startOfUtcDay(new Date()),
        )
        .catch(() => null as { c: number }[] | null),
    ]);
    if (!ledgerRows || !countRows) {
      return { ok: false, status: "failed", reason: "domain_ledger_unavailable: the egress gate could not read the SendingDomain ledger — fail-closed, retry the tick", footerApplied: null };
    }
    const ledgerRow = ledgerRows[0]
      ? {
          domain: ledgerRows[0].domain,
          role: ledgerRows[0].role,
          dnsStatus: ledgerRows[0].dnsStatus,
          status: ledgerRows[0].status,
          warmupStartedAt: ledgerRows[0].warmupStartedAt ? new Date(ledgerRows[0].warmupStartedAt) : null,
        }
      : null;
    const verdict = resolveEgressVerdict(ledgerRow, countRows[0]?.c ?? 0, new Date());
    if (!verdict.ok) {
      return { ok: false, status: "failed", reason: verdict.reason, footerApplied: null };
    }
  }

  const display = input.fromDisplayName ?? process.env.VERTEBRA_FROM_DISPLAY ?? "Syntropic Industrial Growth";
  const from = senderAddress(input.fromDomain, display);
  const footer = buildCaslFooter(input.prospectId ?? "anon", input.to, input.region ?? null);
  const headers = buildEmailHeaders(input.prospectId ?? "anon", input.to, Boolean(input.caslScope));
  const text = `${input.text.trim()}\n\n— ${display}\n\n${footer}`;

  if (mailProvider() === "none") {
    return { ok: false, status: "staged", reason: "no_provider", footerApplied: "casl" };
  }

  try {
    // Email headers ride the JSON body (Resend wire shape) — the CASL
    // one-click pair and the thread pair are MESSAGE headers, not HTTP
    // request headers; the transport would silently drop those.
    const messageHeaders: Record<string, string> = { ...headers };
    if (input.inReplyTo) {
      messageHeaders["In-Reply-To"] = input.inReplyTo;
      messageHeaders["References"] = input.inReplyTo;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        from: `${display} <${from}>`,
        to: [input.to],
        subject: input.subject,
        text,
        headers: messageHeaders,
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
