import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { assignFounder } from '@/lib/assign';
import { checkoutConfigured, createCheckoutSession } from '@/lib/stripe';
import { clientIp, rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/checkout — opens a Stripe Checkout session for the $3,500
 * Diagnostic Audit deposit. Body: { email, company, erp?, rfqVolume?, source? }.
 *
 * The tenant row is created/refreshed BEFORE payment (status: intake) and
 * least-load assigned; the Stripe session carries the tenant name in
 * client_reference_id + metadata so the webhook can bind the payment.
 * 501 until STRIPE_SECRET_KEY + STRIPE_PRICE_ID are configured.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`checkout:${ip}`, 6, 10 * 60e3)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  if (!checkoutConfigured()) {
    return NextResponse.json({ error: 'checkout_not_configured', detail: 'Set STRIPE_SECRET_KEY + STRIPE_PRICE_ID to enable deposits.' }, { status: 501 });
  }

  await ensureDb();
  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const email = String(b.email ?? '').trim().toLowerCase();
  const company = String(b.company ?? '').trim();
  if (!EMAIL_RE.test(email) || !company) {
    return NextResponse.json({ error: 'invalid_input', detail: 'A valid email and company name are required' }, { status: 422 });
  }

  const founder = await assignFounder();
  const existing = await db.tenant.findFirst({ where: { OR: [{ contactEmail: email }, { name: company }] } });
  let tenantName: string;
  if (existing) {
    await db.tenant.update({ where: { id: existing.id }, data: { assignedToId: founder.id, owner: founder.name, contactEmail: email } });
    tenantName = existing.name;
  } else {
    const maxSort = await db.tenant.aggregate({ _max: { sortOrder: true } });
    try {
      const created = await db.tenant.create({
        data: {
          name: company,
          erp: String(b.erp ?? '').trim() || 'Unknown',
          status: 'Intake received — deposit pending',
          stage: 'Audit deposit pending',
          depositLabel: 'Audit deposit pending',
          guaranteeLabel: 'Awaiting diagnostic audit',
          owner: founder.name,
          contactEmail: email,
          rfqMonthlyVolume: Math.max(0, Math.round(Number(b.rfqVolume ?? 0) || 0)),
          assignedToId: founder.id,
          sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
        },
      });
      tenantName = created.name;
    } catch {
      return NextResponse.json({ error: 'conflict', detail: 'A tenant with that name already exists' }, { status: 409 });
    }
  }

  try {
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const session = await createCheckoutSession({
      tenantName,
      email,
      origin,
      source: typeof b.source === 'string' ? b.source : 'unknown',
    });
    return NextResponse.json({ url: session.url, tenantName });
  } catch (e) {
    return NextResponse.json({ error: 'stripe_error', detail: e instanceof Error ? e.message : 'unknown' }, { status: 502 });
  }
}
