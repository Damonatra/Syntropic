"use client";

import { ProspectRow } from "@/lib/vertebra/types";

const FACTOR_ROWS: Array<{ key: string; label: string; weight: string; note: string }> = [
  { key: "rfq_latency", label: "RFQ latency", weight: "0.28", note: "Hours a quote request sits before it moves." },
  { key: "legacy_portal", label: "Legacy portal", weight: "0.22", note: "Quoting lives in an ageing customer portal." },
  { key: "unapplied_spa", label: "Unapplied SPAs", weight: "0.18", note: "Vendor pricing agreements never hit the quote." },
  { key: "manual_quoting_share", label: "Manual quoting share", weight: "0.14", note: "Share of quotes re-keyed by hand." },
  { key: "vertical_fit", label: "Vertical fit", weight: "0.10", note: "PVF and fluid power bleed the most." },
  { key: "size_fit", label: "Size fit", weight: "0.08", note: "$20M–$100M is the structural sweet spot." },
];

interface ScoringSectionProps {
  selected: ProspectRow | null;
}

export function ScoringSection({ selected }: ScoringSectionProps) {
  return (
    <section id="scoring" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 py-20 sm:px-8 sm:py-24">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
        <div>
          <p className="tag mb-4 uppercase">Quote Leakage Vulnerability</p>
          <h2 className="heading text-[#17191c]">
            Six factors, one number the <span className="italic-accent">whole team</span> trusts.
          </h2>
          <p className="subhead mt-5">
            Claude 3.5 Sonnet scores every prospect against the leakage anatomy below —
            grounded strictly in ingested evidence. If the model is unreachable, a
            transparent rubric takes over so the pipeline never stalls.
          </p>
          <div className="mt-8 space-y-4">
            {FACTOR_ROWS.map((factor) => (
              <div key={factor.key} className="flex items-start gap-4">
                <span className="mt-1 w-10 shrink-0 text-[13px] tabular-nums text-[#979799]">
                  {factor.weight}
                </span>
                <div>
                  <p className="text-[15px] text-[#17191c]">{factor.label}</p>
                  <p className="text-[13.5px] leading-snug text-[#777b86]">{factor.note}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="artifact p-6 sm:p-7">
          {selected?.score ? (
            <div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="meta">Scored · {selected.score.model}</p>
                  <h3 className="mt-1 font-display text-[28px] leading-tight text-[#17191c]">
                    {selected.name}
                  </h3>
                </div>
                <div className="text-right">
                  <p className="font-display text-[46px] leading-none text-[#17191c]">
                    {selected.score.qlvScore}
                  </p>
                  <p className="tag mt-1 uppercase">{selected.score.band} leakage</p>
                </div>
              </div>

              <div className="mt-6 space-y-3.5">
                {selected.score.factors
                  .slice()
                  .sort((a, b) => b.points * b.weight - a.points * a.weight)
                  .map((factor) => (
                    <div key={factor.key}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[14px] text-[#17191c]">
                          {FACTOR_ROWS.find((row) => row.key === factor.key)?.label ?? factor.key}
                        </span>
                        <span className="text-[13px] tabular-nums text-[#777b86]">
                          {Math.round(factor.points)}/100
                        </span>
                      </div>
                      <div className="qlv-track mt-1.5">
                        <div className="qlv-fill" style={{ width: `${Math.min(100, factor.points)}%` }} />
                      </div>
                      <p className="mt-1 text-[12.5px] leading-snug text-[#a3a6af]">{factor.evidence}</p>
                    </div>
                  ))}
              </div>

              <div className="mt-7 border-t border-[#f2f2f3] pt-5">
                <p className="meta mb-3">Hooks on file</p>
                <div className="space-y-3">
                  {selected.score.hooks.map((hook, index) => (
                    <div key={index} className="soft-card p-4">
                      <span className="tag">{hook.flavor.replace(/_/g, " ")}</span>
                      <p className="mt-1 text-[14.5px] leading-relaxed text-[#17191c]">{hook.body}</p>
                    </div>
                  ))}
                </div>
              </div>

              <p className="mt-5 text-[13px] leading-relaxed text-[#777b86]">{selected.score.rationale}</p>
            </div>
          ) : (
            <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
              <p className="font-display text-[24px] text-[#17191c]">
                {selected ? "Not scored yet" : "Select a prospect"}
              </p>
              <p className="mt-2 max-w-[320px] text-[14.5px] leading-relaxed text-[#777b86]">
                {selected
                  ? "Hit Score on the pipeline row — Claude returns the vulnerability breakdown, evidence and three cold-email hooks."
                  : "Pick any row in the pipeline to inspect its Quote Leakage Vulnerability breakdown, evidence and hooks."}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
