import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import type { CallView, InterceptView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface LedgerRowView {
  id: string;
  kind: string;
  amountCents: number;
  note: string | null;
  createdAt: string;
}

export interface PortalEnclaveView {
  tenant: {
    name: string;
    erp: string;
    status: string;
    stage: string;
    depositLabel: string;
    guaranteeLabel: string;
    guaranteePassed: boolean;
    owner: string;
  };
  marginDefendedCents: number;
  defensesLogged: number;
  recentLedger: LedgerRowView[];
  intercepts: InterceptView[];
  calls: CallView[];
  computedAt: string;
}

/**
 * GET /api/portal?tenant=<name> — Layer 3 Executive Enclave feed (tower-side
 * demo twin of /portal/api/enclave). Everything is computed server-side from
 * the same ledger the Command Tower reads (single source of truth, R-01).
 * Task 19: intercepts and calls match by tenant FK, with exact-name fallback
 * for honestly-unlinked legacy rows — no prefix tolerance.
 */
export async function GET(req: Request) {
  await ensureDb();
  const name = new URL(req.url).searchParams.get('tenant');
  if (!name) {
    return NextResponse.json({ error: 'tenant query parameter is required' }, { status: 400 });
  }

  // Task 19 — FK-first matching; exact-name fallback for honestly-unlinked
  // legacy rows. The old prefix tolerance is gone (it could cross-match two
  // tenants whose names share a leading substring).
  const tenant = await db.tenant.findUnique({ where: { name } });
  if (!tenant) {
    return NextResponse.json({ error: `Unknown tenant ${name}` }, { status: 404 });
  }

  const [agg, ledgerRows, allIntercepts, calls] = await Promise.all([
    db.ledgerEntry.aggregate({
      where: { OR: [{ tenantId: tenant.id }, { tenantId: null, tenantName: name }], kind: 'MARGIN_DEFENDED' },
      _sum: { amountCents: true },
      _count: true,
    }),
    db.ledgerEntry.findMany({ where: { OR: [{ tenantId: tenant.id }, { tenantId: null, tenantName: name }] }, orderBy: { createdAt: 'desc' }, take: 6 }),
    db.interceptEvent.findMany({
      where: { OR: [{ tenantId: tenant.id }, { tenantId: null, tenantName: name }] },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
    db.callSession.findMany({ where: { OR: [{ tenantId: tenant.id }, { tenantId: null, clientName: name }] }, orderBy: { scheduledAt: 'asc' } }),
  ]);

  const payload: PortalEnclaveView = {
    tenant: {
      name: tenant.name,
      erp: tenant.erp,
      status: tenant.status,
      stage: tenant.stage,
      depositLabel: tenant.depositLabel,
      guaranteeLabel: tenant.guaranteeLabel,
      guaranteePassed: tenant.guaranteePassed,
      owner: tenant.owner,
    },
    marginDefendedCents: agg._sum.amountCents ?? 0,
    defensesLogged: agg._count,
    recentLedger: ledgerRows.map((l) => ({
      id: l.id,
      kind: l.kind,
      amountCents: l.amountCents,
      note: l.note,
      createdAt: l.createdAt.toISOString(),
    })),
    intercepts: allIntercepts.map((e) => ({
      id: e.id,
      tenantName: e.tenantName,
      item: e.item,
      origCents: e.origCents,
      defendedCents: e.defendedCents,
      diffCents: e.diffCents,
      channel: e.channel,
      source: e.source,
      createdAt: e.createdAt.toISOString(),
    })),
    calls: calls.map((c) => ({
      id: c.id,
      clientName: c.clientName,
      type: c.type,
      scheduledAt: c.scheduledAt.toISOString(),
      status: c.status,
    })),
    computedAt: new Date().toISOString(),
  };

  return NextResponse.json(payload);
}
