/** Rev-share & SOW progress tracker — Diagnostic Audit → Enterprise SOW conversion flow. */
"use client";

import { HudMeta, SectionLabel } from "../bits";
import type { CommandSnapshot } from "@/lib/vertebra/command";

const AUDIT_FEE = 3_500;
const SOW_FEE = 50_000;
const REV_SHARE = 0.2;

export function RevShareTracker({ snap }: { snap: CommandSnapshot }) {
  const auditQualified = snap.leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85).length;

  // Worked example on stated commercial terms — $1.2M recovered margin engagement.
  const exampleRecovered = 1_200_000;
  const exampleRevShare = exampleRecovered * REV_SHARE;
  const exampleValue = SOW_FEE + exampleRevShare;

  return (
    <div className="neu-lg flex flex-col rounded-lg px-7 py-6">
      <div className="flex items-center justify-between">
        <SectionLabel>Rev-share &amp; SOW path</SectionLabel>
        <HudMeta node="AST-03" hash="5ab8" />
      </div>

      <div className="mt-4 grid grid-cols-1 items-stretch gap-2.5 sm:grid-cols-[1fr_auto_1fr]">
        {/* stage 01 */}
        <div className="neu-well rounded-lg px-5 py-4">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#8E9194]">stage 01 // diagnostic audit</p>
          <p className="mt-1.5 font-display text-[24px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[#F4F5F2]">
            ${AUDIT_FEE.toLocaleString("en-US")}
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-[#8E9194]">
            Deposit · full margin forensics on your quote history · credited dollar-for-dollar against the SOW.
          </p>
          <div className="mt-3 h-[5px] w-full overflow-hidden rounded-full bg-[#232623]">
            <div className="h-full w-full rounded-full bg-[#F4F5F2]" />
          </div>
          <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#6E736E]">entry · {auditQualified} accounts qualified (QLV ≥ 85)</p>
        </div>

        {/* connector */}
        <div className="flex items-center justify-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-[#F4F5F2] text-[#0B0C0B]">→</span>
        </div>

        {/* stage 02 */}
        <div className="ink rounded-lg px-5 py-4">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/65">stage 02 // enterprise sow</p>
          <p className="mt-1.5 font-display text-[24px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-white">
            ${SOW_FEE.toLocaleString("en-US")} + 20%
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-white/80">
            Margin Defense SOW · continuous RFQ interception, SPA enforcement and recovery ops · {REV_SHARE * 100}% net-margin rev-share on everything
            recovered.
          </p>
          <div className="mt-3 h-[5px] w-full overflow-hidden rounded-full bg-white/25">
            <div className="h-full w-[62%] rounded-full bg-white" />
          </div>
          <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-white/60">median audit → SOW conversion · 62% of cohort</p>
        </div>
      </div>

      {/* worked example */}
      <div className="neu-well mt-3 rounded-lg px-5 py-4">
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#8E9194]">worked example · $1.2M recovered margin engagement</p>
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-8 gap-y-2 font-display text-[17px] font-semibold tracking-[-0.02em] tabular-nums text-[#F4F5F2]">
          <span>SOW ${SOW_FEE.toLocaleString("en-US")}</span>
          <span className="text-[#6E736E]">+</span>
          <span>rev-share ${Math.round(exampleRevShare).toLocaleString("en-US")}</span>
          <span className="text-[#6E736E]">=</span>
          <span className="underline decoration-white/30 underline-offset-4">${Math.round(exampleValue).toLocaleString("en-US")} contract value</span>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-[#8E9194]">
          The distributor keeps {100 - REV_SHARE * 100}% of every recovered dollar — the engine is paid out of leakage it closed, never out of working margin.
        </p>
      </div>
    </div>
  );
}
