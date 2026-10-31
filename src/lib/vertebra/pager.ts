/**
 * Alert pager — Telegram / Slack delivery for high-intent IntentAlerts.
 * Console parity of vertebra/telemetry/notifier.py channel fan-out.
 *
 * The pager is a spoke like any other, so it obeys the same constitution:
 * a channel fires only when ALL of these hold —
 *   1. its env vars are set (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, and/or
 *      SLACK_WEBHOOK_URL) — the key VALUE never lives in the ledger,
 *   2. its registry row (telegram-pager / slack-pager) is armed, circuit
 *      closed — arming is the operator's click, never implied by a key
 *      appearing in the environment,
 * and refuses with a named reason otherwise, reported honestly in
 * `refused` — never faked, never thrown (fire-and-forget contract).
 *
 * probePagerChannel fires ONE real test message to a single channel —
 * the honest pager probe, because a key-shape check cannot prove a
 * channel rings.
 */
import { resolveIntegrationGate } from "@/lib/vertebra/integrations";

export interface PagerOutcome {
  attempted: string[];
  delivered: string[];
  /** configured channels the registry refused, with the named reason */
  refused: string[];
}

/** registry row per channel — the star map is the allowlist */
const GATED_BY: Record<"telegram" | "slack", string> = {
  telegram: "telegram-pager",
  slack: "slack-pager",
};

function alertText(title: string, body: string, glyph = "🚨"): string {
  return `${glyph} ${title}\n\n${body}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error("pager_timeout")), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (t) clearTimeout(t); // a resolved page must not hold the event loop
  }
}

/**
 * The pager's slice of the registry gate. Never throws — a ledger that
 * cannot be read refuses, it never waves through (fire-and-forget).
 */
async function gateAllows(channel: "telegram" | "slack"): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const verdict = await resolveIntegrationGate(GATED_BY[channel]);
    return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason };
  } catch (e) {
    return { ok: false, reason: `pager_gate_unreadable: ${String(e).slice(0, 120)}` };
  }
}

export async function deliverAlert(title: string, body: string): Promise<PagerOutcome> {
  return deliverPage(title, body, "🚨");
}

/**
 * Notices share the pager's rails (registry gate, both channels, honest
 * outcome) but are reports, not emergencies — the sequence engine uses
 * them to tell the operator what it just did autonomously.
 */
export async function deliverNotice(title: string, body: string): Promise<PagerOutcome> {
  return deliverPage(title, body, "✅");
}

async function deliverPage(title: string, body: string, glyph: string): Promise<PagerOutcome> {
  const attempted: string[] = [];
  const delivered: string[] = [];
  const refused: string[] = [];
  const jobs: Array<Promise<void>> = [];

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    const gate = await gateAllows("telegram");
    if (!gate.ok) {
      refused.push(`telegram: ${gate.reason}`);
      console.warn(`[pager] telegram refused by the registry: ${gate.reason}`);
    } else {
      attempted.push("telegram");
      jobs.push(
        withTimeout(
          fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: tgChat, text: alertText(title, body, glyph), disable_web_page_preview: true }),
          })
            .then(async (r) => {
              if (r.ok) delivered.push("telegram");
              else console.warn(`[pager] telegram ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120)}`);
            })
            .catch((e) => console.warn("[pager] telegram failed:", String(e).slice(0, 120))),
          4_000,
        ),
      );
    }
  }

  const slackHook = process.env.SLACK_WEBHOOK_URL;
  if (slackHook) {
    const gate = await gateAllows("slack");
    if (!gate.ok) {
      refused.push(`slack: ${gate.reason}`);
      console.warn(`[pager] slack refused by the registry: ${gate.reason}`);
    } else {
      attempted.push("slack");
      jobs.push(
        withTimeout(
          fetch(slackHook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: alertText(title, body, glyph) }),
          })
            .then(async (r) => {
              if (r.ok) delivered.push("slack");
              else console.warn(`[pager] slack ${r.status}`);
            })
            .catch((e) => console.warn("[pager] slack failed:", String(e).slice(0, 120))),
          4_000,
        ),
      );
    }
  }

  await Promise.all(jobs);
  return { attempted, delivered, refused };
}

/**
 * One real test page to ONE channel — the probe button's payload for
 * pager rows. Key-shape checks cannot prove a channel rings; this can.
 * Never throws; the detail string is the operator-facing truth.
 */
export async function probePagerChannel(provider: string, transport: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const text = `Vertebra pager probe — ${stamp} UTC\nThis was a real test page. Live-intent replies, convoy touches, and crit escalations arrive exactly like this.`;

  if (provider === "slack-pager") {
    const hook = process.env.SLACK_WEBHOOK_URL;
    if (!hook) return { ok: false, detail: "SLACK_WEBHOOK_URL is not set — paste the incoming-webhook URL into .env and restart the dev server" };
    try {
      const res = await transport(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) return { ok: true, detail: `Slack answered ${res.status} — the test page is in the channel; that is what a real page looks like` };
      return { ok: false, detail: `Slack answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}` };
    } catch (e) {
      return { ok: false, detail: `transport error: ${String(e).slice(0, 140)}` };
    }
  }

  if (provider === "telegram-pager") {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) {
      return { ok: false, detail: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not set — create the bot with BotFather, paste both into .env and restart the dev server" };
    }
    try {
      const res = await transport(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8_000),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
      if (res.ok && j?.ok) return { ok: true, detail: "Telegram answered ok — the test page is in the chat; that is what a real page looks like" };
      return { ok: false, detail: `Telegram refused: ${j?.description ?? `HTTP ${res.status}`}` };
    } catch (e) {
      return { ok: false, detail: `transport error: ${String(e).slice(0, 140)}` };
    }
  }

  return { ok: false, detail: `unknown pager channel "${provider}"` };
}

export function pagerConfigured(): string[] {
  const channels: string[] = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) channels.push("telegram");
  if (process.env.SLACK_WEBHOOK_URL) channels.push("slack");
  return channels;
}
