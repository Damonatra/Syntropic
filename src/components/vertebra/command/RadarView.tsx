/** RADAR — home surface: persona KPI strip, guarantee anchor, live telemetry feed, strike rail. */
"use client";

import { useMemo } from "react";
import { ArrowButton, Chip, EmptyHint, HudMeta, KpiCard, LiveDot, ScoreBlock, SectionLabel, SoftCard } from "./bits";
import {
  EVENT_VERBS,
  money,
  relTime,
  type CommandLead,
  type CommandSnapshot,
  type FeedItem,
} from "@/lib/vertebra/command";
import { personaMetrics, type PersonaId } from "@/lib/vertebra/persona";

export function RadarView({
  snap,
  now,
  freshEventIds,
  persona,
  onOpenDossier,
  onGoStrike,
  onGoPipeline,
  onGoPortal,
}: {
  snap: CommandSnapshot;
  now: number;
  freshEventIds: Set<string>;
  persona: PersonaId;
  onOpenDossier: (lead: CommandLead) => void;
  onGoStrike: () => void;
  onGoPipeline: () => void;
  onGoPortal: () => void;
}) {
  const { leads, feed, triage } = snap;

  const metrics = useMemo(() => personaMetrics(persona, snap), [persona, snap]);
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
      {/* Guarantee anchor — the entry offer, always one glance away */}
      <SoftCard className="ink flex flex-wrap items-center gap-x-8 gap-y-3 px-7 py-5" interactive onClick={onGoPortal}>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[9.5px] font-medium uppercase tracking-[0.22em] text-white/50">
            Entry anchor // Diagnostic audit — $3,500 deposit
          </p>
          <p className="mt-1.5 font-display text-[19px] font-medium leading-snug tracking-[-0.02em] text-white">
            Backed by a <span className="text-white underline decoration-white/30 underline-offset-4">$10,000 Margin Leakage Recovery Guarantee</span> — or we
            keep working the recovery free.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <HudMeta node="AST-01" hash="b3f7" className="!text-white/45" />
          <ArrowButton dark={false} label="Open Margin Defense Portal" />
        </div>
      </SoftCard>

      {/* Persona KPI strip */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {metrics.map((m, i) => (
          <KpiCard
            key={m.label}
            label={m.label}
            value={m.value}
            sub={m.sub}
            hot={m.hot}
            node={`AST-0${i + 2}`}
            onClick={i === 0 ? onGoStrike : i === 2 ? onGoPipeline : undefined}
          />
        ))}
      </div>

      <div className="grid flex-1 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Live feed */}
        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <LiveDot level="live" />
              <SectionLabel>Live telemetry — Module 8 · distributor quote portals</SectionLabel>
            </div>
            <HudMeta node="AST-04" hash="8f3a" />
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
              className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#5F646D] transition-colors hover:text-[#08080A]"
            >
              Full queue →
            </button>
          </div>
          <div className="flex flex-col gap-2.5">
            {strikeQueue.length === 0 && <EmptyHint>Queue clear</EmptyHint>}
            {strikeQueue.map((lead, idx) => (
              <RailCard key={lead.id} lead={lead} rank={idx + 1} now={now} onClick={() => onOpenDossier(lead)} />
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
      className={`cc-rise px-5 py-3.5 ${fresh ? "border-black/[0.14]" : ""} ${hot ? "border-black/[0.16] shadow-[10px_12px_26px_rgba(0,0,0,0.09),-10px_-10px_22px_rgba(255,255,255,0.95)]" : ""}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <ScoreBlock score={item.qlvScore} band={null} size="sm" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className={`truncate text-[14px] font-medium ${hot ? "text-[#08080A]" : "text-[#1A1D21]"}`}>{item.prospectName}</p>
              <Chip tone={hot ? "inverted" : "default"}>{item.eventType.replace(/_/g, " ")}</Chip>
              {item.alertFired && <Chip tone="well">alert dispatched</Chip>}
            </div>
            <p className="mt-1 truncate text-[12.5px] text-[#5F646D]">
              {EVENT_VERBS[item.eventType] ?? item.eventType} · {item.city ?? "—"}, {item.country ?? "—"}
              {item.device ? ` · ${item.device}` : ""}
              {item.durationMs ? ` · ${Math.round(item.durationMs / 1000)}s` : ""}
            </p>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[#8A8F97]">{relTime(item.occurredAtMs, now)}</span>
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
    <SoftCard interactive onClick={onClick} className={`px-4 py-3 ${lead.highIntentNow ? "border-black/[0.16]" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-[#A6ABB2]">{String(rank).padStart(2, "0")}</span>
        <ScoreBlock score={lead.score?.qlvScore ?? null} band={null} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={`truncate text-[13px] font-medium ${lead.highIntentNow ? "text-[#08080A]" : "text-[#1A1D21]"}`}>{lead.name}</p>
            {lead.highIntentNow && <LiveDot level="live" />}
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-[#5F646D]">{trigger}</p>
        </div>
      </div>
    </SoftCard>
  );
}
