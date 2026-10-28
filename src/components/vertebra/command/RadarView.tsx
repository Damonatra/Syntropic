/** RADAR — home surface: KPI strip, live telemetry feed, slim strike rail. */
"use client";

import { useMemo } from "react";
import { Chip, EmptyHint, KpiCard, LiveDot, ScoreBlock, SectionLabel, SoftCard } from "./bits";
import {
  EVENT_VERBS,
  money,
  relTime,
  type CommandLead,
  type CommandSnapshot,
  type FeedItem,
} from "@/lib/vertebra/command";

export function RadarView({
  snap,
  now,
  freshEventIds,
  onOpenDossier,
  onGoStrike,
  onGoPipeline,
}: {
  snap: CommandSnapshot;
  now: number;
  freshEventIds: Set<string>;
  onOpenDossier: (lead: CommandLead) => void;
  onGoStrike: () => void;
  onGoPipeline: () => void;
}) {
  const { leads, feed, triage } = snap;

  const hotLeads = useMemo(
    () => leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85).sort((a, b) => b.priority - a.priority),
    [leads],
  );
  const highIntent = useMemo(() => leads.filter((l) => l.highIntentNow), [leads]);
  const stake = useMemo(
    () => hotLeads.reduce((sum, l) => sum + (l.leakageUsd ?? 0), 0),
    [hotLeads],
  );
  const strikeQueue = useMemo(
    () =>
      leads
        .filter((l) => l.score != null && (l.telemetry.lastHighSignalAtMs == null || l.telemetry.lastHighSignalAtMs > now - 43_200_000))
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 8),
    [leads, now],
  );

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto cc-scroll p-6">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard
          label="High-intent now"
          value={String(highIntent.length).padStart(2, "0")}
          sub={highIntent.length > 0 ? highIntent.map((l) => l.name).join(" · ") : "No critical-band activity in the last 15m"}
          hot={highIntent.length > 0}
          onClick={onGoStrike}
        />
        <KpiCard
          label="Critical band"
          value={String(hotLeads.length).padStart(2, "0")}
          sub={`QLV ≥ 85 · ${money(stake)} leakage at stake`}
          onClick={onGoStrike}
        />
        <KpiCard
          label="Drafts pending"
          value={String(triage.pending.length).padStart(2, "0")}
          sub={triage.pending.length > 0 ? "Reply agent awaiting your review" : "Agent queue clear"}
          hot={triage.pending.length > 0}
          onClick={onGoPipeline}
        />
        <KpiCard
          label="Telemetry 24h"
          value={String(snap.ops.telemetryEvents24h)}
          sub={`${snap.ops.alerts24h} alerts · ${snap.ops.dispatchesSent24h} dispatches`}
        />
      </div>

      <div className="grid flex-1 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Live feed */}
        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <LiveDot level="live" />
              <SectionLabel>Live telemetry — Module 8</SectionLabel>
            </div>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#3f3f46]">
              socket bridge · {feed.length} events
            </span>
          </div>

          {feed.length === 0 ? (
            <EmptyHint>Waiting for the first signal…</EmptyHint>
          ) : (
            <div className="flex flex-col gap-2.5">
              {feed.slice(0, 14).map((item) => (
                <FeedCard
                  key={item.id}
                  item={item}
                  now={now}
                  fresh={freshEventIds.has(item.id)}
                  onClick={() => {
                    const lead = leads.find((l) => l.id === item.prospectId);
                    if (lead) onOpenDossier(lead);
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {/* Strike rail */}
        <aside className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <SectionLabel>Strike rail — today</SectionLabel>
            <button
              onClick={onGoStrike}
              className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#8b8b93] transition-colors hover:text-[#f2f2f4]"
            >
              Full queue →
            </button>
          </div>
          <div className="flex flex-col gap-2.5">
            {strikeQueue.length === 0 && <EmptyHint>Queue clear</EmptyHint>}
            {strikeQueue.map((lead, idx) => (
              <RailCard
                key={lead.id}
                lead={lead}
                rank={idx + 1}
                now={now}
                onClick={() => onOpenDossier(lead)}
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function FeedCard({
  item,
  now,
  fresh,
  onClick,
}: {
  item: FeedItem;
  now: number;
  fresh: boolean;
  onClick: () => void;
}) {
  const hot = (item.qlvScore ?? 0) >= 85 && ["portal_visit", "audit_view", "document_download"].includes(item.eventType);
  return (
    <SoftCard
      interactive
      onClick={onClick}
      className={`cc-rise px-5 py-3.5 ${fresh ? "border-[#33333a] bg-[#141417]" : ""} ${hot ? "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_0_40px_-14px_rgba(250,250,250,0.14)]" : ""}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <ScoreBlock score={item.qlvScore} band={null} size="sm" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className={`truncate text-[14px] font-medium ${hot ? "text-[#fafafa]" : "text-[#e4e4e8]"}`}>{item.prospectName}</p>
              <Chip tone={hot ? "inverted" : "default"}>{item.eventType.replace(/_/g, " ")}</Chip>
              {item.alertFired && <Chip tone="raised">alert dispatched</Chip>}
            </div>
            <p className="mt-1 truncate text-[12.5px] text-[#8b8b93]">
              {EVENT_VERBS[item.eventType] ?? item.eventType} · {item.city ?? "—"}, {item.country ?? "—"}
              {item.device ? ` · ${item.device}` : ""}
              {item.durationMs ? ` · ${Math.round(item.durationMs / 1000)}s` : ""}
            </p>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[#5c5c64]">{relTime(item.occurredAtMs, now)}</span>
      </div>
    </SoftCard>
  );
}

function RailCard({
  lead,
  rank,
  now,
  onClick,
}: {
  lead: CommandLead;
  rank: number;
  now: number;
  onClick: () => void;
}) {
  const trigger =
    lead.telemetry.lastEventType != null && lead.telemetry.lastEventAtMs != null
      ? `${EVENT_VERBS[lead.telemetry.lastEventType] ?? lead.telemetry.lastEventType} ${relTime(lead.telemetry.lastEventAtMs, now)}`
      : "No telemetry yet";
  return (
    <SoftCard interactive onClick={onClick} className={`px-4 py-3 ${lead.highIntentNow ? "border-[#3a3a41]" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-[#3f3f46]">{String(rank).padStart(2, "0")}</span>
        <ScoreBlock score={lead.score?.qlvScore ?? null} band={null} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={`truncate text-[13px] font-medium ${lead.highIntentNow ? "text-[#fafafa]" : "text-[#e4e4e8]"}`}>
              {lead.name}
            </p>
            {lead.highIntentNow && <LiveDot level="live" />}
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-[#6b6b72]">{trigger}</p>
        </div>
      </div>
    </SoftCard>
  );
}
