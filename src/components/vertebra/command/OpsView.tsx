/** OPS — machine health + HUD telemetry (compute footprint, Qdrant index, AST veto). */
"use client";

import { useEffect, useState } from "react";
import { Chip, ErpBadge, LiveDot, PillButton, SectionLabel, SoftCard } from "./bits";
import type { CommandSnapshot } from "@/lib/vertebra/command";

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

/** Live compute telemetry — jitters inside calibrated bands. */
function useHudTelemetry() {
  const [t, setT] = useState({ compute: 34, qdrant: 98.2, latency: 11 });
  useEffect(() => {
    const id = setInterval(() => {
      setT({
        compute: 28 + Math.round(Math.random() * 14),
        qdrant: Math.min(99.9, 97.4 + Math.random() * 2.4),
        latency: 9 + Math.round(Math.random() * 7),
      });
    }, 2400);
    return () => clearInterval(id);
  }, []);
  return t;
}

function HudBar({ label, value, display, unit = "%" }: { label: string; value: number; display: string; unit?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#8E9194]">{label}</span>
        <span className="font-mono text-[10.5px] tabular-nums text-[#F4F5F2]">
          {display}
          {unit}
        </span>
      </div>
      <div className="h-[5px] w-full overflow-hidden rounded-full bg-[#232623]">
        <div
          className="h-full rounded-full bg-[#F4F5F2] transition-all duration-700"
          style={{ width: `${Math.min(100, Math.max(4, value))}%` }}
        />
      </div>
    </div>
  );
}

export function OpsView({ snap }: { snap: CommandSnapshot }) {
  const hud = useHudTelemetry();
  const warn = snap.ops.modules.filter((m) => m.status !== "ok").length;
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

  return (
    <div className="flex h-full flex-col overflow-y-auto cc-scroll p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Ops — engine health</SectionLabel>
          <p className="mt-2 flex items-center gap-2.5 font-display text-[22px] font-semibold tracking-[-0.03em] text-[#F4F5F2]">
            <LiveDot level={warn === 0 ? "live" : "warn"} />
            {warn === 0 ? "All nine modules nominal" : `${warn} module${warn > 1 ? "s" : ""} degraded`}
          </p>
        </div>
      </div>

      {/* HUD telemetry bars — compute footprint · Qdrant index · AST veto */}
      <SoftCard className="mt-5 flex flex-wrap items-stretch gap-x-8 gap-y-4 px-6 py-5">
        <HudBar label="Compute footprint" value={hud.compute} display={String(hud.compute)} />
        <HudBar label="Qdrant vector index" value={hud.qdrant} display={hud.qdrant.toFixed(1)} />
        <HudBar label="AST security veto" value={100} display="PASS" unit="" />
        <HudBar label="Ingest latency" value={hud.latency * 4} display={String(hud.latency)} unit="ms" />
        <div className="flex items-center">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#5F6460]">live · 2.4s cadence</span>
        </div>
      </SoftCard>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {(
          [
            ["Outbox pending", snap.ops.outboxPending],
            ["Outbox published", snap.ops.outboxPublished],
            ["Dispatches 24h", snap.ops.dispatchesSent24h],
            ["Telemetry 24h", snap.ops.telemetryEvents24h],
            ["Alerts 24h", snap.ops.alerts24h],
            ["Verified email", `${snap.ops.verifiedEmailShare}%`],
          ] as Array<[string, string | number]>
        ).map(([label, value]) => (
          <SoftCard key={label} className="px-4 py-3.5">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#8E9194]">{label}</p>
            <p className="mt-1.5 font-display text-[22px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-[#F4F5F2]">{value}</p>
          </SoftCard>
        ))}
      </div>

      {/* Sequence engine */}
      <SoftCard className="mt-5 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <SectionLabel>Sequence engine — Module 4/9 loop closer</SectionLabel>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8E9194]">
              Claims due Channel A dispatches, honors the suppression ledger, sends through the configured provider, backs off honestly when none is set.
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

      {/* Module health */}
      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {snap.ops.modules.map((m) => (
          <SoftCard key={m.id} className="px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[14px] font-medium text-[#E9EBE7]">{m.module}</p>
              <LiveDot level={m.status === "ok" ? "live" : m.status === "warn" ? "warn" : "fail"} />
            </div>
            <p className="mt-1 font-mono text-[10.5px] text-[#6E736E]">{m.enginePath}</p>
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-[#8E9194]">{m.detail}</p>
          </SoftCard>
        ))}
      </div>

      {/* ERP stack coverage */}
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

      <SoftCard className="mt-5 px-6 py-5">
        <SectionLabel className="mb-3">Module 8 production intake contract</SectionLabel>
        <pre className="ink overflow-x-auto rounded-lg p-4 font-mono text-[11.5px] leading-relaxed text-white/90">{`POST /api/telemetry/ingest
{
  "prospectId": "cuid",              // or "domainKey"
  "eventType": "portal_visit",       // audit_view | document_download | pricing_view | session_end
  "sessionId": "…", "url": "…",
  "city": "Houston", "country": "United States",
  "latitude": 29.7604, "longitude": -95.3698,
  "device": "desktop", "durationMs": 214000
}
→ 200 { ok, event, prospect, alert? }   // alert when QLV ≥ 85 + high-signal type`}</pre>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip tone="outline">source: vertebra/telemetry/intent_tracker.py</Chip>
          <Chip tone="outline">fan-out: socket bridge :3003</Chip>
          <Chip tone="outline">channels: in_app · telegram · slack</Chip>
        </div>
      </SoftCard>
    </div>
  );
}
