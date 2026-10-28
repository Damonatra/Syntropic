/**
 * Alert pager — Telegram / Slack delivery for high-intent IntentAlerts.
 * Console parity of vertebra/telemetry/notifier.py channel fan-out.
 *
 * Channels activate by env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, and/or
 * SLACK_WEBHOOK_URL. Without them the alert stays in-app only — reported
 * honestly in channelsDelivered, never faked.
 */

export interface PagerOutcome {
  attempted: string[];
  delivered: string[];
}

function alertText(title: string, body: string): string {
  return `🚨 ${title}\n\n${body}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("pager_timeout")), ms)),
  ]);
}

export async function deliverAlert(title: string, body: string): Promise<PagerOutcome> {
  const attempted: string[] = [];
  const delivered: string[] = [];
  const jobs: Array<Promise<void>> = [];

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    attempted.push("telegram");
    jobs.push(
      withTimeout(
        fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: tgChat, text: alertText(title, body), disable_web_page_preview: true }),
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

  const slackHook = process.env.SLACK_WEBHOOK_URL;
  if (slackHook) {
    attempted.push("slack");
    jobs.push(
      withTimeout(
        fetch(slackHook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: alertText(title, body) }),
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

  await Promise.all(jobs);
  return { attempted, delivered };
}

export function pagerConfigured(): string[] {
  const channels: string[] = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) channels.push("telegram");
  if (process.env.SLACK_WEBHOOK_URL) channels.push("slack");
  return channels;
}
