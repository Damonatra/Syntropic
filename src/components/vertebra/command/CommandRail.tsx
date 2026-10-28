/** Enclave rail — navigation, live counters, zero-trust status, operator identity. */
"use client";

import type { CommandSnapshot } from "@/lib/vertebra/command";
import { LiveDot, SectionLabel } from "./bits";

export type ViewKey = "radar" | "strike" | "theatre" | "pipeline" | "portal" | "ops";

const NAV: Array<{ key: ViewKey; label: string; hint: string; glyph: string }> = [
  { key: "radar", label: "Radar", hint: "1", glyph: "◎" },
  { key: "strike", label: "Strike", hint: "2", glyph: "▸" },
  { key: "theatre", label: "Theatre", hint: "3", glyph: "◈" },
  { key: "pipeline", label: "Pipeline", hint: "4", glyph: "▤" },
  { key: "portal", label: "Portal", hint: "5", glyph: "◧" },
  { key: "ops", label: "Ops", hint: "6", glyph: "▦" },
];

export function CommandRail({
  view,
  onView,
  snap,
  clock,
  connected,
  personaCode,
}: {
  view: ViewKey;
  onView: (v: ViewKey) => void;
  snap: CommandSnapshot | null;
  clock: string;
  connected: boolean;
  personaCode: string;
}) {
  const highIntent = snap?.leads.filter((l) => l.highIntentNow).length ?? 0;
  const drafts = snap?.triage.pending.length ?? 0;
  const warn = snap?.ops.modules.filter((m) => m.status !== "ok").length ?? 0;

  const badge = (key: ViewKey): string | null => {
    if (key === "radar" && highIntent > 0) return String(highIntent);
    if (key === "strike" && snap) {
      const n = snap.leads.filter((l) => l.score != null).length;
      return n > 0 ? String(n) : null;
    }
    if (key === "pipeline" && drafts > 0) return String(drafts);
    return null;
  };

  return (
    <aside className="flex h-full w-[228px] shrink-0 flex-col border-r border-black/[0.06] bg-[#F0F1F3]">
      {/* brand */}
      <div className="border-b border-black/[0.06] px-5 py-5">
        <p className="font-display text-[19px] font-semibold leading-none tracking-[-0.03em] text-[#08080A]">SYNTROPIC</p>
        <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.28em] text-[#5F646D]">Vertebra · Margin Defense</p>
        <div className="mt-4 flex items-center gap-2">
          <LiveDot level={connected ? "live" : "warn"} />
          <span className="font-mono text-[10.5px] tabular-nums text-[#3A3F46]">{connected ? "LIVE" : "BRIDGE DOWN"}</span>
          <span className="ml-auto font-mono text-[10.5px] tabular-nums text-[#5F646D]">{clock}</span>
        </div>
      </div>

      {/* nav */}
      <nav className="flex flex-col gap-1 px-3 py-4" aria-label="Enclave views">
        {NAV.map((item) => {
          const active = view === item.key;
          const count = badge(item.key);
          return (
            <button
              key={item.key}
              onClick={() => onView(item.key)}
              aria-current={active ? "page" : undefined}
              className={`group flex h-11 items-center gap-3 rounded-full px-3.5 transition-all ${
                active
                  ? "bg-[#08080A] text-white shadow-[4px_4px_10px_rgba(0,0,0,0.18),-3px_-3px_8px_rgba(255,255,255,0.8)]"
                  : "text-[#5F646D] hover:bg-white hover:text-[#08080A] hover:shadow-[3px_3px_8px_rgba(0,0,0,0.06),-3px_-3px_8px_rgba(255,255,255,0.9)]"
              }`}
            >
              <span className={`w-4 text-center text-[13px] ${active ? "text-white" : "text-[#A6ABB2]"}`}>{item.glyph}</span>
              <span className="text-[13.5px] font-medium">{item.label}</span>
              {count && (
                <span
                  className={`ml-auto inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-1.5 font-mono text-[10px] tabular-nums ${
                    active
                      ? "bg-white/15 text-white"
                      : (item.key === "radar" && highIntent > 0) || (item.key === "pipeline" && drafts > 0)
                        ? "bg-[#08080A] text-white"
                        : "bg-black/[0.06] text-[#5F646D]"
                  }`}
                >
                  {count}
                </span>
              )}
              {!count && <span className={`ml-auto font-mono text-[9.5px] ${active ? "text-white/40" : "text-[#A6ABB2]"}`}>{item.hint}</span>}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3 px-5 pb-5">
        <div className="border-t border-black/[0.06] pt-4">
          <div className="flex items-center justify-between">
            <SectionLabel>Enclave</SectionLabel>
            <LiveDot level={warn === 0 ? "live" : "warn"} />
          </div>
          <p className="mt-1.5 text-[11.5px] text-[#5F646D]">{snap ? (warn === 0 ? "All modules nominal" : `${warn} degraded`) : "…"}</p>
        </div>
        <div className="border-t border-black/[0.06] pt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#08080A]">Operator // Josias</p>
          <p className="mt-0.5 text-[11px] text-[#5F646D]">Clearance: {personaCode} · 1-of-1</p>
          <p className="mt-3 font-mono text-[9.5px] leading-relaxed text-[#A6ABB2]">
            j/k move · enter open · c call · s snooze · ⌘K jump
          </p>
        </div>
      </div>
    </aside>
  );
}
