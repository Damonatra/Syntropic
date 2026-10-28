/** OPS — machine health. Quiet by design: one glance, never a home. */
"use client";

import { Chip, LiveDot, SectionLabel, SoftCard } from "./bits";
import type { CommandSnapshot } from "@/lib/vertebra/command";

export function OpsView({ snap }: { snap: CommandSnapshot }) {
  const warn = snap.ops.modules.filter((m) => m.status !== "ok").length;

  return (
    <div className="flex h-full flex-col overflow-y-auto cc-scroll p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionLabel>Ops — engine health</SectionLabel>
          <p className="mt-2 flex items-center gap-2.5 font-serif text-[22px] tracking-[-0.01em] text-[#f2f2f4]">
            <LiveDot level={warn === 0 ? "live" : "warn"} />
            {warn === 0 ? "All nine modules nominal" : `${warn} module${warn > 1 ? "s" : ""} degraded`}
          </p>
        </div>
      </div>

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
            <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#5c5c64]">{label}</p>
            <p className="mt-1.5 font-mono text-[22px] font-medium leading-none tabular-nums text-[#e4e4e8]">{value}</p>
          </SoftCard>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {snap.ops.modules.map((m) => (
          <SoftCard key={m.id} className="px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[14px] font-medium text-[#e4e4e8]">{m.module}</p>
              <LiveDot level={m.status === "ok" ? "live" : m.status === "warn" ? "warn" : "fail"} />
            </div>
            <p className="mt-1 font-mono text-[10.5px] text-[#4a4a52]">{m.enginePath}</p>
            <p className="mt-2.5 text-[12.5px] leading-relaxed text-[#8b8b93]">{m.detail}</p>
          </SoftCard>
        ))}
      </div>

      <SoftCard className="mt-5 px-5 py-4">
        <SectionLabel className="mb-3">Module 8 production intake contract</SectionLabel>
        <pre className="overflow-x-auto rounded-xl bg-[#0e0e10] p-4 font-mono text-[11.5px] leading-relaxed text-[#b6b6bd]">{`POST /api/telemetry/ingest
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
