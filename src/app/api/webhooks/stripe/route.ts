import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { emit } from '@/lib/bus';
import { sendTelegramAlert } from '@/lib/telegram';
import { sendTenantUnlockEmail } from '@/lib/email';
import { generateAccessCode, codeHint } from '@/lib/invites';
import { hashCode } from '@/lib/portal-auth';
import { verifyStripeSignature } from '@/lib/stripe';
import { recordTraffic } from '@/lib/traffic';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/stripe — checkout.session.completed handler.
 *
 * Marks the tenant's deposit PAID, opens the audit (AuditRecord + the owning
 * founder's auditsClosed counter), mints a fresh portal invite (reveal-once
 * code — same machinery as the Tower's "Email new invite"), sends the unlock
 * email, alerts the stream, and captures PAYMENT_SUCCESS in the funnel.
 * Signature verification uses the raw body + STRIPE_WEBHOOK_SECRET with a
 * 5-minute replay window; 501 while unconfigured.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 501 });
  }

  const payload = await req.text();
  if (!verifyStripeSignature(payload, req.headers.get('stripe-signature'), secret)) {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  const event = JSON.parse(payload) as { type?: string; data?: { object?: Record<string, unknown> } };
  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true, note: `ignored ${event.type}` });
  }

  const session = event.data?.object ?? {};
  const tenantName = (session.client_reference_id ?? (session.metadata as Record<string, string> | undefined)?.tenantName ?? '') as string;
  if (!tenantName) return NextResponse.json({ received: true, note: 'no tenant ref' });

  await ensureDb();
  const tenant = await db.tenant.findUnique({ where: { name: tenantName } });
  if (!tenant) return NextResponse.json({ received: true, note: 'unknown tenant' });

  await db.tenant.update({
    where: { name: tenantName },
    data: { paymentStatus: 'PAID', status: 'Audit active — ingest unlocked', depositLabel: '$3,500 audit paid' },
  });

  const today = new Date().toISOString().slice(0, 10);
  const existingAudit = await db.auditRecord.findFirst({ where: { companyName: tenantName } });
  if (!existingAudit) {
    const maxSort = await db.auditRecord.aggregate({ _max: { sortOrder: true } });
    await db.auditRecord.create({
      data: {
        companyName: tenantName,
        dateSold: today,
        auditFeeCents: 350_000,
        attendedCall: false,
        callHost: tenant.owner,
        convertedToClient: false,
        identifiedLeakageCents: 0,
        callNotes: 'Deposit captured via Stripe Checkout. Awaiting 20-file ingest + briefing.',
        sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
      },
    });
  }

  if (tenant.assignedToId) {
    await db.teamMember.update({ where: { id: tenant.assignedToId }, data: { auditsClosed: { increment: 1 } } }).catch(() => undefined);
  }

  // Fresh portal invite — the code exists exactly once (email body).
  const code = generateAccessCode(tenantName);
  await db.$transaction([
    db.tenantInvite.updateMany({ where: { tenantName, status: 'PENDING' }, data: { status: 'REVOKED' } }),
    db.tenantInvite.create({
      data: { tenantName, email: tenant.contactEmail, codeHash: hashCode(code), codeHint: codeHint(code), issuedBy: 'Stripe webhook', status: 'PENDING' },
    }),
    db.tenant.update({ where: { name: tenantName }, data: { accessCodeHash: hashCode(code), sessionEpoch: { increment: 1 } } }),
  ]);

  const base = process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin;
  void sendTenantUnlockEmail(tenant.contactEmail, `${base}/portal/login`, tenantName, code);

  const text = `NEW INGEST: ${tenantName} ($3,500 Audit Deposit PAID) → Assigned to ${tenant.owner}`;
  await sendTelegramAlert(`💰 ${text}`);
  emit({ type: 'notification', kind: 'audit_paid', text });

  void recordTraffic({
    sessionId: `stripe:${String(session.id ?? 'unknown')}`.slice(0, 64),
    layer: 'ENGINE',
    eventType: 'PAYMENT_SUCCESS',
    ip: null,
    tenantId: tenantName,
    metadata: { source: (session.metadata as Record<string, string> | undefined)?.source },
  });

  return NextResponse.json({ received: true });
}
