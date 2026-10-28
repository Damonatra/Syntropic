/** Shared client types for the Vertebra console. */

export interface QLVFactor {
  key: string;
  weight: number;
  points: number;
  evidence: string;
}

export interface Hook {
  flavor: string;
  body: string;
}

export interface ProspectRow {
  id: string;
  name: string;
  domain: string | null;
  vertical: string | null;
  region: string | null;
  city: string | null;
  stateProvince: string | null;
  revenueEstimateUsd: number | null;
  revenueConfidence: string;
  employeeCount: number | null;
  detectedErp: string | null;
  ingestion: string;
  filterReason: string | null;
  caslScope: boolean;
  caslReason: string | null;
  bestEmail: string | null;
  contact: { firstName: string; lastName: string; role: string } | null;
  score: {
    qlvScore: number;
    band: string;
    factors: QLVFactor[];
    hooks: Hook[];
    rationale: string;
    model: string;
    createdAt: string;
  } | null;
  dispatch: {
    channel: string;
    status: string;
    subject: string | null;
    fromDomain: string | null;
    provider: string | null;
    createdAt: string;
  } | null;
  highTouchExported: string | null;
  calendarEventId: string | null;
  updatedAt: string;
}

export interface Stats {
  prospects: Record<string, number>;
  dispatches: Array<{ channel: string; status: string; count: number }>;
  scoring: {
    scored: number;
    avgQlv: number | null;
    bands: Record<string, number>;
    channelAThreshold: number;
  };
  caslScopeCount: number;
  outboxPending: number;
  highTouchPending: number;
  verticals: Record<string, number>;
}

export interface OutboxEventRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  publishedAt: string | null;
  createdAt: string;
}

export const VERTICAL_LABELS: Record<string, string> = {
  pvf: "PVF",
  electrical: "Electrical",
  hvac: "HVAC",
  fluid_power: "Fluid Power",
};

export const BAND_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};
