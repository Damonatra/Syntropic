import { describe, expect, it } from "vitest";
import {
  LEAKAGE_MODEL,
  auditLeakage,
  crossCheckLeakage,
  engagementLeakage,
} from "@/lib/vertebra/leakage";

describe("auditLeakage — derivation A (revenue × margin × QLV)", () => {
  it("returns null when revenue or QLV missing", () => {
    expect(auditLeakage(null, 90)).toBeNull();
    expect(auditLeakage(20_000_000, null)).toBeNull();
    expect(auditLeakage(0, 90)).toBeNull();
  });

  it("matches the canonical audit math", () => {
    // 50M × 0.21 × 0.92 × 0.35 = 3,381,000
    const r = auditLeakage(50_000_000, 92);
    expect(r?.annual).toBe(3_381_000);
  });

  it("applies the ±15% confidence band and year-one capture", () => {
    const r = auditLeakage(50_000_000, 92)!;
    expect(r.low).toBe(Math.round(r.annual * 0.85));
    expect(r.high).toBe(Math.round(r.annual * 1.15));
    expect(r.recoverable).toBe(Math.round(r.annual * LEAKAGE_MODEL.captureYearOne));
  });

  it("scales monotonically with QLV", () => {
    const low = auditLeakage(20_000_000, 40)!.annual;
    const high = auditLeakage(20_000_000, 90)!.annual;
    expect(high).toBeGreaterThan(low);
  });
});

describe("engagementLeakage — derivation B (volume × line anatomy)", () => {
  it("computes lines per year and the annual figure", () => {
    // 120 RFQ/mo × 22 lines × 12 = 31,680 lines
    // 31,680 × 420 × 0.38 × 0.068 = 343,816.7 → 343,817
    const r = engagementLeakage(120, 22);
    expect(r.linesPerYear).toBe(31_680);
    expect(r.annual).toBe(343_817);
  });

  it("bands, captures, and multiples derive from the model card", () => {
    const r = engagementLeakage(120, 22);
    expect(r.low).toBe(Math.round(r.annual * (1 - LEAKAGE_MODEL.confidenceBand)));
    expect(r.high).toBe(Math.round(r.annual * (1 + LEAKAGE_MODEL.confidenceBand)));
    expect(r.recoverable).toBe(Math.round(r.annual * LEAKAGE_MODEL.captureYearOne));
    expect(r.auditMultiple).toBeCloseTo(r.recoverable / LEAKAGE_MODEL.auditFeeUsd, 6);
  });

  it("implied revenue bridges to the audit model", () => {
    const r = engagementLeakage(120, 22);
    expect(r.impliedRevenueUsd).toBe(31_680 * LEAKAGE_MODEL.lineValueUsd);
  });

  it("clamps non-positive volume to zero", () => {
    expect(engagementLeakage(0, 22).annual).toBe(0);
  });
});

describe("crossCheckLeakage — both derivations on one operator", () => {
  it("reports the signed delta between derivations", () => {
    const cc = crossCheckLeakage(120, 22, 31_680 * LEAKAGE_MODEL.lineValueUsd, 92);
    expect(cc.audit).not.toBeNull();
    expect(cc.deltaPct).not.toBeNull();
    expect(typeof cc.agree).toBe("boolean");
  });

  it("audit equals engagement when the implied book sits at full QLV exposure", () => {
    // implied revenue at QLV 92: audit = R × 0.21 × 0.92 × 0.35.
    // Solve R so that audit == engagement: R = engagement / (0.21 × 0.92 × 0.35)
    const eng = engagementLeakage(120, 22);
    const r = 343_351 / (LEAKAGE_MODEL.netMarginAssumption * 0.92 * LEAKAGE_MODEL.exposureCeiling);
    const cc = crossCheckLeakage(120, 22, Math.round(r), 92);
    expect(Math.abs(cc.deltaPct!)).toBeLessThanOrEqual(1);
    expect(cc.agree).toBe(true);
    expect(eng.annual).toBeGreaterThan(0);
  });

  it("delta is null without revenue or QLV", () => {
    expect(crossCheckLeakage(120, 22, null, 92).deltaPct).toBeNull();
    expect(crossCheckLeakage(120, 22, 20_000_000, null).deltaPct).toBeNull();
  });
});
