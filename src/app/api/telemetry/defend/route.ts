import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { emit } from '@/lib/bus';
import { requireSecret } from '@/lib/guard';
import { REV_SHARE_RATE } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * POST /api/telemetry/defend — the production engine's write-API for margin
 * defenses. Guarded by ENGINE_WEBHOOK_KEY (x-engine-key header); the route
 * stays open with a dev warning while the key is unset.
 *
 * Body: { tenantName, amount (USD), vector?, sourceRef? }
 *
 * The margin lands on the LedgerEntry ledger (single source of truth, R-01),
 * surfaces on the live intercept stream, bumps the tenant's primary leakage
 * vector when provided, and fans out a defense event on the SSE bus.
 * Everything is cents-accurate server-side.
 */
export async function POST(req: Request) {
  const guard = requireSecret(req, process.env.ENGINE_WEBHOOK_KEY, 'x-engine-key');
  if (!guard.ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  await ensureDb();
  const b = await req.json().catch(() => ({} as Record<string, unknown>));
  const tenantName = typeof b.tenantName === 'string' ? b.tenantName.trim() : '';
  const amtUsd = Number(b.amount);
  if (!tenantName || !Number.isFinite(amtUsd) || amtUsd <= 0) {
    return NextResponse.json({ error: 'invalid_input', detail: 'tenantName and positive amount (USD) are required' }, { status: 422 });
  }

  const tenant = await db.tenant.findUnique({ where: { name: tenantName } });
  if (!tenant) return NextResponse.json({ error: 'unknown_tenant', detail: `No tenant named ${tenantName}` }, { status: 404 });

  const amountCents = Math.round(amtUsd * 100);
  const vector = typeof b.vector === 'string' && b.vector.trim() ? b.vector.trim() : null;
  const sourceRef = typeof b.sourceRef === 'string' ? b.sourceRef : null;

  const [, ledgerRow] = await db.$transaction([
    db.tenant.update({
      where: { name: tenantName },
      data: vector ? { leakageVector: vector } : {},
    }),
    db.ledgerEntry.create({
      data: {
        tenantName,
        tenantId: tenant.id, // Task 19 — FK linkage at write time
        kind: 'MARGIN_DEFENDED',
        amountCents,
        note: `Engine defense${sourceRef ? ` · ${sourceRef}` : ''}${vector ? ` · ${vector}` : ''}`,
      },
    }),
  ]);

  await db.interceptEvent.create({
    data: {
      tenantName,
      tenantId: tenant.id, // Task 19 — FK linkage at write time
      item: vector ? `Engine defense · ${vector}` : 'Engine defense',
      origCents: 0,
      defendedCents: amountCents,
      diffCents: amountCents,
      channel: 'Engine webhook',
      source: 'ENGINE',
    },
  });

  const total = await db.ledgerEntry.aggregate({
    where: { kind: 'MARGIN_DEFENDED', tenantName },
    _sum: { amountCents: true },
  });
  const totalDefendedCents = total._sum.amountCents ?? amountCents;

  emit({ type: 'defense', tenantName, amountCents, totalDefendedCents });

  return NextResponse.json({
    ok: true,
    tenantName,
    defendedCents: amountCents,
    defendedUsd: usd(amountCents),
    totalDefendedCents,
    syntropicCutCents: Math.round(amountCents * REV_SHARE_RATE),
    syntropicCutUsd: usd(Math.round(amountCents * REV_SHARE_RATE)),
    ...(guard.warn ? { warning: guard.warn } : {}),
  });
}
