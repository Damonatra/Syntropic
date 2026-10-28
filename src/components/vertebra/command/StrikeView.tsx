/** STRIKE — the ranked margin-recovery queue. Luminance target cards, keyboard loop. */
"use client";

import { useMemo } from "react";
import { Chip, EmptyHint, ErpBadge, HudMeta, LiveDot, PillButton, PriorityBar, ScoreBlock, SectionLabel, SoftCard } from "./bits";
import { EVENT_VERBS, PORTAL_LABELS, heatLevel, money, relTime, verticalLabel, type CommandLead, type CommandSnapshot } from "@/lib/vertebra/command";

export type StrikeFilter = "all" | "critical" | "hot" | "now";

/** Shared ranking — the root uses it for the keyboard loop, the view renders it. */
export function computeRanked(snap: CommandSnapshot, filter: StrikeFilter, now: number): CommandLead[] {
  const eligible = snap.leads.filter((l) => {
    if (l.score == null) return false;
    if (l.snoozedUntilMs != null && l.snoozedUntilMs > now) return false;
    return true;
  });
  const sorted = [...eligible].sort((a, b) => b.priority - a.priority);
  switch (filter) {
    case "critical":
      return sorted.filter((l) => (l.score?.qlvScore ?? 0) >= 85);
    case "hot":
      return sorted.filter((l) => (l.score?.qlvScore ?? 0) >= 70);
    case "now":
      return sorted.filter((l) => l.highIntentNow);
    default:
      return sorted;
  }
}

export function StrikeView({
  snap,
  ranked,
  now,
  cursorId,
  onCursor,
  onOpenDossier,
  onAction,
  filter,
  onFilter,
}: {
  snap: CommandSnapshot;
  ranked: CommandLead[];
  now: number;
  cursorId: string | null;
  onCursor: (id: string) => void;
  onOpenDossier: (lead: CommandLead) => void;
  onAction: (prospectId: string, action: "called" | "deferred" | "snoozed" | "booked", note?: string) => void;
  filter: StrikeFilter;
  onFilter: (f: StrikeFilter) => void;
}) {
  const stake = useMemo(() => ranked.reduce((sum, l) => sum + (l.leakageUsd ?? 0), 0), [ranked]);
  const maxPriority = ranked[0]?.priority ?? 1;

  return (
    <div className="flex h-full flex-col overflow-y-auto cc-scroll p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Strike queue — ranked by effective priority</SectionLabel>
          <p className="mt-2 font-display text-[22px] font-semibold tracking-[-0.03em] text-[#F4F5F2]">
            {ranked.length} recovery targets · <span className="underline decoration-white/30 underline-offset-4">{money(stake)}</span> leakage at stake
          </p>
          <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#5F6460]">
            j / k move · enter dossier · c call · x defer · s snooze
          </p>
        </div>
        <div className="flex gap-2">
          {(
            [
              ["all", "All"],
              ["critical", "QLV ≥ 85"],
              ["hot", "QLV ≥ 70"],
              ["now", "On board now"],
            ] as Array<[StrikeFilter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => onFilter(key)}
              className={`h-8 rounded-full px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-all ${
                filter === key
                  ? "bg-[#F4F5F2] text-[#0B0C0B]"
                  : "border border-white/[0.12] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-3 pb-6">
        {ranked.length === 0 && <EmptyHint>Nothing matches this filter — the machine keeps working</EmptyHint>}
        {ranked.map((lead) => (
          <StrikeCard
            key={lead.id}
            lead={lead}
            now={now}
            maxPriority={maxPriority}
            focused={cursorId === lead.id}
            onFocus={() => onCursor(lead.id)}
            onOpen={() => onOpenDossier(lead)}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

function StrikeCard({
  lead,
  now,
  maxPriority,
  focused,
  onFocus,
  onOpen,
  onAction,
}: {
  lead: CommandLead;
  now: number;
  maxPriority: number;
  focused: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onAction: (prospectId: string, action: "called" | "deferred" | "snoozed" | "booked", note?: string) => void;
}) {
  const heat = heatLevel(lead.score?.qlvScore ?? null);
  const trigger =
    lead.telemetry.lastEventType != null && lead.telemetry.lastEventAtMs != null
      ? `${EVENT_VERBS[lead.telemetry.lastEventType] ?? lead.telemetry.lastEventType} ${relTime(lead.telemetry.lastEventAtMs, now)} · ${lead.city ?? "—"}, ${lead.country ?? "—"}`
      : "No telemetry yet — sequence-driven";
  const snoozed = lead.snoozedUntilMs != null && lead.snoozedUntilMs > now;

  return (
    <SoftCard
      onClick={onFocus}
      className={`cc-rise px-6 py-5 transition-all duration-150 ${
        focused
          ? "border-white/45 shadow-[0_0_0_1px_rgba(244,245,242,0.55)]"
          : ""
      } ${lead.highIntentNow ? "border-white/[0.24]" : ""}`}
    >
      {/* telemetry overlay */}
      <div className="mb-4 flex items-center justify-end gap-4">
        <HudMeta node={`AST-0${(lead.id.charCodeAt(4) % 8) + 1}`} hash={lead.id.slice(0, 4)} />
      </div>

      <div className="grid grid-cols-[84px_minmax(0,1fr)_auto] items-start gap-5">
        <div className="flex flex-col items-start gap-2.5">
          <ScoreBlock score={lead.score?.qlvScore ?? null} band={lead.score?.band ?? null} />
          <div className="w-full">
            <PriorityBar value={lead.priority} max={maxPriority} heat={heat} />
            <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#5F6460]">pri {Math.round(lead.priority)}</p>
          </div>
        </div>

        <div className="min-w-0" onMouseEnter={onFocus}>
          <div className="flex flex-wrap items-center gap-2">
            <p className={`font-display text-[16.5px] font-semibold tracking-[-0.02em] ${heat === "critical" ? "text-white" : "text-[#E9EBE7]"}`}>
              {lead.name}
            </p>
            {lead.highIntentNow && (
              <span className="inline-flex items-center gap-1.5">
                <LiveDot level="live" />
                <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#F4F5F2]">on board now</span>
              </span>
            )}
            {lead.pendingDrafts > 0 && <Chip tone="raised">{lead.pendingDrafts} draft{lead.pendingDrafts > 1 ? "s" : ""} pending</Chip>}
            {snoozed && <Chip tone="outline">snoozed</Chip>}
            {lead.dispatch?.status === "stopped" && <Chip tone="outline">stopped</Chip>}
          </div>

          <p className="mt-1 text-[13px] text-[#C9CCC7]">
            {lead.contact ? (
              <>
                {lead.contact.name} · {lead.contact.titleRaw} ·{" "}
                {lead.contact.phone ? (
                  <a
                    href={`tel:${lead.contact.phone.replace(/\s/g, "")}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-[12.5px] text-[#F4F5F2] underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white/70"
                  >
                    {lead.contact.phone}
                  </a>
                ) : (
                  <span className="text-[#6E736E]">direct line pending</span>
                )}
              </>
            ) : (
              <span className="text-[#6E736E]">No contact resolved</span>
            )}
          </p>

          <p className="mt-1.5 text-[12.5px] text-[#8E9194]">{trigger}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Chip tone="well">{verticalLabel(lead.vertical)}</Chip>
            {lead.erp && <ErpBadge erp={lead.erp.detected_erp} />}
            {lead.quotePortalType && <Chip>{PORTAL_LABELS[lead.quotePortalType] ?? lead.quotePortalType}</Chip>}
            {lead.clusterName && <Chip tone="outline">{lead.clusterName}</Chip>}
            {lead.leakageUsd != null && <Chip tone="raised">{money(lead.leakageUsd)} / yr leakage</Chip>}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2" onClick={(e) => e.stopPropagation()}>
          {lead.contact?.phone && (
            <PillButton tone="dark" href={`tel:${lead.contact.phone.replace(/\s/g, "")}`} className="w-[104px]">
              Call
            </PillButton>
          )}
          <PillButton tone="ghost" onClick={onOpen} className="w-[104px]">
            Dossier
          </PillButton>
          <div className="flex gap-1.5">
            <button
              onClick={() => onAction(lead.id, "deferred")}
              className="tactile-btn h-8 rounded-full border border-white/[0.12] bg-[#131513] px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8E9194] hover:text-[#F4F5F2]"
            >
              Defer
            </button>
            <button
              onClick={() => onAction(lead.id, "snoozed", undefined)}
              className="tactile-btn h-8 rounded-full border border-white/[0.12] bg-[#131513] px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8E9194] hover:text-[#F4F5F2]"
            >
              Snooze
            </button>
          </div>
        </div>
      </div>
    </SoftCard>
  );
}
