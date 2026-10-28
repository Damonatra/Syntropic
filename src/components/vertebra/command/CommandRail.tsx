/** Command rail — navigation, live counters, health, operator identity. */
"use client";

import type { CommandSnapshot } from "@/lib/vertebra/command";
import { LiveDot, SectionLabel } from "./bits";

export type ViewKey = "radar" | "strike" | "theatre" | "pipeline" | "ops";

const NAV: Array<{ key: ViewKey; label: string; hint: string; glyph: string }> = [
  { key: "radar", label: "Radar", hint: "1", glyph: "◎" },
  { key: "strike", label: "Strike", hint: "2", glyph: "▸" },
  { key: "theatre", label: "Theatre", hint: "3", glyph: "◈" },
  { key: "pipeline", label: "Pipeline", hint: "4", glyph: "▤" },
  { key: "ops", label: "Ops", hint: "5", glyph: "▦" },
];

export function CommandRail({
  view,
  onView,
  snap,
  clock,
  connected,
}: {
  view: ViewKey;
  onView: (v: ViewKey) => void;
  snap: CommandSnapshot | null;
  clock: string;
  connected: boolean;
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
    <aside className="flex h-full w-[228px] shrink-0 flex-col border-r border-[#1a1a1e] bg-[#0c0c0e]">
      {/* brand */}
      <div className="border-b border-[#1a1a1e] px-5 py-5">
        <p className="font-serif text-[21px] leading-none tracking-[-0.01em] text-[#f2f2f4]">vertebra</p>
        <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.28em] text-[#5c5c64]">Command centre</p>
        <div className="mt-4 flex items-center gap-2">
          <LiveDot level={connected ? "live" : "idle"} />
          <span className="font-mono text-[10.5px] tabular-nums text-[#8b8b93]">{connected ? "LIVE" : "OFFLINE"}</span>
          <span className="ml-auto font-mono text-[10.5px] tabular-nums text-[#5c5c64]">{clock}</span>
        </div>
      </div>

      {/* nav */}
      <nav className="flex flex-col gap-1 px-3 py-4" aria-label="Command views">
        {NAV.map((item) => {
          const active = view === item.key;
          const count = badge(item.key);
          return (
            <button
              key={item.key}
              onClick={() => onView(item.key)}
              aria-current={active ? "page" : undefined}
              className={`group flex h-11 items-center gap-3 rounded-xl px-3.5 transition-colors ${
                active ? "bg-[#1a1a1e] text-[#fafafa]" : "text-[#8b8b93] hover:bg-[#141417] hover:text-[#d6d6db]"
              }`}
            >
              <span className={`w-4 text-center text-[13px] ${active ? "text-[#fafafa]" : "text-[#4a4a52]"}`}>{item.glyph}</span>
              <span className="text-[13.5px] font-medium">{item.label}</span>
              {count && (
                <span
                  className={`ml-auto inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-1.5 font-mono text-[10px] tabular-nums ${
                    (item.key === "radar" && highIntent > 0) || (item.key === "pipeline" && drafts > 0)
                      ? "bg-[#fafafa] text-[#0a0a0b]"
                      : "bg-[#232327] text-[#b6b6bd]"
                  }`}
                >
                  {count}
                </span>
              )}
              {!count && <span className="ml-auto font-mono text-[9.5px] text-[#2e2e34]">{item.hint}</span>}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3 px-5 pb-5">
        <div className="border-t border-[#1a1a1e] pt-4">
          <div className="flex items-center justify-between">
            <SectionLabel>Health</SectionLabel>
            <LiveDot level={warn === 0 ? "live" : "warn"} />
          </div>
          <p className="mt-1.5 text-[11.5px] text-[#6b6b72]">{snap ? (warn === 0 ? "All modules nominal" : `${warn} degraded`) : "…"}</p>
        </div>
        <div className="border-t border-[#1a1a1e] pt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8b8b93]">Josias</p>
          <p className="mt-0.5 text-[11px] text-[#4a4a52]">Syntropic Engine · 1-of-1 operator</p>
          <p className="mt-3 font-mono text-[9.5px] leading-relaxed text-[#33333a]">
            j/k move · enter open · c call · s snooze · ⌘K jump
          </p>
        </div>
      </div>
    </aside>
  );
}
