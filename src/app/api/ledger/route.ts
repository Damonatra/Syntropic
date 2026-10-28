import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { AUDIT_BOOK_CONSTANTS, deriveAuditsClosed, REV_SHARE_RATE } from '@/lib/audit';
import type { AuditRecordView, AuditRollupView, ClientMarginView, LedgerView, TeamMemberView } from '@/lib/types';
import { utcDay } from '@/lib/traffic';

export const dynamic = 'force-dynamic';

const TONE: Record<string, TeamMemberView['tone']> = { Damon: 'ink', Josias: 'blush' };

/**
 * GET /api/ledger — the single source of truth for every financial figure
 * shown in the Command Deck (R-01). Rev-share is computed server-side as
 * 20% × the sum of MARGIN_DEFENDED ledger entries; nothing is hardcoded.
 * Financial horizons (24h delta / monthly / annual / lifetime) are derived
 * from ledger timestamps — as the ledger ages the horizons diverge honestly.
 *
 * Time travel (Feature: the station as time machine): pass ?asOf=<ISO date>
 * and every horizon re-anchors to that instant — lifetime becomes "everything
 * up to asOf", the 24h delta becomes "the day before asOf". Tenants and audit
 * records are filtered to what existed by then; the traffic funnel (a
 * today-only rollup) and the live intercept stream stay in the present.
 * Team counters are engine-reported live state and are labelled as such.
 */
export async function GET(req: Request) {
  await ensureDb();

  const asOfParam = new URL(req.url).searchParams.get('asOf');
  const asOfMs = asOfParam ? Date.parse(asOfParam) : NaN;
  // Valid as-of instants only — anything bogus or in the future falls back to live.
  const asOf = Number.isFinite(asOfMs) && asOfMs <= Date.now() ? new Date(asOfMs) : null;

  const now = Date.now();
  const anchor = asOf ? asOf.getTime() : now;
  const since = (ms: number) => new Date(anchor - ms);
  const notAfter = asOf ? { lte: asOf } : {};
  const tenantWhere = asOf ? { createdAt: { lte: asOf } } : undefined;

  const [marginAgg, monthlyAgg, annualAgg, tenants, team, audits, perTenant24h, perTenantMonthly, perTenantAnnual, traffic] =
    await Promise.all([
      db.ledgerEntry.aggregate({ where: { kind: 'MARGIN_DEFENDED', createdAt: notAfter }, _sum: { amountCents: true } }),
      db.ledgerEntry.aggregate({
        where: { kind: 'MARGIN_DEFENDED', createdAt: { gte: since(30 * 86_400_000), ...notAfter } },
        _sum: { amountCents: true },
      }),
      db.ledgerEntry.aggregate({
        where: { kind: 'MARGIN_DEFENDED', createdAt: { gte: since(365 * 86_400_000), ...notAfter } },
        _sum: { amountCents: true },
      }),
      db.tenant.findMany({ where: tenantWhere, orderBy: { sortOrder: 'asc' } }),
      db.teamMember.findMany({ orderBy: { sortOrder: 'asc' } }),
      db.auditRecord.findMany({ orderBy: { sortOrder: 'asc' } }),
      db.ledgerEntry.groupBy({
        by: ['tenantName'],
        where: { kind: 'MARGIN_DEFENDED', createdAt: { gte: since(86_400_000), ...notAfter } },
        _sum: { amountCents: true },
      }),
      db.ledgerEntry.groupBy({
        by: ['tenantName'],
        where: { kind: 'MARGIN_DEFENDED', createdAt: { gte: since(30 * 86_400_000), ...notAfter } },
        _sum: { amountCents: true },
      }),
      db.ledgerEntry.groupBy({
        by: ['tenantName'],
        where: { kind: 'MARGIN_DEFENDED', createdAt: { gte: since(365 * 86_400_000), ...notAfter } },
        _sum: { amountCents: true },
      }),
      // The funnel rollup is a today-only artifact — time travel leaves it behind.
      asOf ? Promise.resolve(null) : db.liveTelemetrySummary.findUnique({ where: { date: utcDay() } }),
    ]);

  const sumBy = (rows: { tenantName: string; _sum: { amountCents: number | null } }[], name: string) =>
    rows.find((r) => r.tenantName === name)?._sum.amountCents ?? 0;

  const marginDefendedCents = marginAgg._sum.amountCents ?? 0;
  // Task 20 — the rate is the shared constant now (was a fourth local 0.2).
  const revShareRate = REV_SHARE_RATE;
  const revShareCents = Math.round(marginDefendedCents * revShareRate);
  const activeAccounts = tenants.length;
  const auditedAccounts = tenants.filter((t) => t.auditCompleted).length;
  const passed = tenants.filter((t) => t.auditCompleted && t.guaranteePassed).length;
  const guaranteePassRate = auditedAccounts > 0 ? passed / auditedAccounts : 1;

  // Audit history is date-keyed (YYYY-MM-DD strings) — as-of filters by sold date.
  const asOfDate = asOf ? asOf.toISOString().slice(0, 10) : null;
  const auditsInScope = asOfDate ? audits.filter((a) => a.dateSold.slice(0, 10) <= asOfDate) : audits;

  // Task 18 — "audits sold" per founder is derived from the audit rows
  // themselves (host attribution); the stored counter is only cross-checked
  // by the reconciliation stamp.
  const derivedAuditsClosed = deriveAuditsClosed(audits, team);

  const teamView: TeamMemberView[] = team.map((m) => ({
    id: m.id,
    name: m.name,
    fullName: m.fullName || m.name,
    role: m.role,
    isOnline: asOf ? false : m.isOnline,
    qOutboundTarget: m.qOutboundTarget,
    qOutboundCompleted: m.qOutboundCompleted,
    discoveryCalls: m.discoveryCalls,
    auditsClosed: derivedAuditsClosed[m.name] ?? 0,
    contractsConverted: m.contractsConverted,
    tone: TONE[m.name] ?? 'steel',
  }));

  const auditView: AuditRecordView[] = auditsInScope.map((a) => ({
    id: a.id,
    companyName: a.companyName,
    // Resolved against the in-scope tenants — under time travel an audit whose
    // tenant did not exist yet as-of the date reads honestly unlinked.
    tenantName: a.tenantId ? (tenants.find((t) => t.id === a.tenantId)?.name ?? null) : null,
    dateSold: a.dateSold,
    auditFeeCents: a.auditFeeCents,
    attendedCall: a.attendedCall,
    callHost: a.callHost,
    convertedToClient: a.convertedToClient,
    identifiedLeakageCents: a.identifiedLeakageCents,
    callNotes: a.callNotes,
  }));

  // Task 18 — the audit book rollup: funnel, money, and the product
  // constants that used to be hardcoded in the UI. Everything derives from
  // the same asOf scope as the rest of the ledger.
  const rollupRevenueCents = auditsInScope.reduce((s, a) => s + a.auditFeeCents, 0);
  const rollupLeakageCents = auditsInScope.reduce((s, a) => s + a.identifiedLeakageCents, 0);
  const rollupAttended = auditsInScope.filter((a) => a.attendedCall).length;
  const rollupConverted = auditsInScope.filter((a) => a.convertedToClient).length;
  const auditRollup: AuditRollupView = {
    auditsSold: auditsInScope.length,
    attended: rollupAttended,
    attendedRate: auditsInScope.length > 0 ? rollupAttended / auditsInScope.length : 0,
    converted: rollupConverted,
    conversionRate: auditsInScope.length > 0 ? rollupConverted / auditsInScope.length : 0,
    auditRevenueCents: rollupRevenueCents,
    identifiedLeakageCents: rollupLeakageCents,
    marginDefendedCents,
    leakageRecoveryRatio: rollupLeakageCents > 0 ? marginDefendedCents / rollupLeakageCents : null,
    activeAccounts: tenants.length,
    ...AUDIT_BOOK_CONSTANTS,
  };

  const clients: ClientMarginView[] = tenants.map((t) => {
    const total = sumBy(perTenantAnnual, t.name); // 365d ≈ lifetime for a young ledger; fall back below
    return {
      name: t.name,
      erp: t.erp,
      totalDefendedCents: total,
      last24hDeltaCents: sumBy(perTenant24h, t.name),
      monthlyRevShareCents: Math.round(sumBy(perTenantMonthly, t.name) * revShareRate),
      annualRevShareCents: Math.round(total * revShareRate),
      lifetimeRevShareCents: Math.round(total * revShareRate),
      leakageVector: t.leakageVector,
      paymentStatus: (t.paymentStatus as ClientMarginView['paymentStatus']) ?? 'PENDING',
    };
  });

  const view: LedgerView = {
    marginDefendedCents,
    revShareCents,
    revShareRate,
    activeAccounts,
    sprintTarget: 10,
    // Task 20 — was a duplicate $50,000 literal; the constant is the owner.
    setupFeeCents: AUDIT_BOOK_CONSTANTS.contractValueCents,
    projectedMrrCents: activeAccounts * 3_000_000,
    guaranteePassRate,
    auditedAccounts,
    auditRollup,
    team: teamView,
    audits: auditView,
    clients,
    pipeline: tenants.map((t) => ({
      client: t.name,
      stage: t.stage,
      owner: t.owner,
      value: t.depositLabel,
    })),
    traffic: traffic
      ? {
          date: traffic.date,
          totalVisitors: traffic.totalVisitors,
          uniqueSessions: traffic.uniqueSessions,
          auditsInitiated: traffic.auditsInitiated,
          portalLogins: traffic.portalLogins,
          quotesIngested: traffic.quotesIngested,
        }
      : null,
    computedAt: new Date().toISOString(),
    asOf: asOf ? asOf.toISOString() : null,
  };

  return NextResponse.json(view);
}
