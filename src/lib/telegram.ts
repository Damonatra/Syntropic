import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type DeliveryStatus = 'SENT' | 'SIMULATED' | 'FAILED';

/**
 * Telegram Bot dispatch (R-05).
 *
 * Live mode requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. Without them the
 * alert is logged to the Notification ledger with deliveryStatus SIMULATED, so
 * the dispatch audit trail exists in every environment. Inline approval
 * keyboards are always attached; callbacks resolve through
 * POST /api/telegram/webhook once a public URL is configured.
 */
export async function sendTelegramAlert(
  text: string,
  buttons?: InlineButton[][],
  chatIdOverride?: string | null,
): Promise<DeliveryStatus> {
  await ensureDb();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chatIdOverride || process.env.TELEGRAM_CHAT_ID;
  const live = Boolean(token && chatId);

  const payload: Record<string, unknown> = { chat_id: chatId ?? 'backbone-ops', text };
  if (buttons?.length) payload.reply_markup = { inline_keyboard: buttons };

  const row = await db.notification.create({
    data: {
      channel: 'TELEGRAM',
      target: chatId ?? 'backbone-ops',
      text,
      payload: JSON.stringify(payload),
      deliveryStatus: 'SIMULATED',
    },
  });

  if (!live || !token || !chatId) return 'SIMULATED';

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const status: DeliveryStatus = res.ok ? 'SENT' : 'FAILED';
    await db.notification.update({ where: { id: row.id }, data: { deliveryStatus: status } });
    return status;
  } catch {
    await db.notification.update({ where: { id: row.id }, data: { deliveryStatus: 'FAILED' } });
    return 'FAILED';
  }
}

/** Answers a Telegram inline-keyboard callback (best effort). */
export async function answerCallbackQuery(id: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
  } catch {
    // Non-fatal: the HITL action has already been applied.
  }
}

/** Rewrites the text of a previously-sent message (best effort) — used to
 *  stamp "✔ APPROVED by Damon" onto a consumed inline-approval card. */
export async function editMessageText(chatId: string | number, messageId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
    });
  } catch {
    // Non-fatal.
  }
}
