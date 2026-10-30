/** Territory drawer — L1 depth: the full operational sheet for one state or province.
 *
 * Opens when the operator commits to a territory on the theatre board. Everything
 * here is derived from the same census the board shades by — the drawer never
 * invents a number the map can't see: funnel from dispatch statuses, consent mix
 * from caslScope, the ladder from QLV, replies from the live triage pool.
 */
"use client";

import { useMemo } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Chip, EmptyHint, SectionLabel } from "./bits";
import {
  HEAT_FILL,
  heatLevel,
  money,
  relTime,
  verticalLabel,
  type CommandLead,
} from "@/lib/vertebra/command";
import type { TerritoryDelta, TerritoryStat } from "@/lib/vertebra/theatre";
import { territoryCallWindow } from "@/lib/vertebra/theatre";

const FUNNEL_STAGES = [
  { key: "mailStaged", label: "staged" },
  { key: "mailSent", label: "sent" },
  { key: "mailQueued", label: "queued" },
  { key: "mailFailed", label: "failed" },
] as const;

function StatCell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <p
        className={`mt-1.5 tabular-nums ${strong ? "font-mono text-[15px] font-medium text-[#F4F5F2]" : "font-mono text-[13px] text-[#E9EBE7]"}`}
      >
        {value}
      </p>
    </div>
  );
}

export function TerritoryDrawer({
  stat,
  nowMs,
  open,
  onOpenChange,
  onOpenDossier,
  pendingReplies,
  filterLabel,
  delta,
  ledgerMature,
}: {
  stat: TerritoryStat | null;
  nowMs: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenDossier: (lead: CommandLead) => void;
  /** prospectId → live replies sitting in triage (Map from the snapshot) */
  pendingReplies: Map<string, number>;
  /** active M1 filter label when the board is filtered — printed for honesty */
  filterLabel: string | null;
  /** 24h movement for this territory from the pulse ledger (null when quiet) */
  delta: TerritoryDelta | null;
  /** false while the ledger has no prior-window rows — deltas refuse to fake history */
  ledgerMature: boolean;
}) {
  const ladder = useMemo(
    () =>
      stat
        ? [...stat.leads].sort(
            (a, b) => (b.score?.qlvScore ?? -1) - (a.score?.qlvScore ?? -1) || (b.priority ?? 0) - (a.priority ?? 0),
          )
        : [],
    [stat],
  );

  const inTriage = useMemo(
    () => (stat ? stat.leads.reduce((sum, l) => sum + (pendingReplies.get(l.id) ?? 0), 0) : 0),
    [stat, pendingReplies],
  );

  const caslFalse = stat ? stat.count - stat.caslTrue : 0;
  const consentPct = stat && stat.count > 0 ? Math.round((stat.caslTrue / stat.count) * 100) : null;

  const callWindow = useMemo(() => (stat ? territoryCallWindow(stat.code, nowMs) : null), [stat, nowMs]);
  const movementSub = !delta
    ? ledgerMature
      ? "no movement logged in the ledger"
      : "ledger young — deltas arm once 48h accumulate"
    : delta.prior24h > 0
      ? delta.direction === "up"
        ? `accelerating vs prior 24h (${delta.prior24h} rows)`
        : delta.direction === "down"
          ? `cooling vs prior 24h (${delta.prior24h} rows)`
          : `steady vs prior 24h (${delta.prior24h} rows)`
      : "no prior-window comparison for this territory";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="command-root cc-scroll w-full overflow-y-auto border-l border-white/[0.10] bg-[#0B0C0B] p-0 text-[#F4F5F2] antialiased sm:max-w-[520px]"
      >
        {!stat ? (
          <SheetHeader className="sr-only">
            <SheetTitle>Territory drawer</SheetTitle>
          </SheetHeader>
        ) : (
          <div className="flex flex-col gap-6 p-6 pb-8">
            <SheetHeader className="p-0">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#5F6460]">
                  TERRITORY // {stat.code}
                </span>
                <Chip tone="outline">{stat.country === "CA" ? "CASL" : "CAN-SPAM"}</Chip>
              </div>
              <SheetTitle className="font-display text-[24px] font-semibold leading-tight tracking-[-0.03em] text-[#F4F5F2]">
                {stat.name}
              </SheetTitle>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5F6460]">
                {stat.type} · {stat.country === "CA" ? "consent-first regime" : "opt-out regime"} ·{" "}
                {filterLabel ? `filtered view: ${filterLabel}` : "unfiltered view"}
              </p>
            </SheetHeader>

            {/* stat band */}
            <div className="grid grid-cols-3 gap-x-6 gap-y-4 border-y border-white/[0.08] py-4">
              <StatCell label="Prospects" value={String(stat.count)} strong />
              <StatCell label="Critical band" value={String(stat.critical)} strong />
              <StatCell label="Avg QLV" value={stat.avgQlv != null ? String(stat.avgQlv) : "—"} />
              <StatCell label="Exposure" value={money(stat.leakageUsd)} strong />
              <StatCell
                label="Last touch"
                value={stat.lastTouchMs ? relTime(stat.lastTouchMs, nowMs) : "—"}
              />
              <StatCell label="In sequence" value={String(stat.inSequence)} />
            </div>

            {/* operating clock + 24h movement (Map-4) */}
            <div className="grid grid-cols-2 gap-x-6 border-b border-white/[0.08] pb-4">
              <div>
                <SectionLabel>Call window{callWindow ? ` · ${callWindow.zoneShort}` : ""}</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">
                  {callWindow ? `${callWindow.dayShort} ${callWindow.clock}` : "—"}
                </p>
                <p
                  className={`mt-1 font-mono text-[9.5px] uppercase tracking-[0.13em] ${
                    callWindow?.open ? "text-[#F4F5F2]" : "text-[#5F6460]"
                  }`}
                >
                  {callWindow?.label ?? "timezone unresolved"}
                </p>
              </div>
              <div>
                <SectionLabel>24h movement</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">
                  {delta ? delta.readout : "· 0"}
                </p>
                <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.13em] text-[#5F6460]">{movementSub}</p>
              </div>
            </div>

            {/* mail funnel */}
            <div>
              <SectionLabel className="mb-2.5">Mail funnel</SectionLabel>
              <div className="grid grid-cols-5 gap-2">
                {FUNNEL_STAGES.map((stage) => {
                  const n = stat[stage.key];
                  return (
                    <div
                      key={stage.key}
                      className={`rounded-md border px-2 py-2.5 text-center ${
                        n > 0 ? "border-white/[0.14] bg-[#161816]" : "border-white/[0.06] bg-[#101210]"
                      }`}
                    >
                      <p
                        className={`font-mono text-[16px] tabular-nums ${n > 0 ? "text-[#F4F5F2]" : "text-[#3F433F]"}`}
                      >
                        {n}
                      </p>
                      <p className="mt-0.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-[#5F6460]">
                        {stage.label}
                      </p>
                    </div>
                  );
                })}
                <div
                  className={`rounded-md border px-2 py-2.5 text-center ${
                    inTriage > 0 ? "border-white/[0.14] bg-[#161816]" : "border-white/[0.06] bg-[#101210]"
                  }`}
                >
                  <p
                    className={`font-mono text-[16px] tabular-nums ${inTriage > 0 ? "text-[#F4F5F2]" : "text-[#3F433F]"}`}
                  >
                    {inTriage}
                  </p>
                  <p className="mt-0.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-[#5F6460]">
                    in triage
                  </p>
                </div>
              </div>
              {stat.mailFailed > 0 && (
                <p className="mt-2 font-mono text-[9.5px] uppercase tracking-[0.13em] text-[#8E9194]">
                  {stat.mailFailed} failed dispatch{stat.mailFailed === 1 ? "" : "es"} — check the strike queue before re-staging
                </p>
              )}
            </div>

            {/* consent mix */}
            <div>
              <SectionLabel className="mb-2.5">Consent mix</SectionLabel>
              <div className="flex h-2 overflow-hidden rounded-full bg-[#131513]">
                <div
                  className="h-full bg-[#8E9194]"
                  style={{ width: `${consentPct ?? 0}%` }}
                  role="presentation"
                />
              </div>
              <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.13em]">
                <span className="text-[#E9EBE7]">{stat.caslTrue} consent-true</span>
                <span className="text-[#5F6460]">{caslFalse} not in scope</span>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-[#8E9194]">
                {stat.country === "CA"
                  ? `CASL gate — ${stat.caslTrue} of ${stat.count} consent-true before any mail leaves the enclave. Channel B high-touch covers the rest.`
                  : "CAN-SPAM opt-out regime — unsubscribe footer is mandatory, consent is not. CASL rules still apply to any Canadian contact inside these accounts."}
              </p>
            </div>

            {/* QLV ladder */}
            <div>
              <div className="mb-2.5 flex items-center justify-between">
                <SectionLabel>Prospects by QLV</SectionLabel>
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#3F433F]">
                  {ladder.length} shown · click opens dossier
                </span>
              </div>
              {ladder.length === 0 ? (
                <EmptyHint>No accounts inside this territory under the active filter.</EmptyHint>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {ladder.map((lead) => {
                    const heat = heatLevel(lead.score?.qlvScore ?? null);
                    return (
                      <button
                        key={lead.id}
                        onClick={() => onOpenDossier(lead)}
                        className="group flex items-center gap-3 rounded-md border border-white/[0.07] bg-[#101210] px-3 py-2.5 text-left transition-colors hover:border-white/[0.18] hover:bg-[#161816]"
                      >
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ background: HEAT_FILL[heat] }}
                          aria-label={`${heat} band`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-[#F4F5F2]">
                            {lead.name}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#5F6460]">
                            {lead.city ?? "—"} · {verticalLabel(lead.vertical)}
                            {lead.dispatch ? ` · ${lead.dispatch.status}` : " · no mail"}
                            {pendingReplies.get(lead.id) ? ` · ${pendingReplies.get(lead.id)} reply` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-mono text-[14px] tabular-nums text-[#F4F5F2]">
                            {lead.score?.qlvScore ?? "—"}
                          </span>
                          <span className="block font-mono text-[9px] tabular-nums text-[#5F6460]">
                            {money(lead.leakageUsd ?? 0)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <p className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[#333732]">
              same census as the board · nothing counted here that the map cannot see
            </p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
