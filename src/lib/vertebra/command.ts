/**
 * Command centre shared contracts — consumed by the /api/command aggregator,
 * the telemetry ingest endpoint and the Executive Enclave client.
 *
 * Pure logic only: no DB, no React. The client re-ranks the strike queue
 * live as telemetry lands, so the ranking math must live here, not in SQL.
 */

// --------------------------------------------------------------------------- #
// Tiered autonomy policy (Module 9) — converged operator decision
// --------------------------------------------------------------------------- //

export const AUTO_SEND_INTENTS = ["send_information", "out_of_office", "not_interested"] as const;
export const HUMAN_GATE_INTENTS = ["interested", "objection_price", "objection_erp"] as const;

export type ReplyIntent =
  | "interested"
  | "out_of_office"
  | "send_information"
  | "not_interested"
  | "objection_price"
  | "objection_erp"
  | "unknown";

export const INTENT_LABELS: Record<ReplyIntent, string> = {
  interested: "Interested",
  out_of_office: "Out of Office",
  send_information: "Send Information",
  not_interested: "Not Interested",
  objection_price: "Objection — Price",
  objection_erp: "Objection — ERP",
  unknown: "Unclassified",
};

// --------------------------------------------------------------------------- #
// Leakage math (Module 6 audit widget)
// --------------------------------------------------------------------------- //

export const NET_MARGIN_ASSUMPTION = 0.21;
export const EXPOSURE_CEILING = 0.35;

/** Estimated annual net-profit leakage: revenue × net margin × exposure curve. */
export function annualLeakageUsd(revenueUsd: number | null, qlvScore: number | null): number | null {
  if (!revenueUsd || qlvScore == null) return null;
  return Math.round(revenueUsd * NET_MARGIN_ASSUMPTION * (qlvScore / 100) * EXPOSURE_CEILING);
}

// --------------------------------------------------------------------------- #
// Priority ranking — effective_priority = score × recency_decay × intent_weight
// --------------------------------------------------------------------------- //

const HIGH_SIGNAL_TYPES = new Set(["portal_visit", "audit_view", "document_download"]);

export function isHighSignal(eventType: string): boolean {
  return HIGH_SIGNAL_TYPES.has(eventType);
}

export function recencyFactor(lastHighSignalMs: number | null, nowMs: number): number {
  if (lastHighSignalMs == null) return 0.6;
  const minutes = (nowMs - lastHighSignalMs) / 60_000;
  if (minutes <= 15) return 1.35;
  if (minutes <= 60) return 1.2;
  if (minutes <= 360) return 1.0;
  if (minutes <= 1440) return 0.85;
  if (minutes <= 4320) return 0.7;
  return 0.6;
}

export function intentWeight(lastType: string | null): number {
  switch (lastType) {
    case "document_download": return 1.3;
    case "audit_view": return 1.25;
    case "portal_visit": return 1.2;
    case "pricing_view": return 1.1;
    case "session_end": return 0.9;
    default: return 0.75;
  }
}

export interface RankInput {
  qlvScore: number | null;
  lastHighSignalAtMs: number | null;
  lastEventType: string | null;
}

export function effectivePriority(input: RankInput, nowMs: number): number {
  if (input.qlvScore == null) return 0;
  return input.qlvScore * recencyFactor(input.lastHighSignalAtMs, nowMs) * intentWeight(input.lastEventType);
}

/** A lead is "on the board now" when telemetry is fresh enough to act on. */
export function isHighIntentNow(lastHighSignalAtMs: number | null, nowMs: number, qlvScore: number | null): boolean {
  if (lastHighSignalAtMs == null || qlvScore == null || qlvScore < 85) return false;
  return nowMs - lastHighSignalAtMs <= 15 * 60_000;
}

// --------------------------------------------------------------------------- //
// Read-model shapes
// --------------------------------------------------------------------------- //

export interface ContactShape {
  name: string;
  role: string;
  titleRaw: string;
  phone: string | null;
}

export interface ScoreShape {
  qlvScore: number;
  band: string;
  factors: Array<{ key: string; weight: number; points: number; evidence: string }>;
  hooks: Array<{ flavor: string; body: string }>;
  rationale: string;
  model: string;
  createdAt: string;
}

export interface ErpShape {
  detected_erp: string;
  erp_family: string | null;
  quote_portal_type: string;
  job_signal_count: number;
  recommended_pitch_angle: string;
  evidence: {
    job_posts?: Array<{ board: string; title: string; keyword: string; posted_at: string }>;
    ssl?: { issuer: string; days_to_expiry: number };
  };
  profiled_at: string | null;
}

export interface TelemetrySummary {
  lastEventType: string | null;
  lastEventAtMs: number | null;
  lastHighSignalAtMs: number | null;
  events48h: number;
  totalSessionMs: number;
}

export interface CommandLead {
  id: string;
  name: string;
  domain: string | null;
  vertical: string | null;
  city: string | null;
  stateProvince: string | null;
  country: string | null;
  region: string | null;
  revenueEstimateUsd: number | null;
  employeeCount: number | null;
  ingestion: string;
  caslScope: boolean;
  bestEmail: string | null;
  contact: ContactShape | null;
  score: ScoreShape | null;
  erp: ErpShape | null;
  quotePortalType: string | null;
  auditImageUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  clusterId: string | null;
  clusterName: string | null;
  lastIntentHeat: number;
  telemetry: TelemetrySummary;
  dispatch: { channel: string; status: string; scheduledAtMs: number | null; steps: number } | null;
  highTouch: { qlvScore: number; exportedAtMs: number | null } | null;
  leakageUsd: number | null;
  priority: number;
  highIntentNow: boolean;
  pendingDrafts: number;
  snoozedUntilMs: number | null;
  lastActionAtMs: number | null;
  /** internal flags from the aggregator — deferred leaves the queue until the next high-signal event */
  __deferred?: boolean;
  __called?: boolean;
}

export interface FeedItem {
  id: string;
  prospectId: string | null;
  prospectName: string;
  qlvScore: number | null;
  clusterName: string | null;
  vertical: string | null;
  eventType: string;
  url: string | null;
  city: string | null;
  country: string | null;
  device: string | null;
  durationMs: number | null;
  occurredAtMs: number;
  alertFired: boolean;
}

export interface TriageItem {
  draftId: string | null;
  replyId: string;
  prospectId: string;
  prospectName: string;
  qlvScore: number | null;
  intent: ReplyIntent;
  confidence: number | null;
  fromEmail: string;
  subject: string;
  body: string;
  draftSubject: string | null;
  draftBody: string | null;
  draftStatus: string | null;
  receivedAtMs: number;
  rationale: string | null;
  rescheduledToMs: number | null;
}

export interface AlertItem {
  id: string;
  prospectId: string;
  prospectName: string;
  title: string;
  body: string;
  acknowledgedAtMs: number | null;
  createdAtMs: number;
}

export interface ClusterShape {
  id: string;
  clusterKey: string;
  clusterName: string;
  anchorCity: string | null;
  anchorCountry: string | null;
  centroidLat: number;
  centroidLng: number;
  radiusM: number;
  densityCount: number;
  verticalFocus: string | null;
  memberIds: string[];
  leakageUsd: number;
  hotCount: number;
}

export interface FunnelStage {
  stage: string;
  label: string;
  count: number;
  leakageUsd: number;
}

export interface OpsModule {
  id: string;
  module: string;
  enginePath: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface OpsSnapshot {
  modules: OpsModule[];
  outboxPending: number;
  outboxPublished: number;
  dispatchesSent24h: number;
  telemetryEvents24h: number;
  alerts24h: number;
  verifiedEmailShare: number;
  channelACount: number;
  channelBCount: number;
}

export interface CommandSnapshot {
  generatedAtMs: number;
  leads: CommandLead[];
  feed: FeedItem[];
  triage: { pending: TriageItem[]; auto: TriageItem[]; closed: TriageItem[] };
  alerts: AlertItem[];
  clusters: ClusterShape[];
  funnel: FunnelStage[];
  ops: OpsSnapshot;
}

// --------------------------------------------------------------------------- //
// Presentation helpers
// --------------------------------------------------------------------------- //

export const PORTAL_LABELS: Record<string, string> = {
  manual_mailto: "mailto: RFQs",
  static_pdf_form: "static PDF form",
  legacy_portal: "legacy portal",
  modern_quote_api: "modern quote API",
  undetermined: "undetermined",
};

export const EVENT_LABELS: Record<string, string> = {
  portal_visit: "PORTAL VISIT",
  audit_view: "AUDIT VIEW",
  document_download: "PDF DOWNLOAD",
  pricing_view: "PRICING VIEW",
  session_end: "SESSION END",
};

export const EVENT_VERBS: Record<string, string> = {
  portal_visit: "opened the portal",
  audit_view: "viewed the audit",
  document_download: "downloaded the audit PDF",
  pricing_view: "viewed engagement pricing",
  session_end: "ended a portal session",
};

export function verticalLabel(v: string | null): string {
  switch (v) {
    case "pvf": return "PVF";
    case "electrical": return "Electrical";
    case "hvac": return "HVAC";
    case "fluid_power": return "Fluid Power";
    default: return "—";
  }
}

export function money(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (Math.abs(usd) >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(usd) >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${usd}`;
}

export function relTime(ms: number, nowMs: number): string {
  const s = Math.max(1, Math.floor((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Heat ladder — light theme: priority reads as ink density (darker = hotter). */
export function heatLevel(qlvScore: number | null): "critical" | "hot" | "warm" | "cool" {
  if (qlvScore == null) return "cool";
  if (qlvScore >= 85) return "critical";
  if (qlvScore >= 72) return "hot";
  if (qlvScore >= 50) return "warm";
  return "cool";
}

export const HEAT_TEXT: Record<ReturnType<typeof heatLevel>, string> = {
  critical: "text-[#08080A]",
  hot: "text-[#2A2E33]",
  warm: "text-[#5F646D]",
  cool: "text-[#A6ABB2]",
};

export const HEAT_BAR: Record<ReturnType<typeof heatLevel>, string> = {
  critical: "bg-[#08080A]",
  hot: "bg-[#3A3F46]",
  warm: "bg-[#82878F]",
  cool: "bg-[#C6CAD0]",
};

/** SVG fills for the theatre board — ink density ladder on white. */
export const HEAT_FILL: Record<ReturnType<typeof heatLevel>, string> = {
  critical: "#08080A",
  hot: "#3A3F46",
  warm: "#82878F",
  cool: "#C6CAD0",
};
