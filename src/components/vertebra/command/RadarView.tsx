/** RADAR — home surface: guarantee anchor with live receipt, persona KPI strip, watchdog-gated telemetry feed, strike rail. */
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

import { PERSONAS, personaDef, personaMetrics, type PersonaId } from "@/lib/vertebra/persona";

/** The bridge posts every 9–18s — two minutes of silence means the pipe is dead, and the radar must say so. */
const STALE_MS = 120_000;

export function RadarView({
  snap,
  now,
  freshEventIds,
  connected,
  persona,
  onPersona,
  onOpenDossier,
  onGoStrike,
  onGoPipeline,
  onGoPortal,
}: {
  snap: CommandSnapshot;
  now: number;
  freshEventIds: Set<string>;
  connected: boolean;
  persona: PersonaId;
  onPersona: (p: PersonaId) => void;
  onOpenDossier: (lead: CommandLead) => void;
  onGoStrike: () => void;
  onGoPipeline: () => void;
  onGoPortal: () => void;
}) {
  const { leads, feed, ops } = snap;

  const metrics = useMemo(() => personaMetrics(persona, snap), [persona, snap]);
  const strikeQueue = useMemo(
    () =>
      leads
        .filter((l) => l.score != null && (l.telemetry.lastHighSignalAtMs == null || l.telemetry.lastHighSignalAtMs > now - 43_200_000))
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 8),
    [leads, now],
  );

  // ---- staleness watchdog ------------------------------------------------- //
  // Feed recency is push-accurate (socket handler prepends to snap.feed), so
  // the age of the newest item IS the age of the last live signal.
  const latestFeedMs = useMemo(() => (feed.length ? Math.max(...feed.map((f) => f.occurredAtMs)) : null), [feed]);
  const stale = !connected || (latestFeedMs != null && now - latestFeedMs > STALE_MS);
  const lastSignalAgo = latestFeedMs != null ? relTime(latestFeedMs, now) : "—";

  // ---- live receipt — the guarantee carries its own telemetry -------------- //
  const criticalPool = useMemo(
    () => leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85).reduce((s, l) => s + (l.leakageUsd ?? 0), 0),
    [leads],
  );
  const briefsExported = useMemo(() => leads.filter((l) => l.highTouch != null).length, [leads]);

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto cc-scroll p-6">
      {/* Guarantee anchor — the entry offer, always one glance away */}
      <SoftCard className="ink flex flex-wrap items-center gap-x-8 gap-y-3 px-7 py-5" interactive onClick={onGoPortal}>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[9.5px] font-medium uppercase tracking-[0.22em] text-white/65">
            Entry anchor // Diagnostic audit — $3,500 deposit
          </p>
          <p className="mt-1.5 font-display text-[19px] font-medium leading-snug tracking-[-0.02em] text-white">
            Backed by a <span className="text-white underline decoration-white/50 underline-offset-4">$10,000 Margin Leakage Recovery Guarantee</span> — or we
            keep working the recovery free.
          </p>
        </div>
        <div className="flex items-center">
          <AnchorStat first label="Recoverable pool" value={money(criticalPool)} note="QLV ≥ 85 band" />
          <AnchorStat label="Briefs exported" value={String(briefsExported).padStart(2, "0")} note="channel b" />
          <AnchorStat
            label="Rep touches 24h"
            value={String(ops.dispatchesSent24h)}
            note={`outbox ${ops.outboxPending} pending`}
          />
        </div>
        <div className="flex items-center gap-3">
          <HudMeta node="AST-01" hash="b3f7" tone="graphite" />
          <ArrowButton dark={false} label="Open Margin Defense Portal" />
        </div>
      </SoftCard>

      {/* Persona lens — sits directly under the entry anchor; the switch recomposes the strip below */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div
            className="flex items-center gap-1 rounded-full border border-white/[0.10] bg-[#131513] p-1"
            role="tablist"
            aria-label="Persona view"
          >
            {PERSONAS.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={persona === p.id}
                onClick={() => onPersona(p.id)}
                className={`tactile-btn h-7 rounded-full px-3.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.1em] transition-all ${
                  persona === p.id
                    ? "bg-[#F4F5F2] text-[#0B0C0B]"
                    : "text-[#8E9194] hover:text-[#F4F5F2]"
                }`}
              >
                {p.code}
              </button>
            ))}
          </div>
          <span className="hidden truncate font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#5F6460] md:inline-block">
            viewing as · {personaDef(persona).title}
          </span>
        </div>
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
      </div>

      <div className="grid flex-1 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Live feed */}
        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <LiveDot level={stale ? "fail" : "live"} />
              <SectionLabel>
                {stale
                  ? !connected
                    ? `Link down — reconnecting · last signal ${lastSignalAgo}`
                    : `Signal stale — last signal ${lastSignalAgo}`
                  : "Live telemetry — Module 8 · distributor quote portals"}
              </SectionLabel>
            </div>
            <HudMeta node="AST-04" hash="8f3a" />
          </div>

          {feed.length === 0 ? (
            <EmptyHint>{connected ? "Waiting for the first signal…" : "Establishing uplink — no signals yet"}</EmptyHint>
          ) : (
            <div
              className={`flex flex-col gap-2.5 transition-opacity duration-500 ${stale ? "opacity-40" : "opacity-100"}`}
              aria-disabled={stale}
            >
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
              className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
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

function AnchorStat({
  label,
  value,
  note,
  first = false,
}: {
  label: string;
  value: string;
  note?: string;
  first?: boolean;
}) {
  return (
    <div className={`${first ? "" : "border-l border-white/25 pl-6"} shrink-0 pr-6`}>
      <p className="font-mono text-[8.5px] font-medium uppercase tracking-[0.18em] text-white/60">{label}</p>
      <p className="mt-1.5 font-display text-[19px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-white">{value}</p>
      {note && <p className="mt-1.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-white/45">{note}</p>}
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
      className={`cc-rise px-5 py-3.5 ${fresh ? "border-white/[0.22]" : ""} ${hot ? "border-white/[0.30]" : ""}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <ScoreBlock score={item.qlvScore} band={null} size="sm" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className={`truncate text-[14px] font-medium ${hot ? "text-white" : "text-[#E9EBE7]"}`}>{item.prospectName}</p>
              <Chip tone={hot ? "inverted" : "default"}>{item.eventType.replace(/_/g, " ")}</Chip>
              {item.alertFired && <Chip tone="well">alert dispatched</Chip>}
            </div>
            <p className="mt-1 truncate text-[12.5px] text-[#8E9194]">
              {EVENT_VERBS[item.eventType] ?? item.eventType} · {item.city ?? "—"}, {item.country ?? "—"}
              {item.device ? ` · ${item.device}` : ""}
              {item.durationMs ? ` · ${Math.round(item.durationMs / 1000)}s` : ""}
            </p>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[#6E736E]">{relTime(item.occurredAtMs, now)}</span>
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
    <SoftCard interactive onClick={onClick} className={`px-4 py-3 ${lead.highIntentNow ? "border-white/[0.26]" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-[#5F6460]">{String(rank).padStart(2, "0")}</span>
        <ScoreBlock score={lead.score?.qlvScore ?? null} band={null} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={`truncate text-[13px] font-medium ${lead.highIntentNow ? "text-white" : "text-[#E9EBE7]"}`}>{lead.name}</p>
            {lead.highIntentNow && <LiveDot level="live" />}
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-[#8E9194]">{trigger}</p>
        </div>
      </div>
    </SoftCard>
  );
}
