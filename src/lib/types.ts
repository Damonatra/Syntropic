/**
 * Syntropic Backbone — shared view types (client + server).
 */

export interface TeamMemberView {
  id: string;
  name: string; // Damon | Josias (login handle — founders-only arena)
  fullName: string; // display name
  role: string;
  isOnline: boolean;
  qOutboundTarget: number;
  qOutboundCompleted: number;
  discoveryCalls: number;
  auditsClosed: number;
  contractsConverted: number;
  tone: 'ink' | 'blush' | 'steel';
}

export interface AuditRecordView {
  id: string;
  companyName: string;
  /** Linked tenant (exact name-match backfill); null = not yet a tenant. */
  tenantName: string | null;
  dateSold: string;
  auditFeeCents: number;
  attendedCall: boolean;
  callHost: string;
  convertedToClient: boolean;
  identifiedLeakageCents: number;
  callNotes: string;
}

/**
 * GET /api/ledger audit book rollup (Task 18) — every figure server-computed
 * from AuditRecord rows within the same asOf scope as the rest of the ledger.
 * Product constants (audit fee, recovery floor, contract value) live here so
 * no money figure is hardcoded in the presentation layer (R-01).
 */
export interface AuditRollupView {
  auditsSold: number;
  attended: number;
  attendedRate: number;
  converted: number;
  conversionRate: number;
  auditRevenueCents: number;
  identifiedLeakageCents: number;
  /** Margin defended across the book in the same asOf scope — pairs with identified leakage. */
  marginDefendedCents: number;
  /** defended / identified leakage — null while nothing has been identified yet. */
  leakageRecoveryRatio: number | null;
  activeAccounts: number;
  /** Product constants — were hardcoded client-side; now the server owns them. */
  diagnosticAuditFeeCents: number;
  guaranteedFloorCents: number;
  contractValueCents: number;
}

export interface ClientMarginView {
  name: string;
  erp: string;
  totalDefendedCents: number;
  last24hDeltaCents: number;
  monthlyRevShareCents: number;
  annualRevShareCents: number;
  lifetimeRevShareCents: number;
  leakageVector: string;
  paymentStatus: 'PAID' | 'PENDING' | 'OVERDUE';
}

export interface PipelineRow {
  client: string;
  stage: string;
  owner: string;
  value: string;
}

export interface TrafficSummary {
  date: string;
  totalVisitors: number;
  uniqueSessions: number;
  auditsInitiated: number;
  portalLogins: number;
  quotesIngested: number;
}

/** GET /api/backbone/geo — Phase 11.9 GEO-IP intelligence slice. */
export interface GeoIntelView {
  primary: { city: string; country: string; share: number; events: number } | null;
  enclaveHub: { city: string; country: string; tenants: number; reviews: number } | null;
  emerging: { city: string; country: string; lastEventType: string } | null;
  topLocations: { city: string; country: string; events: number }[];
  generatedAt: string;
}

export interface LedgerView {
  marginDefendedCents: number;
  revShareCents: number;
  revShareRate: number;
  activeAccounts: number;
  sprintTarget: number;
  setupFeeCents: number;
  projectedMrrCents: number;
  guaranteePassRate: number;
  auditedAccounts: number;
  /** Task 18 — the audit book, server-computed. */
  auditRollup: AuditRollupView;
  team: TeamMemberView[];
  audits: AuditRecordView[];
  clients: ClientMarginView[];
  pipeline: PipelineRow[];
  traffic: TrafficSummary | null;
  computedAt: string;
  /** Time travel: non-null when the deck is rendered as of a past instant. */
  asOf: string | null;
}

export interface TenantView {
  name: string;
  erp: string;
  status: string;
  stage: string;
  depositLabel: string;
  guaranteeLabel: string;
  owner: string;
  mailboxStatus: 'ACTIVE' | 'LOCKED' | 'MISSING';
  mailboxNote: string | null;
  contactName: string;
  contactEmail: string;
}

export type HitlKind = 'OCR_LOW_CONFIDENCE' | 'DISPATCH_FAILURE';
export type HitlStatus = 'PENDING' | 'APPROVED' | 'OVERRIDDEN' | 'RESOLVED';
export type MailboxStatus = 'ACTIVE' | 'LOCKED' | 'MISSING';

export interface HitlView {
  id: string;
  ref: string;
  kind: HitlKind;
  tenantName: string;
  pdfName: string | null;
  skuParsed: string | null;
  confidenceScore: number | null;
  extractedMarginLossCents: number;
  failureReason: 'MAILBOX_NOT_FOUND' | 'MAILBOX_LOCKED' | null;
  owner: string | null;
  status: HitlStatus;
  createdAt: string;
  /** Last successful action — the verdict moment for time-to-verdict math. */
  updatedAt: string;
}

export interface InterceptView {
  id: string;
  tenantName: string;
  item: string;
  origCents: number;
  defendedCents: number;
  diffCents: number;
  channel: string;
  source: string;
  createdAt: string;
}

export interface MessageView {
  id: string;
  tenantName: string;
  sender: string;
  text: string;
  /** Task 23 — server-known side of the table ('team' | 'client'); UIs render from this, not sender strings. */
  direction: 'team' | 'client';
  unread: boolean;
  /** Task 19 — when the team cleared the flag; powers the client's "Seen" receipt. */
  readAt?: string | null;
  createdAt: string;
}

export interface CallView {
  id: string;
  clientName: string;
  type: string;
  scheduledAt: string;
  status: string;
  /** Task 19 — client-facing call card extras (optional for older producers). */
  endsAt?: string | null;
  joinUrl?: string | null;
  provider?: string | null;
  hostName?: string | null;
}

/* ── The operating day (Feature: the schedule owns the whole day) ── */

export type ScheduleStatus = 'SCHEDULED' | 'CONFIRMED' | 'LIVE' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';
export type AbsenceReason = 'SICK' | 'TRAVEL' | 'FOCUS' | 'OTHER';

/** One block on the operating-day grid. */
export interface ScheduleSessionView {
  id: string;
  clientName: string;
  type: string;
  scheduledAt: string;
  endsAt: string | null;
  status: ScheduleStatus;
  hostId: string | null;
  hostName: string | null;
  joinUrl: string | null;
  provider: string | null;
  notes: string;
  flagged: boolean;
  isInternal: boolean;
  attendanceVerified: boolean;
  verifiedAt: string | null;
  /** Earned, never set by hand: live tenant distress (overdue payment, locked mailbox, aging HITL). */
  atRiskReasons: string[];
  createdAt: string;
  updatedAt: string;
}

/** A founder going dark for a day — with the reassignment sentence it produced. */
export interface FounderAbsenceView {
  id: string;
  memberId: string;
  memberName: string;
  reason: AbsenceReason;
  note: string;
  day: string;
  reportedAt: string;
  resolvedAt: string | null;
  reassignments: string;
}

/** GET /api/calls — the full schedule board (sessions + absences). */
export interface ScheduleBoardView {
  sessions: ScheduleSessionView[];
  absences: FounderAbsenceView[];
}

/** Portal invite ledger row (Tower-side audit trail). */
export interface InviteView {
  id: string;
  tenantName: string;
  email: string;
  codeHint: string;
  issuedBy: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  createdAt: string;
  acceptedAt: string | null;
}

/** Current portal-access state per tenant. */
export interface PortalAccessView {
  name: string;
  contactEmail: string;
  hasCode: boolean;
}

export interface DispatchResult {
  status: 'DISPATCHED' | 'FAILED';
  reason?: 'MAILBOX_LOCKED' | 'MAILBOX_NOT_FOUND';
  failureRef?: string;
  alertDelivery?: string;
}

/** Client ↔ server action contract for HITL resolution. */
export type HitlAction = 'APPROVE' | 'OVERRIDE' | 'RETRY' | 'RESOLVE' | 'NOTIFY';

/* ── Show-the-work receipts (Feature: every number shows its work) ── */

export interface ReceiptEntry {
  id: string;
  tenantName: string;
  kind: string;
  amountCents: number;
  note: string | null;
  createdAt: string;
}

/** GET /api/ledger/receipts — the exact ledger rows behind a figure. */
export interface ReceiptsView {
  scope: 'tenant' | 'book';
  tenantName: string | null;
  metric: 'defended' | 'revshare';
  entries: ReceiptEntry[];
  defendedCents: number;
  derivedCents: number;
  feeCents: number;
  rate: number;
  computedAt: string;
}

/* ── The Ship's Log (Feature: append-only command journal) ── */

export interface CommandLogView {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  createdAt: string;
}

/* ── Reconciliation stamp (Feature: the station audits itself) ── */

export interface ReconcileCheck {
  key: string;
  label: string;
  claimed: number | string;
  recomputed: number | string;
  match: boolean;
}

export interface ReconcileView {
  ok: boolean;
  checkedAt: string;
  driftCents: number;
  checks: ReconcileCheck[];
}

/* ── Arena seasons (Feature: the leaderboard becomes a running match) ── */

export interface SeasonScore {
  founder: string;
  fullName: string;
  defendedCents: number;
  entries: number;
  sharePct: number;
}

export interface SeasonWeek {
  weekStart: string;
  winner: string | null;
  winnerCents: number;
  runnerUp: string | null;
  runnerUpCents: number;
}

export interface SeasonsView {
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  scores: SeasonScore[];
  leader: string | null;
  headToHeadCents: number;
  belt: { holder: string | null; weeksHeld: number };
  history: SeasonWeek[];
  computedAt: string;
}
