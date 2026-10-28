/** The entry anchor — $3,500 Diagnostic Audit backed by the $10,000 guarantee. */
"use client";

import { ArrowButton, HudMeta } from "../bits";

export function GuaranteeBanner({ onBegin }: { onBegin: () => void }) {
  return (
    <div className="ink relative overflow-hidden rounded-[28px] px-8 py-7">
      <div className="flex items-start justify-between gap-6">
        <div className="max-w-[620px]">
          <p className="font-mono text-[9.5px] font-medium uppercase tracking-[0.22em] text-white/50">
            Margin Defense Portal // entry anchor — US &amp; Canada industrial distribution
          </p>
          <h2 className="mt-3 font-display text-[26px] font-semibold leading-[1.2] tracking-[-0.03em] text-white">
            The <span className="underline decoration-white/30 underline-offset-8">$3,500 Diagnostic Audit</span> — backed by a $10,000 Margin Leakage
            Recovery Guarantee.
          </h2>
          <p className="mt-3 text-[13.5px] leading-relaxed text-white/60">
            We parse your legacy quote PDFs and cost sheets, trace every SPA against what actually shipped, and quantify the net margin walking out of
            your RFQ flow. If the audit doesn&apos;t surface at least $10,000 in recoverable leakage, we keep remediating until it does — the deposit is
            credited against the enterprise SOW.
          </p>
          <div className="mt-5 flex flex-wrap gap-2 font-mono text-[9.5px] uppercase tracking-[0.14em]">
            {["deposit $3,500", "credited to sow", "guarantee floor $10,000", "pvf · electrical · hvac · fluid power"].map((t) => (
              <span key={t} className="rounded-full border border-white/15 px-3 py-1 text-white/60">
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-4">
          <HudMeta node="AST-02" hash="77e2" className="!text-white/40" />
          <ArrowButton dark={false} label="Begin audit intake" onClick={onBegin} />
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">begin intake</span>
        </div>
      </div>
    </div>
  );
}
