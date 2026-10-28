import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { REV_SHARE_RATE } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export interface ReceiptEntry {
  id: string;
  tenantName: string;
  kind: string;
  amountCents: number;
  note: string | null;
  createdAt: string;
}

export interface ReceiptsPayload {
  scope: 'tenant' | 'book';
  tenantName: string | null;
  /** What the figure claims: defended margin or the 20% rev-share cut. */
  metric: 'defended' | 'revshare';
  /** Exact rows that produced the figure — nothing else contributes. */
  entries: ReceiptEntry[];
  /** Σ MARGIN_DEFENDED across the returned rows. */
  defendedCents: number;
  /** 20% cut derived server-side from defendedCents (revshare scope only). */
  derivedCents: number;
  /** Other ledger kinds in scope (setup/audit fees) — shown for completeness. */
  feeCents: number;
  rate: number;
  computedAt: string;
}

/**
 * GET /api/ledger/receipts — "show the work" endpoint (Feature: receipts on tap).
 * Every figure in the tower can be unfolded to the exact ledger rows that
 * produced it. No dashboard shows its receipts; the Command Deck does.
 *
 * Scopes:
 *   ?tenant=Apex Piping & Supply  → that tenant's rows (+ rollup)
 *   (no tenant)                   → whole-book MARGIN_DEFENDED rows
 *   &metric=revshare              → rollup shows the 20% cut derivation
 */
export async function GET(req: Request) {
  await ensureDb();

  const url = new URL(req.url);
  const tenant = url.searchParams.get('tenant')?.trim() || null;
  const metric = url.searchParams.get('metric') === 'revshare' ? 'revshare' : 'defended';

  const where = tenant ? { tenantName: tenant } : { kind: 'MARGIN_DEFENDED' };
  const rows = await db.ledgerEntry.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  const inScope = rows.filter((r) => r.kind === 'MARGIN_DEFENDED');
  const fees = rows.filter((r) => r.kind !== 'MARGIN_DEFENDED');

  const payload: ReceiptsPayload = {
    scope: tenant ? 'tenant' : 'book',
    tenantName: tenant,
    metric,
    entries: rows.map((r) => ({
      id: r.id,
      tenantName: r.tenantName,
      kind: r.kind,
      amountCents: r.amountCents,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    })),
    defendedCents: inScope.reduce((sum, r) => sum + r.amountCents, 0),
    derivedCents: metric === 'revshare' ? Math.round(inScope.reduce((sum, r) => sum + r.amountCents, 0) * REV_SHARE_RATE) : 0,
    feeCents: fees.reduce((sum, r) => sum + r.amountCents, 0),
    rate: REV_SHARE_RATE,
    computedAt: new Date().toISOString(),
  };

  return NextResponse.json(payload);
}
