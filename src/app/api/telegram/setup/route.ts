import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { OPERATOR_SESSION_COOKIE, verifySession } from '@/lib/operator-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/telegram/setup — operator-only helper that points the bot's
 * webhook at this deployment (allowed_updates: callback_query only, secret
 * token header enforced). 501 until TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET
 * are configured; 401 when OPERATOR_AUTH=1 and the caller has no session.
 */
export async function POST(req: Request) {
  if (process.env.OPERATOR_AUTH === '1') {
    const session = await verifySession((await cookies()).get(OPERATOR_SESSION_COOKIE)?.value);
    if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) return NextResponse.json({ error: 'telegram_not_configured' }, { status: 501 });

  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${origin}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ['callback_query'],
    }),
  });
  return NextResponse.json({ ok: res.ok });
}
