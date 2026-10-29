/** RADAR — home surface: guarantee anchor with live receipt, persona KPI strip, alert backlog, watchdog-gated feed with hold-buffer + filters, actionable strike rail. */
"use client";

import { useMemo, useState, type MouseEvent } from "react";
import {
  ArrowButton,
  Chip,
  EmptyHint,
  HudMeta,
  KpiCard,
  LiveDot,
  PriorityBar,
  ScoreBlock,
  SectionLabel,
  SoftCard,
} from "./bits";
import {
  EVENT_VERBS,
  heatLevel,
  isHighSignal,
  money,
  relTime,
  type AlertItem,
  type CommandLead,
  type CommandSnapshot,
  type FeedItem,
} from "@/lib/vertebra/command";

import { PERSONAS, personaDef, personaMetrics, type PersonaId } from "@/lib/vertebra/persona";

/** The bridge posts every 9–18s — two minutes of silence means the pipe is dead, and the radar must say so. */
const STALE_MS = 120_000;

const VERT_FILTERS = [
  { id: "all", label: "All" },
  { id: "pvf", label: "PVF" },
  { id: "electrical", label: "Elec" },
  { id: "hvac", label: "HVAC" },
  { id: "fluid_power", label: "Fluid" },
] as const;
type VertFilter = (typeof VERT_FILTERS)[number]["id"];

export function RadarView({
  snap,
  now,
  freshEventIds,
  connected,
  persona,
  onPersona,
  onOpenDossier,
  onQuickAction,
  onAckAlerts,
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
  onQuickAction: (lead: CommandLead, action: "call" | "defer" | "snooze") => void;
  onAckAlerts: (alertIds: string[]) => void;
  onGoStrike: () => void;
  onGoPipeline: () => void;
  onGoPortal: () => void;
}) {
  const { leads, feed, alerts, ops } = snap;

  const metrics = useMemo(() => personaMetrics(persona, snap), [persona, snap]);

  // 30s bucket for the 12h recency window — re-ranks the rail on a clock the
  // operator can feel instead of re-sorting every second.
  const nowBucket = Math.round(now / 30_000);
  const strikeQueue = useMemo(() => {
    const cutoff = nowBucket * 30_000 - 43_200_000;
    return leads
      .filter((l) => l.score != null && (l.telemetry.lastHighSignalAtMs == null || l.telemetry.lastHighSignalAtMs > cutoff))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 8);
  }, [leads, nowBucket]);
  const maxPriority = strikeQueue[0]?.priority ?? 100;

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

  // ---- alert backlog — the persistent home toasts burn away --------------- //
  const [localAcked, setLocalAcked] = useState<Set<string>>(new Set());
  const unacked = useMemo(
    () => alerts.filter((a) => a.acknowledgedAtMs == null && !localAcked.has(a.id)),
    [alerts, localAcked],
  );
  const leadById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);
  const leakageById = useMemo(() => new Map(leads.map((l) => [l.id, l.leakageUsd ?? null])), [leads]);

  const ackAlert = (a: AlertItem) => {
    setLocalAcked((prev) => new Set(prev).add(a.id));
    onAckAlerts([a.id]);
  };

  // ---- feed filters + hold buffer ------------------------------------------ //
  // Hovering freezes the list so a burst of pushes can't shove the row the
  // operator is mid-read; arrivals accumulate into a +N pill until release.
  const [mode, setMode] = useState<"all" | "high">("all");
  const [vert, setVert] = useState<VertFilter>("all");
  const [frozen, setFrozen] = useState<FeedItem[] | null>(null);

  const visibleFeed = useMemo(
    () =>
      feed.filter((f) => (mode === "all" || isHighSignal(f.eventType)) && (vert === "all" || f.vertical === vert)),
    [feed, mode, vert],
  );
  const frozenIds = useMemo(() => (frozen ? new Set(frozen.map((f) => f.id)) : null), [frozen]);
  const heldCount = frozenIds ? visibleFeed.filter((f) => !frozenIds.has(f.id)).length : 0;
  const displayList = (frozen ?? visibleFeed).slice(0, 14);

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

      {/* Alert backlog — alerts that outlived their toast keep a visible home until acked */}
      {unacked.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-3">
            <LiveDot level="fail" />
            <SectionLabel>Alert backlog — {unacked.length} unacknowledged</SectionLabel>
          </div>
          {unacked.slice(0, 3).map((a) => {
            const lead = a.prospectId ? leadById.get(a.prospectId) : undefined;
            return (
              <SoftCard key={a.id} className="ink flex items-center gap-4 px-5 py-3">
                <span className="size-1.5 shrink-0 rounded-full bg-[#F4F5F2] cc-blink" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-white">{a.title}</p>
                  <p className="mt-1 truncate text-[12px] text-white/70">{a.body.split("\n")[0]}</p>
                </div>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-white/50">{relTime(a.createdAtMs, now)}</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {lead && (
                    <MiniBtn
                      label="Open"
                      onClick={() => onOpenDossier(lead)}
                    />
                  )}
                  <MiniBtn label="Ack" onClick={() => ackAlert(a)} />
                </div>
              </SoftCard>
            );
          })}
        </div>
      )}

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

          {/* mode + vertical filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex items-center gap-0.5 rounded-full border border-white/[0.10] bg-[#131513] p-0.5"
              role="tablist"
              aria-label="Feed mode"
            >
              {(["all", "high"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => {
                    setMode(m);
                    setFrozen(null);
                  }}
                  className={`tactile-btn h-6 rounded-full px-3 font-mono text-[9px] font-medium uppercase tracking-[0.12em] transition-all ${
                    mode === m ? "bg-[#F4F5F2] text-[#0B0C0B]" : "text-[#8E9194] hover:text-[#F4F5F2]"
                  }`}
                >
                  {m === "all" ? "All" : "High-signal"}
                </button>
              ))}
            </div>
            <span className="hidden h-4 w-px bg-white/[0.10] sm:inline-block" />
            <div className="flex items-center gap-0.5">
              {VERT_FILTERS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => {
                    setVert(v.id);
                    setFrozen(null);
                  }}
                  aria-pressed={vert === v.id}
                  className={`tactile-btn h-6 rounded-full px-2.5 font-mono text-[9px] font-medium uppercase tracking-[0.1em] transition-colors ${
                    vert === v.id ? "bg-[#222522] text-[#F4F5F2]" : "text-[#5F6460] hover:text-[#F4F5F2]"
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
              {displayList.length} shown
            </span>
          </div>

          {/* hold buffer pill — arrivals during a hold accumulate here */}
          {frozen != null && (
            <button
              onClick={() => setFrozen(null)}
              className="cc-rise mx-auto flex h-7 shrink-0 items-center gap-2 rounded-full border border-[#F4F5F2] bg-[#F4F5F2] px-3.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[#0B0C0B] transition-transform hover:scale-[1.02]"
            >
              <span className="size-1.5 rounded-full bg-[#0B0C0B] cc-pulse-dot" />
              {heldCount > 0 ? `+${heldCount} new while held — release` : "feed held — release"}
            </button>
          )}

          {feed.length === 0 ? (
            <EmptyHint>{connected ? "Waiting for the first signal…" : "Establishing uplink — no signals yet"}</EmptyHint>
          ) : displayList.length === 0 ? (
            <EmptyHint>
              {mode === "high" ? "No high-signal events in the current window" : "No events for this vertical yet"}
            </EmptyHint>
          ) : (
            <div
              className={`flex flex-col gap-2.5 transition-opacity duration-500 ${stale ? "opacity-40" : "opacity-100"}`}
              aria-disabled={stale}
              onMouseEnter={() => setFrozen((cur) => (cur == null ? visibleFeed : cur))}
              onMouseLeave={() => setFrozen(null)}
            >
              {displayList.map((item) => (
                <FeedCard
                  key={item.id}
                  item={item}
                  now={now}
                  fresh={freshEventIds.has(item.id)}
                  leakage={item.prospectId ? leakageById.get(item.prospectId) ?? null : null}
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
              <RailCard
                key={lead.id}
                lead={lead}
                rank={idx + 1}
                now={now}
                maxPriority={maxPriority}
                onClick={() => onOpenDossier(lead)}
                onQuickAction={onQuickAction}
              />
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
  leakage,
  onClick,
}: {
  item: FeedItem;
  now: number;
  fresh: boolean;
  leakage: number | null;
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
        <div className="flex shrink-0 flex-col items-end gap-1">
          {leakage != null && (
            <span className="font-mono text-[10px] font-medium tabular-nums text-[#8E9194]">{money(leakage)} leak</span>
          )}
          <span className="font-mono text-[10.5px] tabular-nums text-[#6E736E]">{relTime(item.occurredAtMs, now)}</span>
        </div>
      </div>
    </SoftCard>
  );
}

function RailCard({
  lead,
  rank,
  now,
  maxPriority,
  onClick,
  onQuickAction,
}: {
  lead: CommandLead;
  rank: number;
  now: number;
  maxPriority: number;
  onClick: () => void;
  onQuickAction: (lead: CommandLead, action: "call" | "defer" | "snooze") => void;
}) {
  const trigger =
    lead.telemetry.lastEventType != null && lead.telemetry.lastEventAtMs != null
      ? `${EVENT_VERBS[lead.telemetry.lastEventType] ?? lead.telemetry.lastEventType} ${relTime(lead.telemetry.lastEventAtMs, now)}`
      : "No telemetry yet";
  return (
    <SoftCard
      interactive
      onClick={onClick}
      className={`group px-4 py-3 ${lead.highIntentNow ? "border-white/[0.26]" : ""}`}
    >
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
        {lead.leakageUsd != null && (
          <span className="shrink-0 font-mono text-[10px] font-medium tabular-nums text-[#8E9194]">{money(lead.leakageUsd)}</span>
        )}
      </div>
      <div className="mt-2.5">
        <PriorityBar value={lead.priority} max={maxPriority} heat={heatLevel(lead.score?.qlvScore ?? null)} />
      </div>
      <div className="mt-2 flex items-center gap-1.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        {lead.contact?.phone && (
          <QuickBtn label="c · call" onClick={(e) => { e.stopPropagation(); onQuickAction(lead, "call"); }} />
        )}
        <QuickBtn label="x · defer" onClick={(e) => { e.stopPropagation(); onQuickAction(lead, "defer"); }} />
        <QuickBtn label="s · snooze" onClick={(e) => { e.stopPropagation(); onQuickAction(lead, "snooze"); }} />
        <span className="ml-auto font-mono text-[8.5px] uppercase tracking-[0.14em] text-[#3F433F]">
          prio {Math.round(lead.priority)}
        </span>
      </div>
    </SoftCard>
  );
}

function QuickBtn({ label, onClick }: { label: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      onClick={onClick}
      onKeyDown={(e) => e.stopPropagation()}
      className="tactile-btn h-6 rounded-full border border-white/[0.12] bg-[#1A1D1A] px-2.5 font-mono text-[9px] font-medium uppercase tracking-[0.1em] text-[#8E9194] transition-colors hover:border-white/25 hover:text-[#F4F5F2]"
    >
      {label}
    </button>
  );
}

function MiniBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="tactile-btn h-6 rounded-full border border-white/25 bg-transparent px-2.5 font-mono text-[9px] font-medium uppercase tracking-[0.1em] text-white/80 transition-colors hover:bg-white/10 hover:text-white"
    >
      {label}
    </button>
  );
}
