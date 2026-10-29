/**
 * Interactive margin leakage estimator — the portal hero moment.
 * Gunmetal band hosting a single obsidian object: the leakage verdict.
 * All constants derive from the unified model card (src/lib/vertebra/
 * leakage.ts) — same calibration as the dossier audit math, version-stamped.
 */
"use client";

import { useMemo, useState } from "react";
import { HudMeta } from "../bits";
import { LEAKAGE_MODEL, engagementLeakage } from "@/lib/vertebra/leakage";

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

function Stepper({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const btn =
    "tactile-btn size-9 bg-white text-[#0B0C0B] text-[16px] border border-black/10 hover:bg-[#0B0C0B] hover:text-white";
  return (
    <div className="rounded-lg border border-black/10 bg-black/[0.08] px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-[#2E322E]">{label}</p>
          <p className="mt-0.5 text-[11px] text-[#4B514D]">{hint}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <button className={btn} aria-label={`Decrease ${label}`} onClick={() => onChange(clamp(value - step))}>
            −
          </button>
          <span className="min-w-[64px] text-center font-display text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[#0B0C0B]">
            {value}
          </span>
          <button className={btn} aria-label={`Increase ${label}`} onClick={() => onChange(clamp(value + step))}>
            +
          </button>
        </div>
      </div>
    </div>
  );
}

export function LeakageCalculator() {
  const [rfqPerMonth, setRfqPerMonth] = useState(120);
  const [lineItems, setLineItems] = useState(22);

  const result = useMemo(
    () => engagementLeakage(rfqPerMonth, lineItems),
    [rfqPerMonth, lineItems],
  );

  return (
    <div className="gunmetal flex flex-col gap-4 rounded-lg border border-black/10 px-7 py-6">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-[#2E322E]">Leakage estimator</p>
        <HudMeta node="AST-05" hash="9d14" tone="light" />
      </div>

      <Stepper
        label="Monthly RFQ volume"
        hint="quote requests handled per month, all branches"
        value={rfqPerMonth}
        min={25}
        max={500}
        step={5}
        onChange={setRfqPerMonth}
      />
      <Stepper
        label="Avg line items / RFQ"
        hint="skus priced on a typical quote"
        value={lineItems}
        min={5}
        max={80}
        step={1}
        onChange={setLineItems}
      />

      {/* the obsidian object — modeled verdict */}
      <div className="flex flex-1 flex-col justify-center rounded-lg bg-[#0B0C0B] px-6 py-5">
        <p className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-white/60">Modeled annual net-margin leakage</p>
        <p className="mt-2 font-display text-[40px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-white">
          {usd(result.annual)}
        </p>
        <p className="mt-2 font-mono text-[10.5px] tabular-nums text-white/60">
          band {usd(result.low)} – {usd(result.high)} · ±15%
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/15 pt-4">
          <div>
            <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/60">
              Recoverable year one · {(LEAKAGE_MODEL.captureYearOne * 100).toFixed(0)}% capture
            </p>
            <p className="mt-1 font-display text-[19px] font-semibold tracking-[-0.02em] tabular-nums text-white">{usd(result.recoverable)}</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/60">
              vs {usd(LEAKAGE_MODEL.auditFeeUsd)} audit
            </p>
            <p className="mt-1 font-display text-[19px] font-semibold tracking-[-0.02em] tabular-nums text-white">{result.auditMultiple.toFixed(1)}×</p>
          </div>
        </div>
      </div>

      <p className="font-mono text-[9.5px] leading-relaxed tracking-[0.06em] text-[#2E322E]">
        MODEL // {LEAKAGE_MODEL.version} · {result.linesPerYear.toLocaleString("en-US")} lines/yr × $
        {LEAKAGE_MODEL.lineValueUsd} avg line value × {(LEAKAGE_MODEL.exposureShare * 100).toFixed(0)}% exposure share
        × {(LEAKAGE_MODEL.slippagePerExposedLine * 100).toFixed(1)}% slippage · implied book{" "}
        {usd(result.impliedRevenueUsd)} · guarantee floor {usd(LEAKAGE_MODEL.guaranteeFloorUsd)} applies when the audit
        confirms the model
      </p>
    </div>
  );
}
