/** Enclave rail — navigation, live counters, zero-trust status, operator identity. */
"use client";

import { useCallback, useSyncExternalStore } from "react";
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

/** Persisted rail posture — "1" keeps the icon column between visits. */
const RAIL_KEY = "syntropic:rail";

/**
 * Rail posture as a tiny external store: localStorage is the source of truth,
 * useSyncExternalStore hydrates safely (server snapshot = expanded) and the
 * `storage` event syncs the posture across tabs for free.
 */
const railStore = {
  listeners: new Set<() => void>(),
  subscribe(notify: () => void): () => void {
    railStore.listeners.add(notify);
    window.addEventListener("storage", notify);
    return () => {
      railStore.listeners.delete(notify);
      window.removeEventListener("storage", notify);
    };
  },
  read(): boolean {
    try {
      return window.localStorage.getItem(RAIL_KEY) === "1";
    } catch {
      return false;
    }
  },
  write(next: boolean): void {
    try {
      window.localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable — posture stays session-local */
    }
    for (const notify of railStore.listeners) notify();
  },
  serverRead(): boolean {
    return false;
  },
};

export function CommandRail({
  view,
  onView,
  snap,
  clock,
  connected,
  personaCode,
  operator,
}: {
  view: ViewKey;
  onView: (v: ViewKey) => void;
  snap: CommandSnapshot | null;
  clock: string;
  connected: boolean;
  personaCode: string;
  operator: { username: string; displayName: string } | null;
}) {
  // Collapse posture is per-browser, remembered across visits.
  const collapsed = useSyncExternalStore(railStore.subscribe, railStore.read, railStore.serverRead);
  const toggleRail = useCallback(() => railStore.write(!railStore.read()), []);

  const highIntent = snap?.leads.filter((l) => l.highIntentNow).length ?? 0;
  const drafts = snap?.triage.pending.length ?? 0;
  const warn = snap?.ops.deck?.filter((a) => a.severity !== "info").length ?? 0;

  const badge = (key: ViewKey): string | null => {
    if (key === "radar" && highIntent > 0) return String(highIntent);
    if (key === "strike" && snap) {
      const n = snap.leads.filter((l) => l.score != null).length;
      return n > 0 ? String(n) : null;
    }
    if (key === "pipeline" && drafts > 0) return String(drafts);
    return null;
  };

  // Identity — the signed session names whoever is at the stick; "—" while
  // the door is unlocked (sandbox, gate off) or the handshake is in flight.
  const initials = operator ? operator.displayName.trim().slice(0, 2).toUpperCase() : "—";
  const operatorTitle = operator
    ? `Signed in as ${operator.username} — ${operator.displayName}`
    : "No signed session";

  // The rail's one collapse control — lives at the top of the rail in both
  // postures (brand row when expanded, under the monogram when collapsed),
  // so it can never be buried by overlays or lost below the fold.
  const collapseControl = (
    <button
      type="button"
      onClick={toggleRail}
      aria-label={collapsed ? "Expand rail" : "Collapse rail"}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand rail" : "Collapse rail"}
      className="rail-toggle flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[12px] leading-none"
    >
      {collapsed ? "›" : "‹"}
    </button>
  );

  return (
    <aside
      className={`hidden h-full shrink-0 flex-col overflow-hidden border-r border-white/[0.08] bg-[#0E100E] transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:flex ${
        collapsed ? "w-[64px]" : "w-[228px]"
      }`}
    >
      {collapsed ? (
        <>
          {/* brand — monogram, live signal, collapse control */}
          <div className="flex flex-col items-center gap-2.5 border-b border-white/[0.08] py-4 whitespace-nowrap">
            <p className="font-display text-[19px] font-semibold leading-none tracking-[-0.03em] text-[#F4F5F2]" title="SYNTROPIC — Vertebra · Margin Defense">
              S
            </p>
            <LiveDot level={connected ? "live" : "warn"} />
            {collapseControl}
          </div>

          {/* nav — glyphs only; counts ride the corner so alarms still surface */}
          <nav className="flex flex-col gap-1 px-2.5 py-4" aria-label="Enclave views">
            {NAV.map((item) => {
              const active = view === item.key;
              const count = badge(item.key);
              return (
                <button
                  key={item.key}
                  onClick={() => onView(item.key)}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  className={`relative flex h-11 w-full items-center justify-center rounded-full transition-all ${
                    active ? "bg-[#F4F5F2] text-[#0B0C0B]" : "text-[#8E9194] tactile-card"
                  }`}
                >
                  <span className={`text-[13px] ${active ? "text-[#0B0C0B]" : "text-[#8E9194]"}`}>{item.glyph}</span>
                  {count && (
                    <span
                      className={`absolute right-0.5 top-1 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 font-mono text-[9px] tabular-nums ${
                        active
                          ? "bg-[#0B0C0B] text-[#F4F5F2]"
                          : (item.key === "radar" && highIntent > 0) || (item.key === "pipeline" && drafts > 0)
                            ? "bg-[#F4F5F2] text-[#0B0C0B]"
                            : "border border-white/[0.08] bg-[#1A1D1A] text-[#8E9194]"
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* footer — enclave pulse, identity initials */}
          <div className="mt-auto flex flex-col items-center gap-2.5 pb-4 whitespace-nowrap">
            <LiveDot level={warn === 0 ? "live" : "warn"} />
            <span
              title={`${operatorTitle} · Clearance: ${personaCode} · 1-of-1`}
              className="flex size-7 items-center justify-center rounded-full border border-white/[0.12] bg-[#131513] font-mono text-[9.5px] tracking-[0.06em] text-[#C9CCC7]"
            >
              {initials}
            </span>
          </div>
        </>
      ) : (
        <>
          {/* brand — collapse control pinned top-right, on the cap line */}
          <div className="relative whitespace-nowrap border-b border-white/[0.08] px-5 py-5">
            <span className="absolute right-4 top-[17px]">{collapseControl}</span>
            <p className="font-display text-[19px] font-semibold leading-none tracking-[-0.03em] text-[#F4F5F2]">SYNTROPIC</p>
            <p className="mt-1.5 font-mono text-[9.5px] uppercase tracking-[0.28em] text-[#6E736E]">Vertebra · Margin Defense</p>
            <div className="mt-4 flex items-center gap-2">
              <LiveDot level={connected ? "live" : "warn"} />
              <span className="font-mono text-[10.5px] tabular-nums text-[#C9CCC7]">{connected ? "LIVE" : "BRIDGE DOWN"}</span>
              <span className="ml-auto font-mono text-[10.5px] tabular-nums text-[#6E736E]">{clock}</span>
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
                  className={`group flex h-11 items-center gap-3 whitespace-nowrap rounded-full border px-3.5 transition-all ${
                    active
                      ? "border-[#F4F5F2] bg-[#F4F5F2] text-[#0B0C0B]"
                      : "border-transparent text-[#8E9194] hover:border-white/[0.12] hover:bg-[#131513] hover:text-[#F4F5F2]"
                  }`}
                >
                  <span className={`w-4 text-center text-[13px] ${active ? "text-[#0B0C0B]" : "text-[#5F6460]"}`}>{item.glyph}</span>
                  <span className="text-[13.5px] font-medium">{item.label}</span>
                  {count && (
                    <span
                      className={`ml-auto inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-1.5 font-mono text-[10px] tabular-nums ${
                        active
                          ? "bg-[#0B0C0B] text-[#F4F5F2]"
                          : (item.key === "radar" && highIntent > 0) || (item.key === "pipeline" && drafts > 0)
                            ? "bg-[#F4F5F2] text-[#0B0C0B]"
                            : "bg-[#1A1D1A] text-[#8E9194] border border-white/[0.08]"
                      }`}
                    >
                      {count}
                    </span>
                  )}
                  {!count && <span className={`ml-auto font-mono text-[9.5px] ${active ? "text-[#0B0C0B]/50" : "text-[#5F6460]"}`}>{item.hint}</span>}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto flex flex-col gap-3 whitespace-nowrap px-5 pb-4">
            <div className="border-t border-white/[0.08] pt-4">
              <div className="flex items-center justify-between">
                <SectionLabel>Enclave</SectionLabel>
                <LiveDot level={warn === 0 ? "live" : "warn"} />
              </div>
              <p className="mt-1.5 text-[11.5px] text-[#8E9194]">{snap ? (warn === 0 ? "All watches quiet" : `${warn} watch${warn > 1 ? "es" : ""} live`) : "…"}</p>
            </div>
            <div className="border-t border-white/[0.08] pt-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#F4F5F2]">
                Operator // {operator ? operator.displayName : "—"}
              </p>
              <p className="mt-0.5 text-[11px] text-[#8E9194]" title={operatorTitle}>
                Clearance: {personaCode} · 1-of-1
              </p>
              <p className="mt-3 font-mono text-[9.5px] leading-relaxed text-[#5F6460]">
                j/k move · e cold email · f filter · ? help · ⌘K jump
              </p>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
