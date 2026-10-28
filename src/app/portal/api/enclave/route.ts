import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sessionTenant } from '@/lib/portal-session';
import { AUDIT_BOOK_CONSTANTS, REV_SHARE_RATE } from '@/lib/audit';
import type { CallView, InterceptView } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface LedgerRowView {
  id: string;
  kind: string;
  amountCents: number;
  note: string | null;
  createdAt: string;
}

/** Task 19 — the client-visible reconciliation stamp (parsed from the Ship's Log). */
export interface ReconciliationStampView {
  stampedAt: string;
  /** True only when the stamp sentence starts with "self-audit passed". */
  ok: boolean;
  /** Independent-check count parsed from the stamp sentence — null when the format ever changes. */
  checks: number | null;
  /** Drift as displayed, e.g. "$0.00" — null when unparsable. */
  drift: string | null;
  /** The verbatim Ship's Log sentence — never rewritten for the client. */
  detail: string;
}

/** Task 19 — one row on the client's document shelf. */
export interface TenantDocumentView {
  id: string;
  fileName: string;
  sizeBytes: number;
  linesParsed: number | null;
  hitlCount: number;
  hitlRefs: string[];
  createdAt: string;
}

/**
 * Task 21 — one signed MARGIN_DEFENDED ledger row, the atom of the margin
 * graph. The client buckets these into daily / weekly / monthly columns, so
 * the payload ships the rows themselves instead of one pre-bucketed shape —
 * every granularity stays derived from the same server truth (R-01).
 */
export interface MarginEventView {
  /** ISO timestamp of the ledger row. */
  at: string;
  cents: number;
}

/**
 * Task 21 — the growth figure behind the money panel's headline number:
 * the rolling last-30-days against the 30 before it, summed from the same
 * ledger rows the chart renders. pct is null when the prior window is empty
 * — a percentage over zero is a fabrication, so the client falls back to
 * the absolute figure instead.
 */
export interface RecoveryDeltaView {
  last30dCents: number;
  prev30dCents: number;
  pct: number | null;
}

/** Task 20 — the full defense log behind the Defenses-tile panel. */
export interface DefenseRollupView {
  /** Every tenant-scoped defense — the count is the table's truth, not a sample. */
  total: number;
  byChannel: { channel: string; count: number }[];
  avgDiffCents: number;
  /** Newest first, capped at 50 — truncation is stated, never silent. */
  rows: InterceptView[];
}

/** Task 20 — the guarantee in plain terms, composed from the server constants. */
export interface GuaranteeView {
  label: string;
  passed: boolean;
  terms: string[];
  floorCents: number;
  /** Σ identified leakage across the tenant's linked audit records. */
  identifiedLeakageCents: number;
  /** The audit record the baseline traces to, when one is linked. */
  latestAudit: { dateSold: string; auditFeeCents: number } | null;
}

/** Task 20 — Syntropic's cut, derived in the open from the same rows. */
export interface MoneyCutView {
  rate: number;
  last30dDefendedCents: number;
  last30dCutCents: number;
  lifetimeCutCents: number;
}

/** Task 20 — the stage-driven billing line; every money figure is server-composed. */
export interface BillingView {
  stage: string;
  line: string;
  note: string | null;
  overdue: boolean;
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
    contactName: string;
    /** Task 20 — the lifecycle fact the money panel renders (DISCOVERY | SETUP | AUDIT | LIVE). */
    billingStage: string;
    paymentStatus: string;
  };
  marginDefendedCents: number;
  /** Margin defended in the trailing 24h — the motion the tower cards show. */
  last24hDeltaCents: number;
  defensesLogged: number;
  recentLedger: LedgerRowView[];
  intercepts: InterceptView[];
  calls: CallView[];
  documents: TenantDocumentView[];
  reconciliation: ReconciliationStampView | null;
  directLine: {
    /** When the team last cleared a client message — the "Seen" receipt clock. */
    lastSeenAt: string | null;
  };
  /** Task 20 — the four tiles become panels; these fields are their payloads. */
  feeLedger: LedgerRowView[];
  paidToDateCents: number;
  /** Task 21 — the raw signed margin rows the dot-matrix graph buckets client-side. */
  marginEvents: MarginEventView[];
  /** Task 21 — the server-computed last-30d vs prior-30d growth figure. */
  recoveryDelta: RecoveryDeltaView;
  defenseLog: DefenseRollupView;
  guarantee: GuaranteeView;
  cut: MoneyCutView;
  billing: BillingView;
  computedAt: string;
}

/** Tenant scope shared by ledger/intercept queries: FK first, exact-name fallback for honestly-unlinked legacy rows. */
const tenantScope = (id: string, name: string) => [
  { tenantId: id },
  { tenantId: null, tenantName: name },
];

/** CallSession spells the tenant field `clientName` — same linkage rule, own column. */
const callScope = (id: string, name: string) => [
  { tenantId: id },
  { tenantId: null, clientName: name },
];

/**
 * GET /portal/api/enclave — the logged-in tenant's enclave feed.
 * The tenant is derived from the session cookie and its epoch is checked
 * against Tenant.sessionEpoch — rotated/revoked invites kill live sessions.
 *
 * Task 19: intercepts match by FK (legacy rows fall back to exact name only —
 * the old prefix tolerance is gone), calls are genuinely upcoming and carry
 * their join link, the money trail and the reconciliation stamp are part of
 * the payload, and the document shelf reflects what the client uploaded.
 *
 * Task 20: the four tiles become clickable panels — the payload now carries
 * the money panel's fee ledger + stage-driven billing line (with Syntropic's
 * cut derived from REV_SHARE_RATE), the full defense log rollup, and the
 * guarantee terms/floor/trace composed from the server constants. Every
 * money figure is computed or composed here — R-01 holds.
 *
 * Task 21: the money panel's graph upgrades to a dot-matrix — the payload
 * now ships the signed MARGIN_DEFENDED rows themselves (marginEvents) so the
 * client can bucket them honestly at daily / weekly / monthly grain, plus a
 * server-computed recoveryDelta (last 30d vs the 30 before) behind the
 * headline number. Same rows, zero new queries, no pre-chewed buckets.
 */
export async function GET() {
  const tenant = await sessionTenant();
  if (!tenant) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  const tenantName = tenant.name;
  const scope = tenantScope(tenant.id, tenantName);

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const days30Ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const days60Ago = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  // Six calendar months back to today — the window the margin graph's rows
  // (and therefore every daily / weekly / monthly bucket) are drawn from.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCMonth(monthStart.getUTCMonth() - 5);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [agg, agg24, agg30, ledgerRows, feeRows, feeAgg, allIntercepts, interceptTotal, callRows, stamp, docRows, lastSeen, marginRows, tenantAudits] =
    await Promise.all([
      db.ledgerEntry.aggregate({
        where: { OR: scope, kind: 'MARGIN_DEFENDED' },
        _sum: { amountCents: true },
        _count: true,
      }),
      db.ledgerEntry.aggregate({
        where: { OR: scope, kind: 'MARGIN_DEFENDED', createdAt: { gte: dayAgo } },
        _sum: { amountCents: true },
      }),
      db.ledgerEntry.aggregate({
        where: { OR: scope, kind: 'MARGIN_DEFENDED', createdAt: { gte: days30Ago } },
        _sum: { amountCents: true },
      }),
      db.ledgerEntry.findMany({ where: { OR: scope }, orderBy: { createdAt: 'desc' }, take: 8 }),
      db.ledgerEntry.findMany({
        where: { OR: scope, kind: { in: ['SETUP_FEE', 'AUDIT_FEE'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      db.ledgerEntry.aggregate({
        where: { OR: scope, kind: { in: ['SETUP_FEE', 'AUDIT_FEE'] } },
        _sum: { amountCents: true },
      }),
      db.interceptEvent.findMany({
        where: { OR: scope },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      db.interceptEvent.count({ where: { OR: scope } }),
      db.callSession.findMany({
        where: {
          OR: callScope(tenant.id, tenantName),
          status: { in: ['SCHEDULED', 'CONFIRMED', 'LIVE'] },
          scheduledAt: { gte: startOfToday },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 6,
      }),
      db.commandLog.findFirst({ where: { action: 'RECONCILED' }, orderBy: { createdAt: 'desc' } }),
      db.tenantDocument.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'desc' },
        take: 24,
      }),
      db.message.findFirst({
        where: { tenantName, sender: { startsWith: 'Client' }, readAt: { not: null } },
        orderBy: { readAt: 'desc' },
        select: { readAt: true },
      }),
      db.ledgerEntry.findMany({
        where: { OR: scope, kind: 'MARGIN_DEFENDED', createdAt: { gte: monthStart } },
        select: { createdAt: true, amountCents: true },
      }),
      db.auditRecord.findMany({ where: { tenantId: tenant.id }, orderBy: { dateSold: 'desc' } }),
    ]);

  // Host names for the call cards (two tiny queries beat a cross-model include here).
  const hostIds = [...new Set(callRows.map((c) => c.hostId).filter((v): v is string => Boolean(v)))];
  const hosts = hostIds.length
    ? await db.teamMember.findMany({ where: { id: { in: hostIds } } })
    : [];
  const hostNameById = new Map(hosts.map((h) => [h.id, h.fullName || h.name]));

  const reconciliation: ReconciliationStampView | null = stamp
    ? (() => {
        const parsed = stamp.detail.match(/(\d+) independent checks?, drift \$([\d,.]+)/);
        return {
          stampedAt: stamp.createdAt.toISOString(),
          ok: stamp.detail.startsWith('self-audit passed'),
          checks: parsed ? Number(parsed[1]) : null,
          drift: parsed ? `$${parsed[2]}` : null,
          detail: stamp.detail,
        };
      })()
    : null;

  // ── Task 20 — the panel payloads. Composed here, never in the client. ──

  const usd0 = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
  const ratePct = Math.round(REV_SHARE_RATE * 100);
  const marginDefendedCents = agg._sum.amountCents ?? 0;
  const paidToDateCents = feeAgg._sum.amountCents ?? 0;

  // Task 21 — the margin graph's atoms: the signed rows themselves, oldest
  // first, capped defensively. The client buckets these per granularity; the
  // monthly sums it derives are the same ones this endpoint used to pre-chew.
  const marginEvents: MarginEventView[] = [...marginRows]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-200)
    .map((r) => ({ at: r.createdAt.toISOString(), cents: r.amountCents }));

  // The headline growth — rolling 30d vs the 30 before, from the same rows.
  const last30dCents = marginRows
    .filter((r) => r.createdAt >= days30Ago)
    .reduce((s, r) => s + r.amountCents, 0);
  const prev30dCents = marginRows
    .filter((r) => r.createdAt >= days60Ago && r.createdAt < days30Ago)
    .reduce((s, r) => s + r.amountCents, 0);
  const recoveryDelta: RecoveryDeltaView = {
    last30dCents,
    prev30dCents,
    pct: prev30dCents > 0 ? Math.round(((last30dCents - prev30dCents) / prev30dCents) * 100) : null,
  };

  // Full defense log rollup — the count query owns the total, rows cap at 50.
  const byChannelMap = new Map<string, number>();
  let diffSum = 0;
  for (const e of allIntercepts) {
    byChannelMap.set(e.channel, (byChannelMap.get(e.channel) ?? 0) + 1);
    diffSum += e.diffCents;
  }
  const defenseLog: DefenseRollupView = {
    total: interceptTotal,
    byChannel: [...byChannelMap.entries()]
      .map(([channel, count]) => ({ channel, count }))
      .sort((a, b) => b.count - a.count),
    avgDiffCents: interceptTotal > 0 ? Math.round(diffSum / interceptTotal) : 0,
    rows: allIntercepts.map((e) => ({
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
  };

  // The guarantee: terms from the constants, floor progress from the linked audits.
  const identifiedLeakageCents = tenantAudits.reduce((s, a) => s + a.identifiedLeakageCents, 0);
  const latest = tenantAudits[0] ?? null;
  const guarantee: GuaranteeView = {
    label: tenant.guaranteeLabel,
    passed: tenant.guaranteePassed,
    terms: [
      `${usd0(AUDIT_BOOK_CONSTANTS.diagnosticAuditFeeCents)} diagnostic audit — a 48-hour read of your margin, credited when you start`,
      `${usd0(AUDIT_BOOK_CONSTANTS.guaranteedFloorCents)} guaranteed floor of identified margin on every executed contract`,
      `${ratePct}% rev-share on the margin we defend — we earn when you keep`,
    ],
    floorCents: AUDIT_BOOK_CONSTANTS.guaranteedFloorCents,
    identifiedLeakageCents,
    latestAudit: latest ? { dateSold: latest.dateSold, auditFeeCents: latest.auditFeeCents } : null,
  };

  // Syntropic's cut — derived from the same rows the money trail prints.
  const last30dDefendedCents = agg30._sum.amountCents ?? 0;
  const cut: MoneyCutView = {
    rate: REV_SHARE_RATE,
    last30dDefendedCents,
    last30dCutCents: Math.round(last30dDefendedCents * REV_SHARE_RATE),
    lifetimeCutCents: Math.round(marginDefendedCents * REV_SHARE_RATE),
  };

  // The stage-driven billing line — every figure composed server-side (R-01).
  const contractCents = AUDIT_BOOK_CONSTANTS.contractValueCents;
  const diagnosticCents = AUDIT_BOOK_CONSTANTS.diagnosticAuditFeeCents;
  const overdue = tenant.paymentStatus === 'OVERDUE';
  const remainingCents = Math.max(0, contractCents - paidToDateCents);
  const billing: BillingView = { stage: tenant.billingStage, line: '', note: null, overdue };
  switch (tenant.billingStage) {
    case 'LIVE':
      billing.line = `Contract executed — ${usd0(paidToDateCents)}.`;
      billing.note = `Ongoing, Syntropic takes ${ratePct}% of what we defend for you — the cut below is computed in the open, from the same rows printed in your money trail.`;
      break;
    case 'AUDIT':
      billing.line = `Audit fee paid — ${usd0(paidToDateCents)}.`;
      billing.note = `The ${usd0(contractCents)} setup invoices only when your audit converts — everything we recover in the meantime is yours to keep.`;
      break;
    case 'SETUP':
      billing.line = `${usd0(paidToDateCents)} of ${usd0(contractCents)} collected — ${usd0(remainingCents)} remaining.`;
      billing.note = overdue
        ? 'An installment is overdue — your owner will reach out today. The enclave keeps defending margin meanwhile.'
        : 'Installments in progress — the enclave is already defending margin while the setup completes.';
      break;
    default:
      billing.line = `Nothing owed yet — the ${usd0(diagnosticCents)} diagnostic is invoiced when your audit begins, credited against setup.`;
      billing.note = `From day one we're paid ${ratePct}% of what we defend for you — never a dollar of the margin you keep.`;
  }

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
      contactName: tenant.contactName,
      billingStage: tenant.billingStage,
      paymentStatus: tenant.paymentStatus,
    },
    marginDefendedCents,
    last24hDeltaCents: agg24._sum.amountCents ?? 0,
    defensesLogged: agg._count,
    recentLedger: ledgerRows.map((l) => ({
      id: l.id,
      kind: l.kind,
      amountCents: l.amountCents,
      note: l.note,
      createdAt: l.createdAt.toISOString(),
    })),
    intercepts: defenseLog.rows.slice(0, 12),
    calls: callRows.map((c) => ({
      id: c.id,
      clientName: c.clientName,
      type: c.type,
      scheduledAt: c.scheduledAt.toISOString(),
      status: c.status,
      endsAt: c.endsAt ? c.endsAt.toISOString() : null,
      joinUrl: c.joinUrl,
      provider: c.provider,
      hostName: c.hostId ? hostNameById.get(c.hostId) ?? null : null,
    })),
    documents: docRows.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      sizeBytes: d.sizeBytes,
      linesParsed: d.linesParsed,
      hitlCount: d.hitlCount,
      hitlRefs: JSON.parse(d.hitlRefs) as string[],
      createdAt: d.createdAt.toISOString(),
    })),
    reconciliation,
    directLine: {
      lastSeenAt: lastSeen?.readAt ? lastSeen.readAt.toISOString() : null,
    },
    feeLedger: feeRows.map((l) => ({
      id: l.id,
      kind: l.kind,
      amountCents: l.amountCents,
      note: l.note,
      createdAt: l.createdAt.toISOString(),
    })),
    paidToDateCents,
    marginEvents,
    recoveryDelta,
    defenseLog,
    guarantee,
    cut,
    billing,
    computedAt: new Date().toISOString(),
  };

  return NextResponse.json(payload);
}
