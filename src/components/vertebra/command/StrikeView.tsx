/** STRIKE — the ranked action queue. Soft cards, keyboard loop, zero drilling. */
"use client";

import { useMemo } from "react";
import { Chip, EmptyHint, LiveDot, PriorityBar, ScoreBlock, SectionLabel, SoftCard } from "./bits";
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
          <p className="mt-2 font-serif text-[22px] tracking-[-0.01em] text-[#f2f2f4]">
            {ranked.length} actions · <span className="text-[#fafafa]">{money(stake)}</span> leakage at stake
          </p>
          <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#4a4a52]">
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
              className={`h-8 rounded-xl px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-colors ${
                filter === key ? "bg-[#fafafa] text-[#0a0a0b]" : "border border-[#232327] text-[#8b8b93] hover:text-[#d6d6db]"
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
      className={`cc-rise px-5 py-4 transition-all duration-150 ${
        focused ? "border-[#3a3a41] bg-[#151518] shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_0_50px_-18px_rgba(250,250,250,0.16)]" : ""
      } ${lead.highIntentNow ? "border-[#33333a]" : ""}`}
    >
      <div className="grid grid-cols-[84px_minmax(0,1fr)_auto] items-start gap-5">
        <div className="flex flex-col items-start gap-2.5">
          <ScoreBlock score={lead.score?.qlvScore ?? null} band={lead.score?.band ?? null} />
          <div className="w-full">
            <PriorityBar value={lead.priority} max={maxPriority} heat={heat} />
            <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#3f3f46]">
              pri {Math.round(lead.priority)}
            </p>
          </div>
        </div>

        <div className="min-w-0" onMouseEnter={onFocus}>
          <div className="flex flex-wrap items-center gap-2">
            <p className={`text-[16px] font-medium ${heat === "critical" ? "text-[#fafafa]" : "text-[#e4e4e8]"}`}>{lead.name}</p>
            {lead.highIntentNow && (
              <span className="inline-flex items-center gap-1.5">
                <LiveDot level="live" />
                <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#fafafa]">on board now</span>
              </span>
            )}
            {lead.pendingDrafts > 0 && <Chip tone="raised">{lead.pendingDrafts} draft{lead.pendingDrafts > 1 ? "s" : ""} pending</Chip>}
            {snoozed && <Chip tone="outline">snoozed</Chip>}
            {lead.dispatch?.status === "stopped" && <Chip tone="outline">stopped</Chip>}
          </div>

          <p className="mt-1 text-[13px] text-[#b6b6bd]">
            {lead.contact ? (
              <>
                {lead.contact.name} · {lead.contact.titleRaw} ·{" "}
                {lead.contact.phone ? (
                  <a
                    href={`tel:${lead.contact.phone.replace(/\s/g, "")}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-[12.5px] text-[#e4e4e8] underline decoration-[#33333a] underline-offset-4 transition-colors hover:decoration-[#8b8b93]"
                  >
                    {lead.contact.phone}
                  </a>
                ) : (
                  <span className="text-[#5c5c64]">direct line pending</span>
                )}
              </>
            ) : (
              <span className="text-[#5c5c64]">No contact resolved</span>
            )}
          </p>

          <p className="mt-1.5 text-[12.5px] text-[#8b8b93]">{trigger}</p>

          <div className="mt-2.5 flex flex-wrap gap-2">
            <Chip tone="raised">{verticalLabel(lead.vertical)}</Chip>
            {lead.erp && <Chip>{lead.erp.detected_erp}</Chip>}
            {lead.quotePortalType && <Chip>{PORTAL_LABELS[lead.quotePortalType] ?? lead.quotePortalType}</Chip>}
            {lead.clusterName && <Chip tone="outline">{lead.clusterName}</Chip>}
            {lead.leakageUsd != null && <Chip tone="outline">{money(lead.leakageUsd)} / yr leakage</Chip>}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2" onClick={(e) => e.stopPropagation()}>
          {lead.contact?.phone && (
            <a
              href={`tel:${lead.contact.phone.replace(/\s/g, "")}`}
              className="inline-flex h-9 items-center rounded-xl bg-[#fafafa] px-4 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[#0a0a0b] transition-opacity hover:opacity-85"
            >
              Call
            </a>
          )}
          <button
            onClick={onOpen}
            className="inline-flex h-9 items-center rounded-xl border border-[#2a2a2f] px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-[#d6d6db] transition-colors hover:bg-[#1a1a1e]"
          >
            Dossier
          </button>
          <div className="flex gap-1.5">
            <button
              onClick={() => onAction(lead.id, "deferred")}
              className="inline-flex h-8 items-center rounded-lg border border-[#232327] px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8b8b93] transition-colors hover:bg-[#1a1a1e]"
            >
              Defer
            </button>
            <button
              onClick={() => onAction(lead.id, "snoozed", undefined)}
              className="inline-flex h-8 items-center rounded-lg border border-[#232327] px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#8b8b93] transition-colors hover:bg-[#1a1a1e]"
            >
              Snooze
            </button>
          </div>
        </div>
      </div>
    </SoftCard>
  );
}
