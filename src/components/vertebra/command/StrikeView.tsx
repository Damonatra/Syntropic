/** STRIKE — the ranked margin-recovery queue. Luminance target cards, keyboard loop. */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chip, EmptyHint, ErpBadge, HudMeta, LiveDot, PillButton, PriorityBar, ScoreBlock, SectionLabel, SoftCard } from "./bits";
import { EVENT_VERBS, PORTAL_LABELS, heatLevel, money, relTime, verticalLabel, type CommandLead, type CommandSnapshot } from "@/lib/vertebra/command";

export type StrikeFilter = "all" | "critical" | "hot" | "now";

/** Filter registry — drives the buttons, the echo line, and the count badges. */
export const STRIKE_FILTERS: Array<[StrikeFilter, string]> = [
  ["all", "All"],
  ["critical", "QLV ≥ 85"],
  ["hot", "QLV ≥ 70"],
  ["now", "On board now"],
];

/** Bucket predicate — single source of truth for ranking and count badges. */
export function filterMatch(lead: CommandLead, filter: StrikeFilter): boolean {
  switch (filter) {
    case "critical":
      return (lead.score?.qlvScore ?? 0) >= 85;
    case "hot":
      return (lead.score?.qlvScore ?? 0) >= 70;
    case "now":
      return lead.highIntentNow;
    default:
      return true;
  }
}

/** Shared ranking — the root uses it for the keyboard loop, the view renders it. */
export function computeRanked(snap: CommandSnapshot, filter: StrikeFilter, now: number): CommandLead[] {
  const eligible = snap.leads.filter((l) => {
    if (l.score == null) return false;
    if (l.snoozedUntilMs != null && l.snoozedUntilMs > now) return false;
    return true;
  });
  const sorted = [...eligible].sort((a, b) => b.priority - a.priority);
  return sorted.filter((l) => filterMatch(l, filter));
}

/** Live counts per filter over the eligible pool — drives the button badges. */
export function computeFilterCounts(snap: CommandSnapshot, now: number): Record<StrikeFilter, number> {
  const eligible = snap.leads.filter((l) => {
    if (l.score == null) return false;
    if (l.snoozedUntilMs != null && l.snoozedUntilMs > now) return false;
    return true;
  });
  const counts: Record<StrikeFilter, number> = { all: eligible.length, critical: 0, hot: 0, now: 0 };
  for (const l of eligible) {
    if ((l.score?.qlvScore ?? 0) >= 85) counts.critical += 1;
    if ((l.score?.qlvScore ?? 0) >= 70) counts.hot += 1;
    if (l.highIntentNow) counts.now += 1;
  }
  return counts;
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
  scrollTick = 0,
  acted = {},
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
  /** Bumped by the keyboard loop on every j/k — the only cursor source that scrolls. */
  scrollTick?: number;
  /** M5 — optimistic action ledger: prospectId -> action, drives the dim until fresh truth arrives. */
  acted?: Record<string, string>;
}) {
  const stake = useMemo(() => ranked.reduce((sum, l) => sum + (l.leakageUsd ?? 0), 0), [ranked]);
  const counts = useMemo(() => computeFilterCounts(snap, now), [snap, now]);
  const maxPriority = ranked[0]?.priority ?? 1;
  const activeLabel = STRIKE_FILTERS.find(([k]) => k === filter)?.[1] ?? "All";
  const cursorIdx = useMemo(() => ranked.findIndex((l) => l.id === cursorId), [ranked, cursorId]);
  const listRef = useRef<HTMLDivElement>(null);
  const listInnerRef = useRef<HTMLDivElement>(null);

  // M5 — cursor advance: when the lead under the cursor vanishes from the ranked
  // list (snoozed out, reclassified, filtered by the machine), the cursor moves to
  // the SAME index instead of jumping to the top. Muscle memory survives churn.
  const lastIdxRef = useRef(0);
  useEffect(() => {
    if (cursorIdx >= 0) {
      lastIdxRef.current = cursorIdx;
      return;
    }
    if (ranked.length > 0) onCursor(ranked[Math.min(lastIdxRef.current, ranked.length - 1)].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorIdx, ranked, cursorId]);

  // M5 — arrival buffer: live snapshot churn re-ranks the queue under the operator.
  // Never silently — count the disturbance and offer a reseat. Keyed on CONTENT
  // (joined ids), not array identity: `ranked` recomputes every clock tick, and a
  // reference-keyed effect would re-arm the comparison every second and kill the
  // strip one tick after it appears.
  const rankedKey = useMemo(() => ranked.map((l) => l.id).join("|"), [ranked]);
  const prevOrderRef = useRef<{ ids: string[]; filter: StrikeFilter } | null>(null);
  const [shift, setShift] = useState<{ moved: number; fresh: number } | null>(null);
  useEffect(() => {
    const ids = rankedKey ? rankedKey.split("|") : [];
    const prev = prevOrderRef.current;
    prevOrderRef.current = { ids, filter };
    if (!prev || prev.filter !== filter) {
      setShift(null);
      return;
    }
    const prevIdx = new Map(prev.ids.map((id, i) => [id, i]));
    let moved = 0;
    let fresh = 0;
    ids.forEach((id, i) => {
      const pi = prevIdx.get(id);
      if (pi == null) fresh += 1;
      else if (pi !== i) moved += 1;
    });
    setShift(moved > 0 || fresh > 0 ? { moved, fresh } : null);
  }, [rankedKey, filter]);

  function reseat() {
    const el = listInnerRef.current?.children[cursorIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // M1 — a filter change resets the viewport and snaps the cursor to card #1,
  // so the J/K loop always resumes from a visible anchor.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
    if (ranked.length > 0) onCursor(ranked[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // M2 — the keyboard loop bumps scrollTick on every j/k; hover-sourced cursor
  // moves never scroll, so the wheel and the keys never fight.
  useEffect(() => {
    if (scrollTick === 0) return;
    const el = listInnerRef.current?.children[cursorIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTick]);

  return (
    <div ref={listRef} className="flex h-full flex-col overflow-y-auto cc-scroll p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Strike queue — ranked by effective priority</SectionLabel>
          <p className="mt-2 font-display text-[22px] font-semibold tracking-[-0.03em] text-[#F4F5F2]">
            {ranked.length} recovery targets · <span className="underline decoration-white/30 underline-offset-4">{money(stake)}</span> leakage at stake
          </p>
          <p className="mt-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#5F6460]">
            filter <span className="text-[#F4F5F2]">{activeLabel}</span> — {ranked.length} of {counts.all} eligible · {money(stake)} at stake
          </p>
          <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#5F6460]">
            j / k move · enter dossier · e cold email · c dial · x defer · s snooze · f filter · ? help
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {STRIKE_FILTERS.map(([key, label]) => {
            const active = filter === key;
            const count = counts[key];
            return (
              <button
                key={key}
                onClick={() => onFilter(key)}
                aria-pressed={active}
                title={`${count} target${count === 1 ? "" : "s"} match${count === 1 ? "es" : ""} this filter`}
                className={`h-8 rounded-full px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-all ${
                  active
                    ? "bg-[#F4F5F2] text-[#0B0C0B]"
                    : `border border-white/[0.12] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2] ${count === 0 ? "opacity-45" : ""}`
                }`}
              >
                {label}
                <span className={`ml-1.5 tabular-nums ${active ? "text-[#0B0C0B]/55" : "text-[#5F6460]"}`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={listInnerRef} className="mt-5 flex flex-col gap-3 pb-6">
        {/* M5 — arrival buffer strip: the queue moved under the operator, say so */}
        {shift && (
          <button
            type="button"
            onClick={() => {
              setShift(null);
              reseat();
            }}
            className="flex h-9 items-center gap-2 rounded-full border border-white/[0.14] bg-[#131513] px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8E9194] transition-colors hover:border-white/30 hover:text-[#F4F5F2]"
          >
            <span className="size-1.5 rounded-full bg-[#8E9194] cc-pulse-dot" />
            queue shifted — {shift.moved} re-ranked{shift.fresh > 0 ? ` · +${shift.fresh} new` : ""} · click to reseat cursor
          </button>
        )}
        {ranked.length === 0 && (
          <div className="flex flex-col items-start gap-3">
            <EmptyHint>Nothing matches {activeLabel} — the machine keeps working</EmptyHint>
            {filter !== "all" && counts.all > 0 && (
              <button
                onClick={() => onFilter("all")}
                className="h-8 rounded-full border border-white/[0.12] bg-[#131513] px-4 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#8E9194] transition-colors hover:border-white/25 hover:text-[#F4F5F2]"
              >
                ← Back to all · {counts.all} eligible
              </button>
            )}
          </div>
        )}
        {ranked.map((lead, i) => (
          <StrikeCard
            key={lead.id}
            lead={lead}
            rank={i + 1}
            now={now}
            maxPriority={maxPriority}
            focused={cursorId === lead.id}
            actedState={acted[lead.id] ?? null}
            onFocus={() => onCursor(lead.id)}
            onOpen={() => onOpenDossier(lead)}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

const ACTED_LABELS: Record<string, string> = {
  called: "call logged",
  deferred: "deferred",
  snoozed: "snoozed",
  booked: "booked",
  note: "noted",
  emailed: "email staged",
};

/** M7 — QLV driver labels, short form for the card chips. */
const DRIVER_LABELS: Record<string, string> = {
  rfq_latency: "RFQ latency",
  legacy_portal: "legacy portal",
  unapplied_spa: "unapplied SPAs",
  manual_quoting_share: "manual quoting",
  vertical_fit: "vertical fit",
  size_fit: "size fit",
};

function StrikeCard({
  lead,
  rank,
  now,
  maxPriority,
  focused,
  actedState,
  onFocus,
  onOpen,
  onAction,
}: {
  lead: CommandLead;
  rank: number;
  now: number;
  maxPriority: number;
  focused: boolean;
  actedState: string | null;
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
  // M7 — top QLV driver: the factor with the largest weighted contribution
  const topDriver = useMemo(() => {
    const fs = lead.score?.factors ?? [];
    if (fs.length === 0) return null;
    return fs.reduce((a, b) => (b.points * b.weight > a.points * a.weight ? b : a));
  }, [lead.score]);
  // M7 — queue aging: untouched for a week+ earns a mark (lastAction, else score age)
  const lastTouch = lead.lastActionAtMs ?? (lead.score ? Date.parse(lead.score.createdAt) : null);
  const ageDays = lastTouch != null && Number.isFinite(lastTouch) ? Math.floor((now - lastTouch) / 86_400_000) : null;
  const aging = ageDays != null && ageDays >= 7 && !snoozed;

  return (
    <SoftCard
      onClick={onFocus}
      ariaCurrent={focused}
      className={`cc-rise relative overflow-hidden px-6 py-5 transition-all duration-150 ${
        focused
          ? "border-white/45 shadow-[0_0_0_1px_rgba(244,245,242,0.55)]"
          : ""
      } ${lead.highIntentNow ? "border-white/[0.24]" : ""} ${actedState ? "opacity-45" : ""}`}
    >
      {/* M2 — cursor marker: luminance edge bar, visible across the room */}
      {focused && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-[#F4F5F2]" />}

      {/* telemetry overlay */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#5F6460]">
            rank {String(rank).padStart(2, "0")}
          </span>
          {focused && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#F4F5F2]">
              <span className="size-1.5 rounded-full bg-[#F4F5F2] cc-pulse-dot" /> cursor
            </span>
          )}
          {actedState && (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#F4F5F2]">
              · {ACTED_LABELS[actedState] ?? actedState}
            </span>
          )}
          {aging && (
            <Chip tone={ageDays != null && ageDays >= 14 ? "raised" : "outline"}>
              {ageDays != null && ageDays >= 14 ? "stale" : "aging"} {ageDays}d
            </Chip>
          )}
        </div>
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
            {topDriver && (
              <Chip tone="raised">
                {DRIVER_LABELS[topDriver.key] ?? topDriver.key} · {Math.round(topDriver.points * topDriver.weight)}
              </Chip>
            )}
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
