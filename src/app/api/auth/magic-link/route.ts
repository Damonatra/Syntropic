import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { isOperator, MAGIC_LINK_TTL_MS, randomToken, hashToken } from '@/lib/operator-auth';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { sendMagicLink } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/magic-link — { email }. If (and only if) the address is in
 * OPERATOR_EMAILS, a single-use 15-minute token is minted and the sign-in
 * link is emailed (or console-logged when no mail provider is configured).
 * The response is intentionally identical for operator and non-operator
 * addresses — no account enumeration.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`magiclink:${ip}`, 5, 15 * 60e3)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const { email } = await req.json().catch(() => ({ email: '' }));
  const mail = String(email ?? '').trim().toLowerCase();

  if (isOperator(mail)) {
    await ensureDb();
    const raw = randomToken(32);
    await db.magicLinkToken.create({
      data: {
        email: mail,
        tokenHash: await hashToken(raw),
        scope: 'operator',
        expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      },
    });
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    await sendMagicLink(mail, `${origin}/api/auth/callback?token=${raw}`);
  }

  return NextResponse.json({ ok: true });
}
