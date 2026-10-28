/**
 * Unified margin-leakage model — the single source of truth for every
 * leakage number in the system (portal estimator, dossier audits, reply
 * agent ROI cases, cluster rollups).
 *
 * Why this module exists: the portal estimator and the dossier audit math
 * previously used two independent formulas that could disagree for the same
 * distributor. A COO will cross-check. Both derivations now live here, are
 * calibrated to the same NA industrial book, and every surface stamps the
 * model version so numbers are traceable.
 *
 * Pure logic only: no DB, no React, no server imports.
 */

// --------------------------------------------------------------------------- //
// Model card — every constant, with provenance
// --------------------------------------------------------------------------- //

export const LEAKAGE_MODEL = {
  version: "LM-2025-Q4-r1",
  /** NA industrial-distributor median net operating margin (PVF/Elec/HVAC/FP book). */
  netMarginAssumption: 0.21,
  /** Ceiling on the share of net margin extractable by quote-desk leakage. */
  exposureCeiling: 0.35,
  /** Average revenue per RFQ line item across the four verticals. */
  lineValueUsd: 420,
  /** Share of lines flowing through late / manual / SPA-unapplied paths. */
  exposureShare: 0.38,
  /** Margin lost per exposed line (price concessions, SPA overrides, expedites). */
  slippagePerExposedLine: 0.068,
  /** Share of leakage recoverable in the first 12 months of the desk. */
  captureYearOne: 0.55,
  /** Symmetric confidence band applied to every modeled output. */
  confidenceBand: 0.15,
  /** Commercial anchors. */
  auditFeeUsd: 3_500,
  guaranteeFloorUsd: 10_000,
  /** Engagement SOW the audit converts to, and the rev-share on recovered margin. */
  sowFloorUsd: 50_000,
  revShareRate: 0.20,
} as const;

const band = (v: number) => {
  const b = LEAKAGE_MODEL.confidenceBand * v;
  return { low: Math.round(v - b), high: Math.round(v + b) };
};

const usd0 = (v: number) => Math.round(v);

// --------------------------------------------------------------------------- //
// Derivation A — audit model (revenue × margin × QLV exposure)
// Used by: dossier audit widget, cluster rollups, /api/command leakageUsd,
// reply-agent ROI objections. Input: known/estimated revenue + QLV score.
// --------------------------------------------------------------------------- //

export interface AuditLeakage {
  annual: number;
  low: number;
  high: number;
  recoverable: number;
}

/** Canonical audit-math leakage; null when either input is missing. */
export function auditLeakage(revenueUsd: number | null, qlvScore: number | null): AuditLeakage | null {
  if (!revenueUsd || qlvScore == null) return null;
  const annual = usd0(revenueUsd * LEAKAGE_MODEL.netMarginAssumption * (qlvScore / 100) * LEAKAGE_MODEL.exposureCeiling);
  const { low, high } = band(annual);
  return { annual, low, high, recoverable: usd0(annual * LEAKAGE_MODEL.captureYearOne) };
}

// --------------------------------------------------------------------------- //
// Derivation B — engagement estimator (RFQ volume × line-item anatomy)
// Used by: the portal leakage calculator. Input: monthly RFQs × avg lines.
// --------------------------------------------------------------------------- //

export interface EngagementLeakage {
  linesPerYear: number;
  annual: number;
  low: number;
  high: number;
  recoverable: number;
  auditMultiple: number;
  /** Revenue implied by the entered quote volume — the bridge to the audit model. */
  impliedRevenueUsd: number;
}

export function engagementLeakage(rfqPerMonth: number, lineItemsPerRfq: number): EngagementLeakage {
  const linesPerYear = Math.max(0, Math.round(rfqPerMonth * 12 * lineItemsPerRfq));
  const annual = usd0(
    linesPerYear * LEAKAGE_MODEL.lineValueUsd * LEAKAGE_MODEL.exposureShare * LEAKAGE_MODEL.slippagePerExposedLine,
  );
  const { low, high } = band(annual);
  const recoverable = usd0(annual * LEAKAGE_MODEL.captureYearOne);
  return {
    linesPerYear,
    annual,
    low,
    high,
    recoverable,
    auditMultiple: recoverable / LEAKAGE_MODEL.auditFeeUsd,
    impliedRevenueUsd: linesPerYear * LEAKAGE_MODEL.lineValueUsd,
  };
}

// --------------------------------------------------------------------------- //
// Cross-check — both derivations for the same operator, shown side by side
// --------------------------------------------------------------------------- //

export interface LeakageCrossCheck {
  engagement: EngagementLeakage;
  audit: AuditLeakage | null;
  /** Signed percent delta of audit model vs engagement model; null when audit input missing. */
  deltaPct: number | null;
  agree: boolean;
}

export function crossCheckLeakage(
  rfqPerMonth: number,
  lineItemsPerRfq: number,
  revenueUsd: number | null,
  qlvScore: number | null,
): LeakageCrossCheck {
  const engagement = engagementLeakage(rfqPerMonth, lineItemsPerRfq);
  const audit = auditLeakage(revenueUsd, qlvScore);
  const deltaPct =
    audit && audit.annual > 0 ? Math.round(((audit.annual - engagement.annual) / engagement.annual) * 100) : null;
  return { engagement, audit, deltaPct, agree: deltaPct != null && Math.abs(deltaPct) <= 15 };
}
