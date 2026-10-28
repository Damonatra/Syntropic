/** PORTAL — the Margin Defense Portal: entry anchor, estimator, intake, commercial path. */
"use client";

import { useRef } from "react";
import { HudMeta, SectionLabel } from "../bits";
import { GuaranteeBanner } from "./GuaranteeBanner";
import { LeakageCalculator } from "./LeakageCalculator";
import { AuditDropzone } from "./AuditDropzone";
import { RevShareTracker } from "./RevShareTracker";
import type { CommandSnapshot } from "@/lib/vertebra/command";

export function PortalView({ snap }: { snap: CommandSnapshot }) {
  const intakeRef = useRef<HTMLDivElement>(null);

  const beginIntake = () => intakeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto cc-scroll p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Margin Defense Portal — executive entry</SectionLabel>
          <p className="mt-2 font-display text-[22px] font-semibold tracking-[-0.03em] text-[#F4F5F2]">
            Diagnose the leak · defend the margin · pay out of recovery
          </p>
        </div>
        <HudMeta node="AST-09" hash="e04d" />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <GuaranteeBanner onBegin={beginIntake} />
        <LeakageCalculator />
      </div>

      <div ref={intakeRef} className="grid grid-cols-1 gap-5 scroll-mt-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <AuditDropzone />
        <RevShareTracker snap={snap} />
      </div>

      {/* engagement terms strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {(
          [
            ["01 · diagnostic audit", "$3,500", "Full forensics on 24 months of quotes, SPAs and cost sheets. Deposit credited to any SOW."],
            ["02 · enterprise sow", "$50,000", "Margin Defense deployment — RFQ interception, SPA enforcement, recovery operations across branches."],
            ["03 · net-margin rev-share", "20%", "The engine participates in recovered margin only. The distributor keeps 80% of every dollar closed."],
          ] as Array<[string, string, string]>
        ).map(([label, value, body]) => (
          <div key={label} className="neu rounded-lg px-6 py-5">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#8E9194]">{label}</p>
            <p className="mt-2 font-display text-[28px] font-semibold leading-none tracking-[-0.03em] text-[#F4F5F2]">{value}</p>
            <p className="mt-2.5 text-[12px] leading-relaxed text-[#8E9194]">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
