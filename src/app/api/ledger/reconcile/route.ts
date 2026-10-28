import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureDb } from '@/lib/ensure-db';
import { logCommand } from '@/lib/command-log';
import { deriveAuditsClosed, REV_SHARE_RATE } from '@/lib/audit';
import { utcDay } from '@/lib/traffic';

export const dynamic = 'force-dynamic';

export interface ReconcileCheck {
  key: string;
  label: string;
  /** The figure the tower displays — /api/ledger's code path. */
  claimed: number | string;
  /** The figure recomputed independently — a different code path. */
  recomputed: number | string;
  match: boolean;
}

export interface ReconcilePayload {
  ok: boolean;
  checkedAt: string;
  /** Total cent-drift across every financial check. */
  driftCents: number;
  checks: ReconcileCheck[];
}

/**
 * GET /api/ledger/reconcile — the station audits itself (Feature: reconciliation stamp).
 *
 * Every headline figure is recomputed through a *different* code path than
 * /api/ledger uses — findMany + manual reduce vs aggregate, count() with
 * filters vs in-memory filters, raw TrafficEvents vs the incremental rollup
 * row — and the two paths are compared. The result becomes the masthead
 * stamp: `reconciled · drift $0`. Any drift is surfaced honestly, never hidden.
 */
export async function GET() {
  await ensureDb();

  // Path B — raw rows, manual reduction (Path A lives inside /api/ledger).
  const tenantNames = await db.tenant.findMany({ select: { name: true } }).then((ts) => ts.map((t) => t.name));
  const [rawEntries, rawTenants, rawAudits, rawTeam, trafficRows, summaryRow, aggMargin, aggAuditFee, countAll, countAudited, countPassed, countTenants, groupByTenant, rawCalls, rawIntercepts, orphanIntercepts, orphanLedger, orphanCalls] =
    await Promise.all([
      db.ledgerEntry.findMany(),
      db.tenant.findMany(),
      db.auditRecord.findMany(),
      db.teamMember.findMany(),
      db.trafficEvent.findMany({ where: { createdAt: { gte: utcDayFloor() } } }),
      db.liveTelemetrySummary.findUnique({ where: { date: utcDay() } }),
      db.ledgerEntry.aggregate({ where: { kind: 'MARGIN_DEFENDED' }, _sum: { amountCents: true } }),
      db.auditRecord.aggregate({ _sum: { auditFeeCents: true } }),
      db.ledgerEntry.count(),
      db.tenant.count({ where: { auditCompleted: true } }),
      db.tenant.count({ where: { auditCompleted: true, guaranteePassed: true } }),
      db.tenant.count(),
      db.ledgerEntry.groupBy({ by: ['tenantName'], where: { kind: 'MARGIN_DEFENDED' }, _sum: { amountCents: true } }),
      // Task 19 — enclave linkage: rows must resolve to a tenant by FK or exact name.
      db.callSession.findMany({ select: { tenantId: true, clientName: true } }),
      db.interceptEvent.findMany({ select: { tenantId: true, tenantName: true } }),
      db.interceptEvent.count({ where: { tenantId: null, tenantName: { notIn: tenantNames } } }),
      db.ledgerEntry.count({ where: { tenantId: null, tenantName: { notIn: tenantNames } } }),
      db.callSession.count({ where: { tenantId: null, clientName: { notIn: [...tenantNames, 'Internal'] } } }),
    ]);

  const marginRows = rawEntries.filter((e) => e.kind === 'MARGIN_DEFENDED');
  const marginByReduce = marginRows.reduce((s, e) => s + e.amountCents, 0);
  const marginByAggregate = aggMargin._sum.amountCents ?? 0;

  // Task 19 — enclave orphans, in-memory path (the SQL counts are the claimed path).
  const tenantNameSet = new Set(rawTenants.map((t) => t.name));
  const unlinkedOrphan = (r: { tenantId: string | null }, name: string) => !r.tenantId && !tenantNameSet.has(name);
  const orphanTotalInMemory =
    rawIntercepts.filter((r) => unlinkedOrphan(r, r.tenantName)).length +
    rawEntries.filter((r) => unlinkedOrphan(r, r.tenantName)).length +
    rawCalls.filter((c) => c.clientName !== 'Internal' && unlinkedOrphan(c, c.clientName)).length;
  const orphanTotalSql = orphanIntercepts + orphanLedger + orphanCalls;

  const checks: ReconcileCheck[] = [
    {
      key: 'margin_defended',
      label: 'Margin defended — aggregate view vs raw-row reduction',
      claimed: marginByAggregate,
      recomputed: marginByReduce,
      match: marginByAggregate === marginByReduce,
    },
    {
      key: 'rev_share',
      label: 'Syntropic 20% rev-share — derived from the two margin paths',
      claimed: Math.round(marginByAggregate * REV_SHARE_RATE),
      recomputed: Math.round(marginByReduce * REV_SHARE_RATE),
      match: Math.round(marginByAggregate * REV_SHARE_RATE) === Math.round(marginByReduce * REV_SHARE_RATE),
    },
    {
      key: 'per_tenant_sums',
      label: 'Per-tenant totals — groupBy vs raw-row reduction (must agree per tenant)',
      claimed: groupByTenant.map((g) => `${g.tenantName}:${g._sum.amountCents ?? 0}`).sort().join(' | '),
      recomputed: Object.entries(
        marginRows.reduce<Record<string, number>>((acc, e) => {
          acc[e.tenantName] = (acc[e.tenantName] ?? 0) + e.amountCents;
          return acc;
        }, {}),
      )
        .map(([name, cents]) => `${name}:${cents}`)
        .sort()
        .join(' | '),
      match:
        groupByTenant.map((g) => `${g.tenantName}:${g._sum.amountCents ?? 0}`).sort().join(' | ') ===
        Object.entries(
          marginRows.reduce<Record<string, number>>((acc, e) => {
            acc[e.tenantName] = (acc[e.tenantName] ?? 0) + e.amountCents;
            return acc;
          }, {}),
        )
          .map(([name, cents]) => `${name}:${cents}`)
          .sort()
          .join(' | '),
    },
    {
      key: 'ledger_rows',
      label: 'Ledger integrity — count() vs full scan length',
      claimed: countAll,
      recomputed: rawEntries.length,
      match: countAll === rawEntries.length,
    },
    {
      key: 'active_accounts',
      label: 'Active accounts — findMany length vs count()',
      claimed: rawTenants.length,
      recomputed: countTenants,
      match: rawTenants.length === countTenants,
    },
    {
      key: 'audited_accounts',
      label: 'Audited accounts — in-memory filter vs count(where)',
      claimed: rawTenants.filter((t) => t.auditCompleted).length,
      recomputed: countAudited,
      match: rawTenants.filter((t) => t.auditCompleted).length === countAudited,
    },
    {
      key: 'guarantee_passed',
      label: 'Guarantee passed — in-memory filter vs count(where)',
      claimed: rawTenants.filter((t) => t.auditCompleted && t.guaranteePassed).length,
      recomputed: countPassed,
      match: rawTenants.filter((t) => t.auditCompleted && t.guaranteePassed).length === countPassed,
    },
    {
      key: 'traffic_summary',
      label: "Today's funnel — incremental rollup row vs raw TrafficEvent recompute",
      claimed: summaryRow ? `${summaryRow.totalVisitors}/${summaryRow.uniqueSessions}` : 'no rollup row',
      recomputed: `${trafficRows.length}/${new Set(trafficRows.map((r) => r.sessionId)).size}`,
      // The rollup row is born with the day's first traffic event — so "no row"
      // only agrees with the raw path while the raw count is also zero. Past
      // that, a missing row beside real traffic is exactly the drift the stamp
      // exists to surface (pre-Task-22 this flagged every quiet UTC morning).
      match: summaryRow
        ? summaryRow.totalVisitors === trafficRows.length && summaryRow.uniqueSessions === new Set(trafficRows.map((r) => r.sessionId)).size
        : trafficRows.length === 0,
    },
    {
      key: 'audit_revenue',
      label: 'Audit revenue — fee aggregate vs raw AuditRecord row reduction',
      claimed: aggAuditFee._sum.auditFeeCents ?? 0,
      recomputed: rawAudits.reduce((s, a) => s + a.auditFeeCents, 0),
      match: (aggAuditFee._sum.auditFeeCents ?? 0) === rawAudits.reduce((s, a) => s + a.auditFeeCents, 0),
    },
    {
      key: 'audits_closed',
      label: 'Audits sold — derived from record host attribution vs stored founder counters',
      claimed: Object.entries(deriveAuditsClosed(rawAudits, rawTeam))
        .map(([name, n]) => `${name}:${n}`)
        .sort()
        .join(' | '),
      recomputed: rawTeam
        .map((m) => `${m.name}:${m.auditsClosed}`)
        .sort()
        .join(' | '),
      match:
        JSON.stringify(
          Object.entries(deriveAuditsClosed(rawAudits, rawTeam))
            .map(([name, n]) => `${name}:${n}`)
            .sort(),
        ) ===
        JSON.stringify(rawTeam.map((m) => `${m.name}:${m.auditsClosed}`).sort()),
    },
    {
      key: 'enclave_links',
      label: 'Enclave linkage — every intercept, ledger row, and client call resolves to a tenant',
      claimed: orphanTotalSql,
      recomputed: orphanTotalInMemory,
      // The invariant is stricter than path agreement: zero orphans, ever.
      match: orphanTotalSql === orphanTotalInMemory && orphanTotalSql === 0,
    },
  ];

  const driftCents = checks
    .filter((c) => typeof c.claimed === 'number' && typeof c.recomputed === 'number')
    .reduce((s, c) => s + Math.abs((c.claimed as number) - (c.recomputed as number)), 0);

  const payload: ReconcilePayload = {
    ok: checks.every((c) => c.match),
    checkedAt: new Date().toISOString(),
    driftCents,
    checks,
  };

  await logCommand({
    actor: 'Engine',
    action: 'RECONCILED',
    target: 'financial ledger',
    detail: payload.ok
      ? `self-audit passed — ${checks.length} independent checks, drift $0`
      : `self-audit flagged drift of $${(driftCents / 100).toFixed(2)} across ${checks.filter((c) => !c.match).length} check(s)`,
  });

  return NextResponse.json(payload);
}

function utcDayFloor(): Date {
  return new Date(`${utcDay()}T00:00:00.000Z`);
}
