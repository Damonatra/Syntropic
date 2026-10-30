/**
 * OPS — The Watchtower. Machine health that watches back.
 *
 * The old tab described the machine: fake HUD bars jittered by Math.random,
 * a hardcoded module board. This tab watches it. Three layers, one question
 * answered above the fold — "what needs me?":
 *
 *   vitals strip  measured heartbeats — bridge, snapshot build, KPI baseline
 *                 capture, outbox, external engines. Quiet when beating.
 *   alert deck    every unacknowledged watch, ranked crit → warn → info, then
 *                 by time-to-impact. Each row states the problem in plain
 *                 words, the next action, the evidence line (the math), and
 *                 the predicted breach ETA. j/k cursor · a ack · enter opens
 *                 the subject drawer · esc closes.
 *   engine view   the document turnaround pipeline measured: per-stage count,
 *                 dwell, at-risk dollars — the promise (deliverable within 5
 *                 days of payment) priced out stage by stage.
 *
 * Silence is the product: an empty deck renders one deliberate sentence, not
 * confetti. Every number traces to a real row — the watchtower never fires
 * an alarm it cannot show the math for.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Chip, ErpBadge, LiveDot, PillButton, SectionLabel, SoftCard } from "./bits";
import { SendingDomainsPanel } from "./SendingDomainsPanel";
import type { CommandSnapshot, OpsWatchAlert, WatchSeverity } from "@/lib/vertebra/command";
import { nextActionFor, STAGE_LABELS, type EngagementStage } from "@/lib/vertebra/portal";
import { humanDuration } from "@/lib/vertebra/watches";

interface TickResult {
  ok: boolean;
  due: number;
  sent: number;
  stopped: number;
  deferred: number;
  failed: number;
  provider: string;
  details: Array<{ prospect: string; outcome: string; note?: string }>;
}

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

const SEVERITY_ORDER: WatchSeverity[] = ["crit", "warn", "info"];

function SeverityChip({ severity }: { severity: WatchSeverity }) {
  if (severity === "crit") {
    return <span className="shrink-0 rounded-lg bg-[#F4F5F2] px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[#0B0C0B]">crit</span>;
  }
  if (severity === "warn") {
    return <span className="shrink-0 rounded-lg border border-white/30 px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[#F4F5F2]">warn</span>;
  }
  return <span className="shrink-0 rounded-lg border border-white/[0.09] px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[#6E736E]">info</span>;
}

export function OpsView({
  snap,
  connected,
  refresh,
}: {
  snap: CommandSnapshot;
  connected: boolean;
  refresh: () => Promise<void>;
}) {
  const nowMs = snap.generatedAtMs || Date.now();
  const vitals = snap.ops.vitals ?? [];
  const deck = snap.ops.deck ?? [];
  const engine = snap.ops.engine ?? null;
  const pulses = snap.ops.enginePulses ?? [];
  const watchHealth = snap.ops.watchHealth ?? [];
  const briefing = snap.ops.briefing ?? null;

  const [cursor, setCursor] = useState(0);
  const [drawerFor, setDrawerFor] = useState<OpsWatchAlert | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ackFlash, setAckFlash] = useState<string | null>(null);

  // Keep the cursor honest as the deck refires and shrinks.
  useEffect(() => {
    if (cursor >= deck.length) setCursor(deck.length ? deck.length - 1 : 0);
  }, [deck.length, cursor]);

  const ack = useCallback(
    async (a: OpsWatchAlert, reason: "real" | "false_positive" | "handled" = "real") => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/ops/ack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: a.key, reason }),
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
          setError(detail.hint ?? detail.error ?? `ack_${res.status}`);
          return false;
        }
        setAckFlash(`${a.watchId} · ${reason.replace("_", " ")}`);
        await refresh();
        return true;
      } catch {
        setError("network_error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // ---- keyboard — j/k cursor · a ack · enter drawer · esc close ----------- //
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        if (drawerFor) {
          e.preventDefault();
          setDrawerFor(null);
        }
        return;
      }
      if (deck.length === 0) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(deck.length - 1, c + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "a") {
        const a = deck[cursor];
        if (a) void ack(a, "real");
      } else if (e.key === "f") {
        const a = deck[cursor];
        if (a) void ack(a, "false_positive");
      } else if (e.key === "h") {
        const a = deck[cursor];
        if (a) void ack(a, "handled");
      } else if (e.key === "Enter") {
        const a = deck[cursor];
        if (a) {
          e.preventDefault();
          setDrawerFor(a);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, cursor, ack, drawerFor]);

  // ---- vitals — the bridge beat is client-side, the rest are server-measured //
  const allVitals = useMemo(
    () => [
      {
        id: "bridge",
        label: "socket bridge",
        value: connected ? "LIVE" : "DOWN",
        beat: connected,
        ageMs: null as number | null,
        detail: ":3003 telemetry fan-out · connection held from this console",
      },
      ...vitals,
    ],
    [connected, vitals],
  );

  const counts = useMemo(() => {
    const crit = deck.filter((a) => a.severity === "crit").length;
    const warn = deck.filter((a) => a.severity === "warn").length;
    const info = deck.filter((a) => a.severity === "info").length;
    const roots = deck.filter((a) => !a.causedBy).length;
    return { crit, warn, info, roots, explained: deck.length - roots };
  }, [deck]);

  // ---- sequence engine (real — kept from the old tab) --------------------- //
  const [tick, setTick] = useState<TickResult | null>(null);
  const [ticking, setTicking] = useState(false);
  const [tickError, setTickError] = useState<string | null>(null);
  const runTick = async () => {
    setTicking(true);
    setTickError(null);
    try {
      const res = await fetch("/api/ops/tick", { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = (await res.json()) as TickResult & { error?: string };
      if (!res.ok || data.error) setTickError(data.error ?? `server_${res.status}`);
      else setTick(data);
    } catch {
      setTickError("network_error");
    }
    setTicking(false);
  };

  const erpCounts = snap.leads.reduce<Record<string, number>>((acc, l) => {
    const erp = l.erp?.detected_erp;
    if (erp) acc[erp] = (acc[erp] ?? 0) + 1;
    return acc;
  }, {});
  const erpRows = Object.entries(erpCounts).sort((a, b) => b[1] - a[1]);

  // The drawer's subject — engagement drawers read the live snapshot trail.
  const drawerEngagement =
    drawerFor?.subjectKind === "engagement" && drawerFor.subjectId
      ? (snap.engagements ?? []).find((e) => e.id === drawerFor.subjectId) ?? null
      : null;

  return (
    <div className="relative flex h-full flex-col overflow-y-auto cc-scroll p-6">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Ops — the watchtower</SectionLabel>
          <p className="mt-2 flex items-center gap-2.5 font-display text-[22px] font-semibold tracking-[-0.03em] text-[#F4F5F2]">
            <LiveDot level={counts.crit > 0 ? "fail" : counts.warn > 0 ? "warn" : "live"} />
            {deck.length === 0
              ? "All watches quiet"
              : `${counts.roots} incident${counts.roots > 1 ? "s" : ""} live${counts.explained ? ` · ${counts.explained} explained` : ""} — ${counts.crit} crit · ${counts.warn} warn${counts.info ? ` · ${counts.info} info` : ""}`}
          </p>
          <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#5F6460]">
            one incident, not twelve rows · every alarm carries its math
          </p>
        </div>
      </div>

      {/* the morning brief — one glance answers "what changed" */}
      {briefing && (
        <p className="mt-3 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#5F6460]">
          24h brief — {briefing.fired24h} watch{briefing.fired24h === 1 ? "" : "es"} fired · {briefing.acked24h} acked ·{" "}
          {briefing.liveNow} live now
          {briefing.nextBreachMs != null ? ` · next breach in ${humanDuration(briefing.nextBreachMs)}` : ""} ·{" "}
          <span className="text-[#C9CCC7]">{usd(briefing.atRiskDollars)}</span> at risk
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-white/20 bg-[#141614] px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#FF8A7A]">
          {error}
        </p>
      )}

      {/* vitals strip — measured heartbeats */}
      <SoftCard className="mt-5 flex flex-wrap items-stretch gap-x-7 gap-y-3 px-6 py-4">
        {allVitals.map((v) => (
          <div key={v.id} className="flex min-w-0 flex-1 items-center gap-2.5" title={v.detail}>
            <LiveDot level={v.beat ? "live" : "fail"} />
            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#6E736E]">{v.label}</p>
              <p className="truncate font-mono text-[11.5px] tabular-nums text-[#F4F5F2]">{v.value}</p>
            </div>
          </div>
        ))}
      </SoftCard>

      {/* the alert deck */}
      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Alert deck</SectionLabel>
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
            ranked crit → warn → info, then time-to-impact · echoes explained under their root · j / k · a ack real · f false positive · h handled · enter opens
          </p>
        </div>

        {deck.length === 0 ? (
          <SoftCard className="mt-3 flex flex-col items-center justify-center px-8 py-10 text-center">
            <LiveDot level="live" />
            <p className="mt-3 font-display text-[16px] font-semibold text-[#F4F5F2]">All watches quiet</p>
            <p className="mt-1.5 max-w-[420px] font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-[#5F6460]">
              the sentinels re-sweep on every snapshot build — the deck rings the moment something drifts,
              with its math attached
            </p>
          </SoftCard>
        ) : (
          <div className="mt-3 flex flex-col">
            {deck.map((a, i) => {
              const isCursor = i === cursor;
              return (
                <div
                  key={a.key}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isCursor}
                  onClick={() => setCursor(i)}
                  onDoubleClick={() => setDrawerFor(a)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      setCursor(i);
                      setDrawerFor(a);
                    }
                  }}
                  className={`mb-2 cursor-pointer rounded-xl px-5 py-4 transition-all ${
                    a.causedBy ? "ml-6 " : ""
                  }${isCursor ? "ink" : "neu cc-row"}`}
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <SeverityChip severity={a.severity} />
                    <p
                      className={`min-w-0 flex-1 font-display text-[15px] font-semibold tracking-[-0.02em] ${
                        isCursor ? "text-white" : "text-[#F4F5F2]"
                      }`}
                    >
                      {a.title}
                    </p>
                    {a.etaMs != null && (
                      <p className={`font-mono text-[10px] tabular-nums tracking-[0.1em] ${isCursor ? "text-white/85" : "text-[#8E9194]"}`}>
                        eta {a.etaMs === 0 ? "now" : humanDuration(a.etaMs)}
                      </p>
                    )}
                  </div>
                  {a.causedBy && (
                    <p className={`mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] ${isCursor ? "text-white/75" : "text-[#8E9194]"}`}>
                      ↳ {a.causedBy.reason}
                    </p>
                  )}
                  {a.escalated && (
                    <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#FF8A7A]">
                      unacked {humanDuration(a.escalated.unackedMs)} — escalated
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                    <p className={`font-mono text-[10px] uppercase tracking-[0.1em] ${isCursor ? "text-white/80" : "text-[#8E9194]"}`}>
                      ▸ {a.action}
                    </p>
                    <p className="font-mono text-[8.5px] uppercase tracking-[0.12em] text-[#5F6460]">
                      {a.watch} · {a.subjectLabel}
                      {a.fires24h != null && a.fires24h > 1 ? ` · fired ${a.fires24h}× / 24h` : ""}
                    </p>
                  </div>
                  {a.evidence && (
                    <p className={`mt-1.5 font-mono text-[9.5px] leading-relaxed tracking-[0.04em] ${isCursor ? "text-white/60" : "text-[#4B514D]"}`}>
                      math ▸ {a.evidence}
                    </p>
                  )}
                </div>
              );
            })}
            {ackFlash && (
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
                acked {ackFlash} — suppressed for this window · a refire returns fresh
              </p>
            )}
          </div>
        )}
      </div>

      {/* watch self-audit — the tuning loop's read-out */}
      {watchHealth && watchHealth.length > 0 && (
        <SoftCard className="mt-5 px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Watch self-audit — ack accuracy, 7d</SectionLabel>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
              watches with ≥3 ack verdicts · tuning data, not opinion
            </p>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-7 gap-y-2.5">
            {watchHealth.map((w) => (
              <div key={w.watchId}>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#6E736E]">{w.watchId}</p>
                <p className="font-mono text-[11.5px] tabular-nums text-[#F4F5F2]">
                  {w.realSharePct != null ? `${w.realSharePct}% real` : "no verdicts"}
                  <span className="text-[#5F6460]">
                    {" "}· {w.acked7d} acked · {w.falsePositive7d} fp
                  </span>
                </p>
              </div>
            ))}
          </div>
        </SoftCard>
      )}

      {/* engine view — the document turnaround pipeline, measured */}
      {engine && (
        <SoftCard className="mt-5 px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Engine — document turnaround</SectionLabel>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5F6460]">
              promise: deliverable within 5d of payment · verdict within 3d
            </p>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr className="border-b border-white/[0.08]">
                  {["stage", "in stage", "median dwell", "p90 dwell", "oldest", "at risk", "at-risk $"].map((h) => (
                    <th key={h} className="px-2 py-2 text-left font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-[#6E736E]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {engine.stages.map((s) => (
                  <tr key={s.stage} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-2 py-2.5">
                      <span className="flex items-center gap-2">
                        <span className={`inline-block size-1.5 rounded-full ${s.atRisk > 0 ? "bg-[#F4F5F2]" : "bg-[#3C413C]"}`} />
                        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#C9CCC7]">{s.label}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 font-display text-[15px] font-semibold tabular-nums text-[#F4F5F2]">{s.count}</td>
                    <td className="px-2 py-2.5 font-mono text-[11px] tabular-nums text-[#8E9194]">
                      {s.medianDwellMs != null ? humanDuration(s.medianDwellMs) : "—"}
                    </td>
                    <td className="px-2 py-2.5 font-mono text-[11px] tabular-nums text-[#8E9194]">
                      {s.p90DwellMs != null ? humanDuration(s.p90DwellMs) : "—"}
                    </td>
                    <td className="px-2 py-2.5 font-mono text-[11px] tabular-nums text-[#8E9194]">
                      {s.maxDwellMs != null ? humanDuration(s.maxDwellMs) : "—"}
                    </td>
                    <td className="px-2 py-2.5 font-mono text-[11px] tabular-nums text-[#C9CCC7]">{s.atRisk || "—"}</td>
                    <td className="px-2 py-2.5 font-mono text-[11px] tabular-nums text-[#C9CCC7]">{s.atRiskDollars ? usd(s.atRiskDollars) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t border-white/[0.06] pt-3 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#6E736E]">
            <span>delivered 24h <span className="text-[#F4F5F2]">{engine.delivered24h}</span></span>
            <span>docs sealed 24h <span className="text-[#F4F5F2]">{engine.docs24h}</span></span>
            <span>parse full <span className="text-[#F4F5F2]">{engine.parseFull}</span> · partial <span className="text-[#F4F5F2]">{engine.parsePartial}</span></span>
            <span>active book <span className="text-[#F4F5F2]">{usd(engine.activeDollars)}</span></span>
            <span>guarantee exposure <span className="text-[#F4F5F2]">{usd(engine.guaranteeExposureDollars)}</span></span>
          </div>
          {/* Little's Law drain — the queue measured against its own outflow */}
          <div className="mt-3 border-t border-white/[0.06] pt-3">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#6E736E]">drain forecast — little's law on the real trail (7d)</p>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5">
              {engine.drain.map((d) => (
                <span key={d.stage} className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#6E736E]">
                  {d.label} <span className="text-[#C9CCC7]">{d.depth} queued</span>{" · "}
                  {d.drainPerHour != null
                    ? `${Math.round(d.drainPerHour * 100) / 100}/h · clears ${d.timeToDrainMs != null ? humanDuration(d.timeToDrainMs) : "—"}`
                    : "no drain data yet"}
                </span>
              ))}
            </div>
          </div>
          {pulses.length > 0 && (
            <div className="mt-3 border-t border-white/[0.06] pt-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#6E736E]">external engine pulses</p>
              <div className="mt-2 flex flex-col">
                {pulses.slice(0, 5).map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                    <LiveDot level={p.status === "ok" ? "live" : p.status === "warn" ? "warn" : "fail"} />
                    <p className="font-mono text-[10.5px] text-[#C9CCC7]">{p.engineId} · {p.watchId}</p>
                    <p className="truncate font-mono text-[9.5px] text-[#5F6460]">{p.detail ?? ""}</p>
                    <p className="ml-auto font-mono text-[9px] tabular-nums uppercase tracking-[0.1em] text-[#5F6460]">
                      {humanDuration(Math.max(0, nowMs - p.atMs))} ago
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SoftCard>
      )}

      {/* sequence engine — the real send loop */}
      <SoftCard className="mt-5 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <SectionLabel>Sequence engine — channel A loop</SectionLabel>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8E9194]">
              Claims due dispatches, honors the suppression ledger, sends through the configured provider, backs off honestly when none is set.
            </p>
          </div>
          <PillButton tone="dark" onClick={() => void runTick()} disabled={ticking}>
            {ticking ? "Ticking…" : "Run tick"}
          </PillButton>
        </div>
        {tickError && (
          <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#FF8A7A]">tick failed: {tickError}</p>
        )}
        {tick && (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/[0.08] pt-3">
            {(
              [
                ["due", tick.due],
                ["sent", tick.sent],
                ["stopped", tick.stopped],
                ["deferred", tick.deferred],
                ["failed", tick.failed],
                ["provider", tick.provider],
              ] as Array<[string, string | number]>
            ).map(([k, v]) => (
              <div key={k}>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#6E736E]">{k}</p>
                <p className="font-mono text-[13px] tabular-nums text-[#F4F5F2]">{String(v)}</p>
              </div>
            ))}
            {tick.details.slice(0, 4).map((d, i) => (
              <Chip key={i} tone="outline">
                {d.prospect} · {d.outcome}
                {d.note ? ` · ${d.note}` : ""}
              </Chip>
            ))}
          </div>
        )}
      </SoftCard>

      {/* sending domains — the egress ledger the mailer gate enforces */}
      <SendingDomainsPanel />

      {/* ERP coverage */}
      <SoftCard className="mt-5 px-6 py-5">
        <SectionLabel className="mb-3">ERP stack coverage — distributor book</SectionLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          {erpRows.map(([erp, count]) => (
            <span key={erp} className="inline-flex items-center gap-2">
              <ErpBadge erp={erp} />
              <span className="font-mono text-[10.5px] tabular-nums text-[#8E9194]">×{count}</span>
            </span>
          ))}
          {erpRows.length === 0 && <Chip tone="outline">no erp profiles yet</Chip>}
        </div>
      </SoftCard>

      {/* the subject drawer — enter opens the thing the alarm names */}
      {drawerFor && (
        <div className="fixed bottom-4 right-4 top-16 z-20 w-[400px] max-w-[calc(100vw-2rem)]">
          <div className="neu-lg flex h-full flex-col overflow-y-auto cc-scroll rounded-xl p-6 shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-3">
              <SeverityChip severity={drawerFor.severity} />
              <button
                onClick={() => setDrawerFor(null)}
                className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#8E9194] transition-colors hover:text-[#F4F5F2]"
              >
                close · esc
              </button>
            </div>
            <p className="mt-3 font-mono text-[9px] uppercase tracking-[0.18em] text-[#5F6460]">
              {drawerFor.watch} · {drawerFor.subjectLabel}
            </p>
            <h3 className="mt-1.5 font-display text-[17px] font-semibold leading-snug tracking-[-0.02em] text-[#F4F5F2]">
              {drawerFor.title}
            </h3>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#8E9194]">▸ {drawerFor.action}</p>
            {drawerFor.causedBy && (
              <p className="mt-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#8E9194]">
                ↳ {drawerFor.causedBy.reason}
              </p>
            )}
            {drawerFor.escalated && (
              <p className="mt-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#FF8A7A]">
                unacked {humanDuration(drawerFor.escalated.unackedMs)} — escalated
              </p>
            )}
            {drawerFor.evidence && (
              <p className="mt-2 rounded-lg border border-white/[0.08] bg-[#0E100E] px-3.5 py-2.5 font-mono text-[10px] leading-relaxed tracking-[0.04em] text-[#8E9194]">
                math ▸ {drawerFor.evidence}
              </p>
            )}

            {drawerEngagement && (
              <div className="mt-4 border-t border-white/[0.07] pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-display text-[15px] font-semibold text-[#F4F5F2]">{drawerEngagement.clientName}</p>
                  <Chip tone="raised">{STAGE_LABELS[drawerEngagement.status as EngagementStage] ?? drawerEngagement.status}</Chip>
                  <p className="ml-auto font-display text-[15px] font-semibold tabular-nums text-[#F4F5F2]">
                    {usd(drawerEngagement.amountUsd)}
                  </p>
                </div>
                <p className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#6E736E]">
                  {drawerEngagement.ref} · paid {humanDuration(Math.max(0, nowMs - drawerEngagement.paidAtMs))} ago · next ▸ {nextActionFor(drawerEngagement).action}
                </p>
                <div className="mt-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#6E736E]">ledger trail</p>
                  <div className="mt-1.5 flex flex-col">
                    {drawerEngagement.events.slice(0, 5).map((ev) => (
                      <div key={ev.id} className="flex items-baseline justify-between gap-3 border-b border-white/[0.05] py-1.5 last:border-0">
                        <p className="min-w-0 truncate font-mono text-[10.5px] text-[#C9CCC7]">{ev.detail ?? ev.kind}</p>
                        <p className="shrink-0 font-mono text-[8.5px] uppercase tabular-nums text-[#5F6460]">
                          {humanDuration(Math.max(0, nowMs - ev.createdAtMs))} ago
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => {
                    void ack(drawerFor, "real");
                    setDrawerFor(null);
                  }}
                  disabled={busy}
                  className="tactile-btn mt-4 w-full bg-[#0B0C0B] px-4 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-white ring-1 ring-white/25 hover:ring-white/50 disabled:opacity-40"
                >
                  Acknowledge — real · quiet for this window (a)
                </button>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => {
                      void ack(drawerFor, "false_positive");
                      setDrawerFor(null);
                    }}
                    disabled={busy}
                    className="tactile-btn cc-ghost flex-1 bg-transparent px-4 py-2 font-mono text-[9.5px] uppercase tracking-[0.14em] disabled:opacity-40"
                  >
                    False positive (f)
                  </button>
                  <button
                    onClick={() => {
                      void ack(drawerFor, "handled");
                      setDrawerFor(null);
                    }}
                    disabled={busy}
                    className="tactile-btn cc-ghost flex-1 bg-transparent px-4 py-2 font-mono text-[9.5px] uppercase tracking-[0.14em] disabled:opacity-40"
                  >
                    Handled (h)
                  </button>
                </div>
              </div>
            )}
            {drawerFor.subjectKind !== "engagement" && (
              <>
                <button
                  onClick={() => {
                    void ack(drawerFor, "real");
                    setDrawerFor(null);
                  }}
                  disabled={busy}
                  className="tactile-btn mt-4 w-full bg-[#0B0C0B] px-4 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-white ring-1 ring-white/25 hover:ring-white/50 disabled:opacity-40"
                >
                  Acknowledge — real · quiet for this window (a)
                </button>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => {
                      void ack(drawerFor, "false_positive");
                      setDrawerFor(null);
                    }}
                    disabled={busy}
                    className="tactile-btn cc-ghost flex-1 bg-transparent px-4 py-2 font-mono text-[9.5px] uppercase tracking-[0.14em] disabled:opacity-40"
                  >
                    False positive (f)
                  </button>
                  <button
                    onClick={() => {
                      void ack(drawerFor, "handled");
                      setDrawerFor(null);
                    }}
                    disabled={busy}
                    className="tactile-btn cc-ghost flex-1 bg-transparent px-4 py-2 font-mono text-[9.5px] uppercase tracking-[0.14em] disabled:opacity-40"
                  >
                    Handled (h)
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* the engine contract — how the document turnaround engine reports in */}
      <SoftCard className="mt-5 px-6 py-5">
        <SectionLabel className="mb-3">Engine contract — signed heartbeat ingress</SectionLabel>
        <pre className="ink overflow-x-auto rounded-lg p-4 font-mono text-[11.5px] leading-relaxed text-white/90">{`POST /api/ops/heartbeat
x-vertebra-signature: HMAC-SHA256(rawBody, OPS_HEARTBEAT_SECRET)
{
  "engineId": "turnaround-core",     // stable engine name
  "pulseRef": "run-2026-10-30-014",  // idempotent — retries are free
  "watchId": "parse_queue",          // which watch this pulse reports
  "status": "ok",                    // ok | warn | fail
  "detail": "queue drained · 12 docs parsed",
  "expectEveryMs": 300000            // silence past max(3x, 10min) rings the deck
}
→ 200 { ok, deduped? }   // engines report in; the watchtower never dials out`}</pre>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip tone="outline">zero egress · one door in</Chip>
          <Chip tone="outline">deck: fail pulses ring crit · silence rings crit</Chip>
          <Chip tone="outline">native watches: SLA clocks · trend sentinels</Chip>
        </div>
      </SoftCard>
    </div>
  );
}
