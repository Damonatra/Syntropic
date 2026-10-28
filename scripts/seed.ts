/**
 * Syntropic Backbone — deterministic seed (R-02)
 * Run: bun run scripts/seed.ts
 * Reconciles the audit findings:
 *  - 4 tenants everywhere (fixes 4-vs-2 account count mismatch)
 *  - 3 audited accounts, 3/3 guarantee passed → "100% passed" is derivable
 *  - Ledger MARGIN_DEFENDED sums to exactly $71,400 → rev-share 20% = $14,280
 *  - Midwest mailbox LOCKED + Gulf mailbox MISSING → dispatch-failure rerouting demos
 */
import { PrismaClient } from '@prisma/client';
import { hashCode } from '../src/lib/portal-auth';
import { codeHint } from '../src/lib/invites';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const db = new PrismaClient();

const now = Date.now();
const MIN = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const at = (minsAgo: number, h?: number, m?: number) => {
  if (h !== undefined) {
    const d = new Date();
    d.setHours(h, m ?? 0, 0, 0);
    return d;
  }
  return new Date(now - minsAgo * MIN);
};
const daysFromNow = (days: number, h: number, m: number) => {
  const d = new Date(now + days * 86_400_000);
  d.setHours(h, m, 0, 0);
  return d;
};

async function main() {
  await db.notification.deleteMany();
  await db.founderAbsence.deleteMany();
  await db.callSession.deleteMany();
  await db.message.deleteMany();
  await db.tenantDocument.deleteMany(); // files on disk stay — the shelf is rebuilt from the seed
  await db.ledgerEntry.deleteMany();
  await db.interceptEvent.deleteMany();
  await db.hitlItem.deleteMany();
  await db.founderAbsence.deleteMany();
  await db.auditRecord.deleteMany();
  await db.teamMember.deleteMany();
  await db.tenantInvite.deleteMany();
  await db.tenant.deleteMany();
  await db.magicLinkToken.deleteMany();
  await db.trafficEvent.deleteMany();
  await db.liveTelemetrySummary.deleteMany();
  await db.commandLog.deleteMany();

  // ── Tenants (4 — reconciled) ─────────────────────────────────
  // createdAt is backdated to plausible enrollment dates so the time-travel
  // scrubber shows honest account counts as of past instants (Feature 5).
  await db.tenant.createMany({
    data: [
      {
        name: 'Apex Piping & Supply', erp: 'Epicor P21', status: '48-hr audit active',
        stage: '48-hr audit briefing ready', depositLabel: '$3,500 audit paid',
        guaranteeLabel: 'Exceeded — $14,200 identified', guaranteePassed: true, auditCompleted: true,
        owner: 'Damon / Josias', mailboxStatus: 'ACTIVE', mailboxNote: null, sortOrder: 1,
        accessCodeHash: hashCode('apex-defend-26'), contactName: 'Chris', contactEmail: 'chris@apexpiping.com',
        leakageVector: 'Unapplied Copper SPAs', paymentStatus: 'PAID',
        createdAt: new Date(now - 50 * D),
      },
      {
        name: 'Midwest Trade Wholesale', erp: 'Infor SX.e', status: 'Live rev-share',
        stage: 'Active rev-share enclave', depositLabel: '$50,000 contract executed',
        guaranteeLabel: 'Active — defended weekly', guaranteePassed: true, auditCompleted: true,
        owner: 'Josias', mailboxStatus: 'LOCKED',
        mailboxNote: 'Mailbox locked — provider migration window', sortOrder: 2,
        accessCodeHash: hashCode('midwest-defend-26'), contactName: 'Dana', contactEmail: 'dana@midwesttrade.com',
        leakageVector: 'Outdated vendor cost-sheet lag', paymentStatus: 'PAID',
        createdAt: new Date(now - 42 * D),
      },
      {
        name: 'Summit Industrial Fasteners', erp: 'Eclipse',
        status: 'Onboarding — setup fee in progress', stage: 'Setup fee collection underway',
        depositLabel: '$15,000 of $50,000 collected', guaranteeLabel: 'Baseline audit passed',
        guaranteePassed: true, auditCompleted: true,
        owner: 'Damon', mailboxStatus: 'ACTIVE', mailboxNote: null, sortOrder: 3,
        accessCodeHash: hashCode('summit-onboard-26'), contactName: 'Marc', contactEmail: 'marc@summitindustrial.com',
        leakageVector: 'Unapplied volume-tier discounts', paymentStatus: 'OVERDUE',
        createdAt: new Date(now - 18 * D),
      },
      {
        name: 'Gulf Coast Valve & Fitting', erp: 'NetSuite',
        status: 'Discovery — contract out', stage: 'Proposal issued, audit scheduled',
        depositLabel: 'Setup fee not yet invoiced', guaranteeLabel: 'Awaiting diagnostic audit',
        guaranteePassed: false, auditCompleted: false,
        owner: 'Damon', mailboxStatus: 'MISSING',
        mailboxNote: 'No Outlook mailbox provisioned yet', sortOrder: 4,
        accessCodeHash: hashCode('gulf-pilot-26'), contactName: 'Elena', contactEmail: 'elena@gulfcoastvalve.com',
        leakageVector: 'Unmapped freight surcharges', paymentStatus: 'PENDING',
        createdAt: new Date(now - 4 * D),
      },
    ],
  });

  // ── Portal invite ledger (replaces demo codes) ────────────────
  // The plaintext codes exist only in this seed run; the ledger stores
  // hashes + masked hints. Accepted = client already signed in once.
  const invite = (
    tenantName: string, email: string, code: string, issuedBy: string,
    status: 'PENDING' | 'ACCEPTED', acceptedMinsAgo?: number,
  ) => ({
    tenantName, email, codeHash: hashCode(code), codeHint: codeHint(code),
    issuedBy, status, acceptedAt: acceptedMinsAgo !== undefined ? at(acceptedMinsAgo) : null,
  });
  await db.tenantInvite.createMany({
    data: [
      invite('Apex Piping & Supply', 'chris@apexpiping.com', 'apex-defend-26', 'Damon', 'ACCEPTED', 3 * 24 * 60),
      invite('Midwest Trade Wholesale', 'dana@midwesttrade.com', 'midwest-defend-26', 'Josias', 'ACCEPTED', 5 * 24 * 60),
      invite('Summit Industrial Fasteners', 'marc@summitindustrial.com', 'summit-onboard-26', 'Damon', 'PENDING'),
      invite('Gulf Coast Valve & Fitting', 'elena@gulfcoastvalve.com', 'gulf-pilot-26', 'Damon', 'PENDING'),
    ],
  });

  // ── Team arena (quarterly targets & conversion counters) ─────
  // Founders-only per the revised telemetry deck: Damon vs. Josias.
  // Telegram chat ids + operator emails come from env when configured —
  // they drive per-founder alert routing and magic-link sign-in.
  await db.teamMember.createMany({
    data: [
      {
        name: 'Damon', fullName: 'Damon Matara', role: 'Lead Architect & Founder', isOnline: true,
        qOutboundTarget: 200, qOutboundCompleted: 142, discoveryCalls: 18,
        // Stored counter — the tower displays the server-DERIVED count from
        // AuditRecord host attribution (Task 18); this row is the reconcile
        // cross-check. Joint-hosted audits credit both founders (2/2).
        auditsClosed: 2, contractsConverted: 2, sortOrder: 1,
        telegramChatId: process.env.TELEGRAM_CHAT_ID_DAMON ?? null,
        email: process.env.OPERATOR_EMAIL_DAMON ?? null,
      },
      {
        name: 'Josias', fullName: 'Josias', role: 'Enterprise Execution Lead', isOnline: true,
        qOutboundTarget: 150, qOutboundCompleted: 110, discoveryCalls: 14,
        auditsClosed: 2, contractsConverted: 2, sortOrder: 2,
        telegramChatId: process.env.TELEGRAM_CHAT_ID_JOSIAS ?? null,
        email: process.env.OPERATOR_EMAIL_JOSIAS ?? null,
      },
    ],
  });

  // ── Founder assignment backfill (least-loaded intake relation) ──
  const members = await db.teamMember.findMany();
  const tenantsAll = await db.tenant.findMany();
  for (const t of tenantsAll) {
    const first = t.owner.split('/')[0]?.trim();
    const m = members.find((x) => x.name === first) ?? members.find((x) => x.name === t.owner);
    if (m) await db.tenant.update({ where: { id: t.id }, data: { assignedToId: m.id } });
  }

  // ── Audit guarantee vault (sales & conversion history) ───────
  await db.auditRecord.createMany({
    data: [
      {
        companyName: 'Apex Piping & Supply', dateSold: '2026-10-12', auditFeeCents: 350_000,
        attendedCall: true, callHost: 'Damon & Josias', convertedToClient: true,
        identifiedLeakageCents: 1_845_000,
        callNotes: 'VP of Ops presented 20 raw quote PDFs. Docling OCR detected $18.4k leakage. Client executed $50k agreement on call.',
        sortOrder: 1,
      },
      {
        companyName: 'Midwest Trade Wholesale', dateSold: '2026-10-15', auditFeeCents: 350_000,
        attendedCall: true, callHost: 'Josias', convertedToClient: true,
        identifiedLeakageCents: 1_420_000,
        callNotes: 'Walked through Outlook native draft injection demo. Client signed $50k contract after reviewing spatial bounding boxes.',
        sortOrder: 2,
      },
      {
        companyName: 'Gulf Coast Valve & Fitting', dateSold: '2026-10-20', auditFeeCents: 350_000,
        attendedCall: false, callHost: 'Damon', convertedToClient: false,
        identifiedLeakageCents: 1_180_000,
        callNotes: 'Prospect missed 10:00 AM briefing call due to warehouse emergency. Follow-up sequence dispatched.',
        sortOrder: 3,
      },
    ],
  });

  // ── Audit → tenant linkage (Task 18 single-source-of-truth): exact
  // case-insensitive name match; unmatched rows stay honestly unlinked.
  {
    const [auditRows, tenantRows] = await Promise.all([db.auditRecord.findMany(), db.tenant.findMany()]);
    for (const a of auditRows) {
      const t = tenantRows.find((x) => x.name.toLowerCase() === a.companyName.toLowerCase());
      if (t) await db.auditRecord.update({ where: { id: a.id }, data: { tenantId: t.id } });
    }
  }

  // ── HITL queue (2 pending low-confidence OCR items) ──────────
  await db.hitlItem.createMany({
    data: [
      {
        ref: 'HITL-8092', kind: 'OCR_LOW_CONFIDENCE', tenantName: 'Apex Piping & Supply',
        pdfName: 'Customer_RFQ_Spec_882.csv', skuParsed: 'PVC-SCH80-2IN-COUPLING [Qty: 450]',
        confidenceScore: 88.4, extractedMarginLossCents: 142_050, status: 'PENDING',
        createdAt: at(12),
      },
      {
        ref: 'HITL-8093', kind: 'OCR_LOW_CONFIDENCE', tenantName: 'Midwest Trade Wholesale',
        pdfName: 'RFQ_Vendor_Cost_Sheet_Q3.csv', skuParsed: 'COPPER-PIPE-L-1/2IN [Qty: 1200]',
        confidenceScore: 91.2, extractedMarginLossCents: 385_000, status: 'PENDING',
        createdAt: at(28),
      },
    ],
  });

  // ── Financial ledger — MARGIN_DEFENDED sums to $71,400 ───────
  // Entries are time-spread so the financial horizons (24h / monthly /
  // annual / lifetime) diverge honestly: e.g. Summit's 20-day-old entry
  // still counts toward the monthly window, Gulf's 40-day-old does not.
  await db.ledgerEntry.createMany({
    data: [
      { tenantName: 'Apex Piping & Supply', kind: 'MARGIN_DEFENDED', amountCents: 2_450_000, note: 'Q3 SPA rebates + RFQ defense', createdAt: new Date(now - 20 * H) },
      { tenantName: 'Apex Piping & Supply', kind: 'MARGIN_DEFENDED', amountCents: 410_000, note: 'Q2 SPA reconciliation', createdAt: new Date(now - 45 * D) },
      { tenantName: 'Midwest Trade Wholesale', kind: 'MARGIN_DEFENDED', amountCents: 1_200_000, note: 'Vendor cost-sheet enforcement', createdAt: new Date(now - 9 * H) },
      { tenantName: 'Midwest Trade Wholesale', kind: 'MARGIN_DEFENDED', amountCents: 1_040_000, note: 'Cost-sheet enforcement — prior cycle', createdAt: new Date(now - 60 * D) },
      { tenantName: 'Summit Industrial Fasteners', kind: 'MARGIN_DEFENDED', amountCents: 850_000, note: 'Onboarding defense wins', createdAt: new Date(now - 5 * D) },
      { tenantName: 'Summit Industrial Fasteners', kind: 'MARGIN_DEFENDED', amountCents: 380_000, note: 'Volume-tier discount recovery', createdAt: new Date(now - 20 * D) },
      { tenantName: 'Gulf Coast Valve & Fitting', kind: 'MARGIN_DEFENDED', amountCents: 110_000, note: 'Early intercept savings', createdAt: new Date(now - 30 * H) },
      { tenantName: 'Gulf Coast Valve & Fitting', kind: 'MARGIN_DEFENDED', amountCents: 700_000, note: 'Early intercept savings — diagnostic', createdAt: new Date(now - 40 * D) },
      { tenantName: 'Midwest Trade Wholesale', kind: 'SETUP_FEE', amountCents: 5_000_000, note: 'Setup fee — contract executed' },
      { tenantName: 'Apex Piping & Supply', kind: 'AUDIT_FEE', amountCents: 350_000, note: 'Diagnostic audit — paid' },
      { tenantName: 'Summit Industrial Fasteners', kind: 'SETUP_FEE', amountCents: 1_500_000, note: 'Setup fee installment 1 of 3' },
    ],
  });

  // ── Intercept stream (seeded live rows) ──────────────────────
  await db.interceptEvent.createMany({
    data: [
      { tenantName: 'Apex Piping', item: '2" Steel Flange', origCents: 14_200, defendedCents: 15_850, diffCents: 1_650, source: 'RFQ', createdAt: at(3) },
      { tenantName: 'Midwest Trade', item: 'Copper Elbow 3/4"', origCents: 1_210, defendedCents: 1_400, diffCents: 190, source: 'RFQ', createdAt: at(5) },
      { tenantName: 'Apex Piping', item: 'PVC SCH40 Pipe 10ft', origCents: 4_500, defendedCents: 5_200, diffCents: 700, source: 'RFQ', createdAt: at(7) },
    ],
  });

  // ── Unified inbox seeds ──────────────────────────────────────
  // Task 23 — direction is server-stamped fact, mirrored here so a fresh
  // seed matches what the live write paths record.
  await db.message.createMany({
    data: [
      { tenantName: 'Apex Piping & Supply', sender: 'Client (Chris)', direction: 'client', text: 'Just uploaded our 20 Q3 historical RFQs. Let us know if the SPA sheets parsed correctly.', unread: false, readAt: at(0, 10, 16), createdAt: at(0, 10, 14) },
      { tenantName: 'Apex Piping & Supply', sender: 'Josias (Syntropic)', direction: 'team', text: 'Received! Docling OCR spatial parsing is active. Reviewing line items now.', unread: false, createdAt: at(0, 10, 16) },
      { tenantName: 'Midwest Trade Wholesale', sender: 'Client (Dana)', direction: 'client', text: 'Contract executed on our side. Q3 vendor cost sheets are in the enclave — flag anything under 90% confidence.', unread: true, createdAt: at(0, 9, 2) },
    ],
  });

  // ── The operating day (Feature: the schedule owns the whole day) ──
  // Client-facing engagements AND internal blocks on one grid. Statuses are
  // derived from the wall clock at seed time so the day is always honest:
  // finished blocks are COMPLETED (+ attendance verified — the EVV analog),
  // the block under way is LIVE, the rest are CONFIRMED/SCHEDULED.
  // Summit's payment is OVERDUE → its strategy session earns AT-RISK from
  // live tenant state; no distress is ever typed by hand.
  const damon = members.find((m) => m.name === 'Damon');
  const josias = members.find((m) => m.name === 'Josias');
  const ZOOM = (id: string) => `https://zoom.us/j/${id}?pwd=backbone-demo`;
  type Block = {
    hostId: string | null; clientName: string; type: string; start: Date; end: Date;
    joinUrl?: string; isInternal?: boolean; flagged?: boolean; noShow?: boolean; notes?: string;
  };
  // Fixed morning texture (7:00–12:00)…
  const blocks: Block[] = [
    { hostId: josias?.id ?? null, clientName: 'Summit Industrial Fasteners', type: 'Early check-in — collections', start: at(0, 7, 0), end: at(0, 7, 30), noShow: true, notes: 'No-show — Marc did not join. Collections call to be re-queued.' },
    { hostId: damon?.id ?? null, clientName: 'Gulf Coast Valve & Fitting', type: 'Daily margin check-in', start: at(0, 7, 30), end: at(0, 8, 0), joinUrl: ZOOM('98234105731') },
    { hostId: damon?.id ?? null, clientName: 'Internal', type: 'Engine review — defend-rate tuning', start: at(0, 8, 15), end: at(0, 9, 0), isInternal: true, notes: 'Review the 0.95 confidence floor + Gulf dispatch failures.' },
    { hostId: josias?.id ?? null, clientName: 'Midwest Trade Wholesale', type: '15-min technical discovery', start: at(0, 9, 15), end: at(0, 10, 0), joinUrl: 'https://meet.google.com/abx-defy-tsm' },
    { hostId: damon?.id ?? null, clientName: 'Apex Piping & Supply', type: '48-hr executive audit briefing', start: at(0, 10, 0), end: at(0, 11, 30), joinUrl: ZOOM('94122783604'), flagged: true, notes: 'Follow-up to review — send the leakage appendix after the call.' },
    { hostId: josias?.id ?? null, clientName: 'Internal', type: 'HITL war-room — aging queue', start: at(0, 11, 30), end: at(0, 12, 0), isInternal: true, notes: 'Work HITL-8092 / 8093 before the day ends.' },
  ];
  // …then the core of the day anchored to the wall clock, so the board
  // always demos a live mix (completed / under way / at-risk / upcoming)
  // no matter when the seed runs. Sequential packing keeps same-host
  // blocks clean; the grid window (7:00–20:00) is never overrun by much.
  const WINDOW_END = new Date(`${new Date().toISOString().slice(0, 10)}T19:40:00.000`).getTime();
  const NOON = new Date(`${new Date().toISOString().slice(0, 10)}T12:30:00.000`).getTime();
  type Slot = { dur: number; earliest: number; make: (start: Date, end: Date) => Block };
  const slots: Slot[] = [
    { dur: 45, earliest: Math.max(now - 10 * MIN, NOON), make: (s, e) => ({ hostId: damon?.id ?? null, clientName: 'Gulf Coast Valve & Fitting', type: 'Margin review — freight surcharges', start: s, end: e, joinUrl: ZOOM('97055123489') }) },
    { dur: 30, earliest: now + 50 * MIN, make: (s, e) => ({ hostId: josias?.id ?? null, clientName: 'Summit Industrial Fasteners', type: 'Strategy session — payment plan', start: s, end: e, joinUrl: ZOOM('95810992217') }) },
    { dur: 30, earliest: now + 95 * MIN, make: (s, e) => ({ hostId: damon?.id ?? null, clientName: 'Internal', type: 'Ledger reconciliation sweep', start: s, end: e, isInternal: true }) },
    { dur: 45, earliest: now + 150 * MIN, make: (s, e) => ({ hostId: josias?.id ?? null, clientName: 'Midwest Trade Wholesale', type: 'Quarterly outlook', start: s, end: e, joinUrl: ZOOM('99344109282') }) },
  ];
  let cursor = NOON;
  for (const slot of slots) {
    let start = Math.max(cursor, slot.earliest);
    let end = start + slot.dur * MIN;
    if (end > WINDOW_END) { end = WINDOW_END; start = end - slot.dur * MIN; }
    blocks.push(slot.make(new Date(start), new Date(end)));
    cursor = end + 15 * MIN;
  }
  blocks.push({ hostId: damon?.id ?? null, clientName: 'Internal', type: 'Founder sync — Damon × Josias', start: at(0, 12, 0), end: at(0, 12, 30), isInternal: true, notes: 'Season belt on the line — walk the week.' });
  // One tomorrow-anchored engagement so the enclave's "Upcoming executive calls"
  // card demos a joinable line no matter what hour the seed runs.
  blocks.push({ hostId: damon?.id ?? null, clientName: 'Apex Piping & Supply', type: 'Margin review — 30-day pulse', start: daysFromNow(1, 9, 30), end: daysFromNow(1, 10, 15), joinUrl: ZOOM('95812340987') });
  await db.callSession.createMany({
    data: blocks.map((b) => {
      const finished = b.end.getTime() <= now;
      const underWay = !finished && b.start.getTime() <= now;
      const clientFacing = !b.isInternal && !b.noShow;
      return {
        clientName: b.clientName,
        type: b.type,
        scheduledAt: b.start,
        endsAt: b.end,
        status: b.noShow ? 'NO_SHOW' : finished ? 'COMPLETED' : underWay ? 'LIVE' : 'CONFIRMED',
        hostId: b.hostId,
        joinUrl: b.joinUrl ?? null,
        provider: b.joinUrl ? (/zoom\./i.test(b.joinUrl) ? 'ZOOM' : /meet\.google\.com/i.test(b.joinUrl) ? 'MEET' : 'MANUAL') : b.isInternal ? 'ENCLAVE' : null,
        notes: b.notes ?? '',
        flagged: b.flagged ?? false,
        isInternal: b.isInternal ?? false,
        attendanceVerified: Boolean(finished && clientFacing),
        verifiedAt: finished && clientFacing ? b.end : null,
      };
    }),
  });

  // ── Enclave linkage (Task 19 single-source-of-truth): resolve every
  // intercept / ledger row / client call to its Tenant. Exact case-
  // insensitive match; intercepts additionally accept a *unique* prefix
  // match (the live stream logs short trade names like "Apex Piping").
  // Unresolvable rows stay honestly unlinked — reconcile watches this.
  {
    const tenantRows = await db.tenant.findMany();
    const byExact = (name: string) =>
      tenantRows.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
    const byUniquePrefix = (name: string) => {
      const hits = tenantRows.filter((t) => t.name.toLowerCase().startsWith(name.trim().toLowerCase()));
      return hits.length === 1 ? hits[0] : undefined;
    };
    for (const e of await db.interceptEvent.findMany()) {
      const t = byExact(e.tenantName) ?? byUniquePrefix(e.tenantName);
      if (t) await db.interceptEvent.update({ where: { id: e.id }, data: { tenantId: t.id } });
    }
    for (const l of await db.ledgerEntry.findMany()) {
      const t = byExact(l.tenantName);
      if (t) await db.ledgerEntry.update({ where: { id: l.id }, data: { tenantId: t.id } });
    }
    for (const c of await db.callSession.findMany()) {
      if (c.clientName === 'Internal') continue;
      const t = byExact(c.clientName);
      if (t) await db.callSession.update({ where: { id: c.id }, data: { tenantId: t.id } });
    }
  }

  // ── Billing stage derivation (Task 20 — mirrors scripts/billing-stage-backfill.ts):
  // the money's state IS the stage — derive the founder-set lifecycle column from
  // the fee-ledger shape so future reseeds land correct without manual edits.
  // Runs AFTER the enclave linkage block: the derivation reads the FK-scoped
  // ledgerRows, which only exist once the rows above have been linked.
  // contractValueCents inlined (AUDIT_BOOK_CONSTANTS.contractValueCents).
  {
    const CONTRACT_VALUE_CENTS = 5_000_000;
    const tenantRows = await db.tenant.findMany({ include: { ledgerRows: true } });
    for (const t of tenantRows) {
      const fees = t.ledgerRows.filter((l) => l.kind === 'SETUP_FEE' || l.kind === 'AUDIT_FEE');
      const setupSum = fees.filter((l) => l.kind === 'SETUP_FEE').reduce((s, l) => s + l.amountCents, 0);
      const hasAuditFee = fees.some((l) => l.kind === 'AUDIT_FEE');
      const stage =
        setupSum >= CONTRACT_VALUE_CENTS && t.paymentStatus === 'PAID' ? 'LIVE'
        : setupSum > 0 ? 'SETUP'
        : hasAuditFee ? 'AUDIT'
        : 'DISCOVERY';
      await db.tenant.update({ where: { id: t.id }, data: { billingStage: stage } });
    }
  }

  // ── Document shelf (Task 19): two real files on disk, matching the
  // HITL queue's story — each shelf row carries its honest parse summary
  // and the HITL refs it raised, and downloads work from the enclave.
  {
    const tenantRowsCache = new Map((await db.tenant.findMany()).map((t) => [t.name, t]));
    const dataDir = process.env.DATA_DIR || './data';
    const docs: {
      tenantName: string; fileName: string; lines: number; hitl: number; refs: string[]; body: string;
    }[] = [
      {
        tenantName: 'Apex Piping & Supply', fileName: 'Customer_RFQ_Spec_882.csv',
        lines: 14, hitl: 1, refs: ['HITL-8092'],
        body: [
          'sku,qty,unit_cost_usd,vendor,notes',
          'PVC-SCH80-2IN-COUPLING,450,8.42,Harbor Fittings,Q3 spec sheet scan',
          'PVC-SCH80-4IN-COUPLING,120,14.10,Harbor Fittings,',
          'STEEL-FLANGE-2IN-150,80,22.75,Triangle Works,rated 150#',
          'STEEL-FLANGE-3IN-150,44,35.20,Triangle Works,rated 150#',
          'COPPER-ELBOW-3/4IN,210,6.90,Northline,C-array tolerance x0.2mm',
          'COPPER-TEE-1/2IN,180,5.75,Northline,',
          'GASKET-EPDM-2IN,600,1.12,SealCo,EPDM 70A',
          'GASKET-EPDM-3IN,320,1.68,SealCo,EPDM 70A',
          'BALL-VALVE-BRASS-1IN,95,9.85,Harbor Fittings,full port',
          'BALL-VALVE-BRASS-2IN,60,17.40,Harbor Fittings,full port',
          'PIPE-HANGER-3/4IN,400,0.85,Triangle Works,galvanized',
          'PIPE-HANGER-2IN,260,1.05,Triangle Works,galvanized',
          'UNION-BRASS-1IN,140,4.30,Northline,',
          'CAP-PVC-2IN,220,1.95,Harbor Fittings,sch80',
        ].join('\n'),
      },
      {
        tenantName: 'Midwest Trade Wholesale', fileName: 'RFQ_Vendor_Cost_Sheet_Q3.csv',
        lines: 10, hitl: 1, refs: ['HITL-8093'],
        body: [
          'sku,qty,unit_cost_usd,vendor,notes',
          'COPPER-PIPE-L-1/2IN,1200,4.85,Northline,vendor cost sheet Q3',
          'COPPER-PIPE-L-3/4IN,860,6.20,Northline,',
          'COPPER-PIPE-L-1IN,540,7.95,Northline,',
          'STEEL-CONDUIT-1IN,980,3.40,Triangle Works,EMT',
          'STEEL-CONDUIT-2IN,410,5.85,Triangle Works,EMT',
          'STRUT-CHANNEL-1-5/8IN,300,11.25,Triangle Works,12ga pre-galv',
          'J-BOLT-3/8IN,720,0.62,SealCo,zinc',
          'BEAM-CLAMP-1/2IN,650,1.15,SealCo,',
          'WIRE-SPLICER-CU-8AWG,480,2.20,Northline,',
          'GROUND-ROD-5/8IN,150,8.90,SealCo,copper bonded',
        ].join('\n'),
      },
    ];
    for (const d of docs) {
      const tenant = tenantRowsCache.get(d.tenantName);
      if (!tenant) continue;
      const dirSafe = d.tenantName.replace(/[^a-zA-Z0-9 _-]/g, '_');
      const dir = path.join(dataDir, 'tenants', dirSafe);
      await mkdir(dir, { recursive: true });
      const stored = `${Date.now()}_${d.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await writeFile(path.join(dir, stored), d.body, 'utf8');
      await db.tenantDocument.create({
        data: {
          tenantId: tenant.id,
          fileName: d.fileName,
          storedPath: path.join('tenants', dirSafe, stored),
          sizeBytes: Buffer.byteLength(d.body, 'utf8'),
          linesParsed: d.lines,
          hitlCount: d.hitl,
          hitlRefs: JSON.stringify(d.refs),
        },
      });
    }
  }

  // ── Telegram dispatch log (seeded audit trail) ───────────────
  await db.notification.createMany({
    data: [
      {
        channel: 'TELEGRAM', target: 'backbone-ops',
        text: 'OCR low-confidence · HITL-8092 — Apex Piping & Supply — confidence 88.4% (<95) — margin loss $1,420.50 — awaiting HITL approval',
        deliveryStatus: 'SIMULATED', createdAt: at(12),
      },
      {
        channel: 'TELEGRAM', target: 'backbone-ops',
        text: 'OCR low-confidence · HITL-8093 — Midwest Trade Wholesale — confidence 91.2% (<95) — margin loss $3,850.00 — awaiting HITL approval',
        deliveryStatus: 'SIMULATED', createdAt: at(28),
      },
    ],
  });

  // ── Traffic funnel with GEO (Phase 11.8/11.9) ────────────────
  // Today's industrial-hub distribution. Events anchor to "minutes ago"
  // when the UTC clock allows (keeps recency ordering honest for the
  // emerging-corridor slice) and clamp to the UTC day floor near midnight
  // so the geo slice renders regardless of when the seed runs. IPs are
  // left null on purpose — seeded rows carry no capture, only geography.
  //   Primary hub        → Houston, TX (4 landing events — clear win)
  //   Active enclave hub → Cleveland, OH (Apex · 1 pending HITL)
  //   Emerging corridor  → Chicago, IL (newest high-intent outside Houston)
  const todayUTC = new Date().toISOString().slice(0, 10);
  const dayFloor = new Date(`${todayUTC}T00:00:00.000Z`).getTime();
  const utcMinNow = Math.floor((now - dayFloor) / MIN);
  const tAgo = (minsAgo: number) => new Date(dayFloor + Math.max(0, utcMinNow - minsAgo - 2) * MIN);
  await db.trafficEvent.createMany({
    data: [
      // Houston, TX — today's primary landing hub (4 sessions)
      { sessionId: 'sess_hou-1', layer: 'LANDING', eventType: 'PAGE_VIEW', city: 'Houston', country: 'US', createdAt: tAgo(24) },
      { sessionId: 'sess_hou-2', layer: 'LANDING', eventType: 'PAGE_VIEW', city: 'Houston', country: 'US', createdAt: tAgo(21) },
      { sessionId: 'sess_hou-3', layer: 'LANDING', eventType: 'CTA_CLICK', city: 'Houston', country: 'US', createdAt: tAgo(15) },
      { sessionId: 'sess_hou-4', layer: 'LANDING', eventType: 'PAGE_VIEW', city: 'Houston', country: 'US', createdAt: tAgo(9) },
      // Chicago, IL — emerging corridor (newest high-intent signal)
      { sessionId: 'sess_chi-1', layer: 'LANDING', eventType: 'PAGE_VIEW', city: 'Chicago', country: 'US', createdAt: tAgo(27) },
      { sessionId: 'gulf-pilot', layer: 'LANDING', eventType: 'DEPOSIT_CLICKED', tenantId: 'Gulf Coast Valve & Fitting', city: 'Chicago', country: 'US', createdAt: tAgo(18) },
      { sessionId: 'sess_chi-intake', layer: 'LANDING', eventType: 'INTAKE_SUBMITTED', city: 'Chicago', country: 'US', createdAt: tAgo(1) },
      // Cleveland, OH — Apex enclave (latest tenant-linked geo row)
      { sessionId: 'sess_cle-1', layer: 'LANDING', eventType: 'PAGE_VIEW', city: 'Cleveland', country: 'US', createdAt: tAgo(30) },
      { sessionId: 'Apex Piping & Supply', layer: 'PORTAL', eventType: 'FILE_UPLOAD', tenantId: 'Apex Piping & Supply', city: 'Cleveland', country: 'US', createdAt: tAgo(2) },
      // Detroit, MI — Midwest enclave sign-in
      { sessionId: 'Midwest Trade Wholesale', layer: 'PORTAL', eventType: 'PORTAL_LOGIN', tenantId: 'Midwest Trade Wholesale', city: 'Detroit', country: 'US', createdAt: tAgo(8) },
    ],
  });
  await db.liveTelemetrySummary.create({
    data: {
      date: todayUTC,
      totalVisitors: 10,
      uniqueSessions: 10,
      auditsInitiated: 1,
      portalLogins: 1,
      quotesIngested: 1,
    },
  });

  const marginSum = await db.ledgerEntry.aggregate({ where: { kind: 'MARGIN_DEFENDED' }, _sum: { amountCents: true } });

  // ── Ship's Log — honest backfill of the seeded history ────────
  // Only commands the seeded state implies: the four portal invites,
  // the audit-fee settlements, and the engine intercepts already on the
  // ledger. Nothing invented beyond the seed's own facts.
  const daysAgo = (d: number, h: number) => new Date(now - d * D - h * H);
  await db.commandLog.createMany({
    data: [
      { actor: 'Damon', action: 'INVITE_ISSUED', target: 'Apex Piping & Supply', detail: 'fresh access code issued to chris@apexpiping.com — previous invite superseded, outbox delivery simulated', createdAt: daysAgo(3, 4) },
      { actor: 'Josias', action: 'INVITE_ISSUED', target: 'Midwest Trade Wholesale', detail: 'fresh access code issued to dana@midwesttrade.com — previous invite superseded, outbox delivery simulated', createdAt: daysAgo(5, 2) },
      { actor: 'Damon', action: 'INVITE_ISSUED', target: 'Summit Industrial Fasteners', detail: 'fresh access code issued to marc@summitindustrial.com — previous invite superseded, outbox delivery simulated', createdAt: daysAgo(2, 6) },
      { actor: 'Damon', action: 'INVITE_ISSUED', target: 'Gulf Coast Valve & Fitting', detail: 'fresh access code issued to elena@gulfcoastvalve.com — previous invite superseded, outbox delivery simulated', createdAt: daysAgo(1, 3) },
      { actor: 'Engine', action: 'RFQ_SIMULATED', target: 'Apex Piping', detail: 'inbound RFQ for Apex Piping — 2" Steel Flange intercepted at +$16.50 defended', createdAt: at(3) },
      { actor: 'Engine', action: 'RFQ_SIMULATED', target: 'Midwest Trade', detail: 'inbound RFQ for Midwest Trade — Copper Elbow 3/4" intercepted at +$1.90 defended', createdAt: at(5) },
      { actor: 'Engine', action: 'RFQ_SIMULATED', target: 'Apex Piping', detail: 'inbound RFQ for Apex Piping — PVC SCH40 Pipe 10ft intercepted at +$7.00 defended', createdAt: at(7) },
      { actor: 'Damon', action: 'SCHEDULED', target: 'Apex Piping & Supply', detail: '48-hr executive audit briefing · 10:00 AM · host Damon · ZOOM line attached', createdAt: daysAgo(1, 5) },
      { actor: 'Josias', action: 'SCHEDULED', target: 'Midwest Trade Wholesale', detail: 'quarterly outlook · host Josias · ZOOM line attached', createdAt: daysAgo(1, 3) },
    ],
  });

  console.log('Seed complete.');
  console.log('Tenants:', await db.tenant.count(), '· Invites:', await db.tenantInvite.count());
  console.log('Traffic events:', await db.trafficEvent.count(), '(geo-resolved hubs: Houston / Cleveland / Chicago)');
  console.log('Margin defended (cents):', marginSum._sum.amountCents, '→ rev-share 20% =', Math.round((marginSum._sum.amountCents ?? 0) * 0.2));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
