import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { applyHitlAction, TELEGRAM_CODE_TO_ACTION } from '@/lib/backbone-service';
import { answerCallbackQuery, editMessageText } from '@/lib/telegram';
import { emit } from '@/lib/bus';
import { hashToken } from '@/lib/operator-auth';
import type { HitlAction } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/telegram/webhook — receives Telegram inline-keyboard callbacks
 * and resolves them against the HITL queue (R-05).
 *
 * Two callback formats:
 *  - `h:<code>:<raw>` — one-time token buttons (15-min TTL, consumed on
 *    first use; codes A/O/R/X = APPROVE/OVERRIDE/RETRY/RESOLVE). This is
 *    what every newly-sent card carries.
 *  - `hitl:<ref>:<ACTION>` — legacy format, still honoured.
 *
 * After applying, the card's text is stamped "✔ ACTION by <operator>" via
 * editMessageText, and the bus announces the resolution to the SSE stream.
 * Configure with: setWebhook?url=<public>/api/telegram/webhook (or
 * POST /api/telegram/setup). Optional guard: TELEGRAM_WEBHOOK_SECRET →
 * "X-Telegram-Bot-Api-Secret-Token".
 */
export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const update = await req.json().catch(() => null);
  const cq = update?.callback_query;
  const data: string | undefined = cq?.data;

  if (cq && data) {
    if (data.startsWith('hitl:')) {
      const [, ref, action] = data.split(':');
      if (ref && (['APPROVE', 'OVERRIDE', 'RETRY', 'RESOLVE'] as HitlAction[]).includes(action as HitlAction)) {
        const result = await applyHitlAction(ref, action as HitlAction);
        if (cq.id) {
          await answerCallbackQuery(cq.id, result.ok ? `${ref} → ${action.toLowerCase()} applied` : result.error ?? 'Failed');
        }
      }
    } else if (data.startsWith('h:')) {
      const [, code, raw] = data.split(':');
      const action = TELEGRAM_CODE_TO_ACTION[code ?? ''];
      if (action && raw) {
        await ensureDb();
        const token = await db.magicLinkToken.findUnique({ where: { tokenHash: await hashToken(raw) } });
        if (!token || token.scope !== 'telegram' || token.usedAt || token.expiresAt < new Date()) {
          await answerCallbackQuery(cq.id, '⏱ This link expired — review the item in the Backbone deck.');
        } else {
          const item = token.targetId ? await db.hitlItem.findUnique({ where: { id: token.targetId } }) : null;
          if (!item) {
            await db.magicLinkToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
            await answerCallbackQuery(cq.id, 'Already resolved.');
          } else {
            await db.magicLinkToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
            const result = await applyHitlAction(item.ref, action);
            const who = cq.from?.first_name ?? 'Operator';
            if (cq.id) await answerCallbackQuery(cq.id, result.ok ? `✅ ${action.toLowerCase()} applied by ${who}` : result.error ?? 'Failed');
            if (cq.message?.chat?.id && cq.message?.message_id) {
              await editMessageText(
                cq.message.chat.id,
                cq.message.message_id,
                `✔ ${action} by ${who}\n${item.tenantName} · ${item.pdfName ?? ''} · ${item.skuParsed ?? ''} · ${item.confidenceScore ?? '—'}%`,
              );
            }
            if (!result.ok) {
              emit({ type: 'notification', kind: 'hitl', text: `Telegram ${action.toLowerCase()} rejected for ${item.ref}: ${result.error ?? 'unknown'}` });
            }
          }
        }
      } else {
        await answerCallbackQuery(cq.id, 'Unrecognized action');
      }
    }
  }

  // Always 200 so Telegram does not retry indefinitely.
  return NextResponse.json({ ok: true });
}
