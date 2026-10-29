/** THEATRE — spatial operations board for US + Canada (Module 7 v2).
 *
 * Real geography under the distributors: all 50 states, DC and the 13
 * Canadian provinces/territories as bundled vector polygons (Natural Earth
 * 10m, public domain) on a Lambert Conformal Conic — the canonical conic
 * for the continent. Zero network beyond the enclave's own static assets.
 *
 * Depth ladder:
 *   L0 continent — every territory shaded by the active lens
 *   L1 territory — click a state/province: camera glides to its bounds,
 *                  readout arms, pins outside the focus dim
 *   L2 account   — click a pin: the dossier drawer opens
 *
 * Map-3: all six lenses live — CONCENTRATION / MOMENTUM / EXPOSURE / CADENCE /
 * COMPLIANCE / MAIL, one metric per board state, luminance never chroma. The
 * whole board state is deep-linkable: lens, focused territory, cluster and
 * camera ride the URL (?tl= &tt= &tc= &tk/tx/ty=) and survive a reload.
 *
 * Map-4: the pulse — a 48h territory movement ledger (every entry traces to a
 * real row), local call windows per territory (08:00–18:00 local, Mon–Fri) and
 * honest 24h deltas that arm only once the ledger has genuinely accumulated.
 *
 * Layout doctrine: one grouped control toolbar (theatre / filter / lens) rides
 * above the board — every chip there drives the map. Everything that displays
 * data on click stacks directly beneath it; the pulse runs as the foot tape.
 * Nothing decorative sits above the map.
 *
 * Honest ledger: leads with no coordinates land in the uncharted tray,
 * leads outside the US+CA frame land in the off-board tray. Nothing
 * silently disappears from the board.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Chip, EmptyHint, SectionLabel, SoftCard } from "./bits";
import { STRIKE_FILTERS, computeFilterCounts, filterMatch, type StrikeFilter } from "./StrikeView";
import { TerritoryDrawer } from "./TerritoryDrawer";
import {
  HEAT_FILL,
  heatLevel,
  money,
  relTime,
  verticalLabel,
  type CommandLead,
  type CommandSnapshot,
} from "@/lib/vertebra/command";
import { classifyLeadGeo, inNaFrame } from "@/lib/vertebra/geo";
import {
  BOARD_H,
  BOARD_W,
  LENSES,
  buildBoardGeometry,
  censusBoard,
  encodeBoardState,
  lensFill,
  lensLeader,
  lensMetricLabel,
  loadGeoBundle,
  makeTerritoryResolver,
  parseBoardState,
  pulseDeltaSummary,
  territoryCallWindow,
  type BoardCensus,
  type BoardGeometry,
  type CallWindow,
  type GeoBundle,
  type LensExtremes,
  type LensId,
  type TerritoryStat,
} from "@/lib/vertebra/theatre";

const MAX_K = 18;
const NAME_ZOOM = 2.2; // k at which full territory names replace codes

interface View {
  k: number;
  x: number;
  y: number;
}
const IDENTITY: View = { k: 1, x: 0, y: 0 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Concentration ink — luminance ramp, never chroma. */
function screenBounds(
  bounds: [[number, number], [number, number]],
  view: View,
): [[number, number], [number, number]] {
  const [[x0, y0], [x1, y1]] = bounds;
  return [
    [x0 * view.k + view.x, y0 * view.k + view.y],
    [x1 * view.k + view.x, y1 * view.k + view.y],
  ];
}

function intersectsViewport(
  bounds: [[number, number], [number, number]],
  view: View,
): boolean {
  const [[sx0, sy0], [sx1, sy1]] = screenBounds(bounds, view);
  return sx1 >= 0 && sx0 <= BOARD_W && sy1 >= 0 && sy0 <= BOARD_H;
}

/** Toolbar row — fixed micro label plus a wrapping pool of control chips.
 * One shared grid keeps every map control in a single visual system. */
function ControlRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="w-full shrink-0 font-mono text-[9px] uppercase tracking-[0.16em] text-[#3F433F] sm:w-16">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function TheatreView({
  snap,
  onOpenDossier,
  filter = "all",
  onFilter,
}: {
  snap: CommandSnapshot;
  onOpenDossier: (lead: CommandLead) => void;
  /** M1 filter — same source of truth as the strike queue (bidirectional). */
  filter?: StrikeFilter;
  onFilter?: (f: StrikeFilter) => void;
}) {
  // ---------------------------------------------------------------- geometry
  const [bundle, setBundle] = useState<GeoBundle | null>(null);
  const [geoFailed, setGeoFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadGeoBundle().then((b) => {
      if (!alive) return;
      setBundle(b);
      setGeoFailed(b == null);
    });
    return () => {
      alive = false;
    };
  }, []);

  const geometry: BoardGeometry | null = useMemo(() => (bundle ? buildBoardGeometry(bundle) : null), [bundle]);
  const resolver = useMemo(() => (bundle ? makeTerritoryResolver(bundle) : null), [bundle]);

  // M1 filter binding — the strike queue's bucket predicate decides which
  // leads exist on the board at all. One state, two views.
  const boardLeads = useMemo(
    () => (filter === "all" ? snap.leads : snap.leads.filter((l) => filterMatch(l, filter))),
    [snap.leads, filter],
  );
  const census: BoardCensus = useMemo(
    () => censusBoard(boardLeads, resolver ?? (() => null)),
    [boardLeads, resolver],
  );

  const filterCounts = useMemo(() => computeFilterCounts(snap, snap.generatedAtMs), [snap]);
  const pendingReplies = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of snap.triage.pending) m.set(t.prospectId, (m.get(t.prospectId) ?? 0) + 1);
    return m;
  }, [snap.triage.pending]);

  const leadTerritory = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of census.territoryStats.values()) for (const l of s.leads) m.set(l.id, s.code);
    return m;
  }, [census]);

  // ---------------------------------------------------------------- state
  // Deep-linked boot — lens/territory/cluster/camera hydrate from the URL
  // before first paint; the geometry gate below keeps SSR and client in sync.
  const [boot] = useState(() => parseBoardState(typeof window === "undefined" ? null : window.location.search));
  const [selectedCluster, setSelectedCluster] = useState<string | null>(boot.cluster);
  const [focusedCode, setFocusedCode] = useState<string | null>(boot.territory);
  const [hoverCode, setHoverCode] = useState<string | null>(null);
  const [view, setView] = useState<View>(boot.view ?? IDENTITY);
  const [dragging, setDragging] = useState(false);
  const [lens, setLens] = useState<LensId>(boot.lens);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Map-4 pulse — visible by default; a ticker you must discover is a dead ticker
  const [pulseOpen, setPulseOpen] = useState(true);

  // camera-restore bookkeeping: skip the glide when the URL already carried
  // one, or when there is no territory to restore
  const bootRestoreRef = useRef(boot.territory == null || boot.view != null);

  const viewRef = useRef(view);
  // sync after render — the drag/glide/zoom handlers already keep ref and
  // state in lock-step; this only guards external setView paths
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const glideRaf = useRef<number | null>(null);
  const dragState = useRef<{
    lastX: number;
    lastY: number;
    downX: number;
    downY: number;
    scale: number;
    moved: boolean;
    pid: number;
    captured: boolean;
  } | null>(null);

  const cluster = selectedCluster ? snap.clusters.find((c) => c.id === selectedCluster) ?? null : null;
  const focusedStat = focusedCode ? census.territoryStats.get(focusedCode) ?? null : null;
  const focusedMeta = focusedCode ? geometry?.territoryDrawables.find((t) => t.code === focusedCode) ?? null : null;

  // ---------------------------------------------------------------- camera
  const cancelGlide = useCallback(() => {
    if (glideRaf.current != null) {
      cancelAnimationFrame(glideRaf.current);
      glideRaf.current = null;
    }
  }, []);

  const glide = useCallback(
    (target: View) => {
      cancelGlide();
      const from = { ...viewRef.current };
      const t0 = performance.now();
      const DUR = 680;
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / DUR);
        const e = easeInOutCubic(t);
        const next: View = {
          k: from.k + (target.k - from.k) * e,
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
        };
        viewRef.current = next;
        setView(next);
        glideRaf.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      glideRaf.current = requestAnimationFrame(step);
    },
    [cancelGlide],
  );

  const glideToBounds = useCallback(
    (bounds: [[number, number], [number, number]]) => {
      const [[x0, y0], [x1, y1]] = bounds;
      const bw = Math.max(1e-6, x1 - x0);
      const bh = Math.max(1e-6, y1 - y0);
      const k = clamp(0.52 * Math.min(BOARD_W / bw, BOARD_H / bh), 1, MAX_K);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      glide({ k, x: BOARD_W / 2 - k * cx, y: BOARD_H / 2 - k * cy });
    },
    [glide],
  );

  const resetView = useCallback(() => {
    setFocusedCode(null);
    setDrawerOpen(false);
    glide(IDENTITY);
  }, [glide]);

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      cancelGlide();
      const { k, x, y } = viewRef.current;
      const nk = clamp(k * factor, 1, MAX_K);
      if (nk === k) return;
      viewRef.current = { k: nk, x: px - ((px - x) / k) * nk, y: py - ((py - y) / k) * nk };
      setView(viewRef.current);
    },
    [cancelGlide],
  );

  const zoomCenter = useCallback(
    (factor: number) => zoomAt(factor, BOARD_W / 2, BOARD_H / 2),
    [zoomAt],
  );

  // wheel — native listener so preventDefault works (React attaches passive).
  // Re-runs when geometry lands because the svg only mounts after the
  // loading early-return resolves; svgRef is null on first pass.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * BOARD_W;
      const py = ((e.clientY - rect.top) / rect.height) * BOARD_H;
      zoomAt(Math.exp(-e.deltaY * 0.0014), px, py);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, geometry]);

  // pointer drag — pan. Capture is withheld until the pointer actually moves
  // (~3px): capturing on pointerdown would retarget the browser's follow-up
  // click to the svg root and every territory/pin click would die silently.
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragState.current = {
      lastX: e.clientX,
      lastY: e.clientY,
      downX: e.clientX,
      downY: e.clientY,
      scale: BOARD_W / rect.width,
      moved: false,
      pid: e.pointerId,
      captured: false,
    };
    cancelGlide();
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragState.current;
    if (!d) return;
    const dx = (e.clientX - d.lastX) * d.scale;
    const dy = (e.clientY - d.lastY) * d.scale;
    if (!d.captured && Math.hypot(e.clientX - d.downX, e.clientY - d.downY) > 3) {
      // capture can throw if the pointer vanished (synthetic events, release
      // races) — never let it kill the pan; skip retrying once failed
      try {
        (e.currentTarget as Element).setPointerCapture?.(d.pid);
      } catch {
        /* pan continues without capture while the pointer stays over the board */
      }
      d.captured = true;
    }
    if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    const { k, x, y } = viewRef.current;
    viewRef.current = { k, x: x + dx, y: y + dy };
    setView(viewRef.current);
  };
  const endDrag = () => {
    dragState.current = null;
    setDragging(false);
  };

  // keyboard — +/− zoom, arrows pan, ESC resets
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        // A Radix sheet/dialog owns Escape while it is open — and it closes
        // synchronously, before this window listener runs. DOM-truth check:
        // ESC peels one layer at a time (drawer first), the camera only
        // resets once no dialog remains.
        if (document.querySelector('[role="dialog"]')) return;
        if (viewRef.current.k !== 1 || viewRef.current.x !== 0 || viewRef.current.y !== 0) resetView();
      } else if (e.key === "+" || e.key === "=") {
        zoomCenter(1.4);
      } else if (e.key === "-" || e.key === "_") {
        zoomCenter(1 / 1.4);
      } else if ((e.key === "p" || e.key === "P") && !document.querySelector('[role="dialog"]')) {
        setPulseOpen((v) => !v);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = 70;
        const { k, x, y } = viewRef.current;
        const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        viewRef.current = { k, x: x + dx, y: y + dy };
        setView(viewRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resetView, zoomCenter]);

  useEffect(() => cancelGlide, [cancelGlide]);

  // deep link — camera restore: once geometry exists, glide to the URL's
  // territory unless the URL already restored the exact camera
  useEffect(() => {
    if (bootRestoreRef.current || !geometry) return;
    bootRestoreRef.current = true;
    const t = geometry.territoryDrawables.find((d) => d.code === boot.territory);
    if (t) glideToBounds(t.bounds);
  }, [geometry, glideToBounds, boot.territory]);

  // deep link — write the board state back to the URL. Debounced: the timer
  // keeps resetting during glides/drags and settles once they end.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const q = encodeBoardState({ lens, territory: focusedCode, cluster: selectedCluster, view });
      window.history.replaceState(null, "", `${window.location.pathname}${q}${window.location.hash}`);
    }, 350);
    return () => window.clearTimeout(id);
  }, [lens, focusedCode, selectedCluster, view]);

  // ---------------------------------------------------------------- derived
  const plottedLeakage = census.totalPlottedLeakageUsd;
  const focusedMemberLeads = focusedStat ? focusedStat.leads : [];
  const clusterLeads = cluster ? snap.leads.filter((l) => l.clusterId === cluster.id) : [];
  const memberLeads = focusedStat ? focusedMemberLeads : clusterLeads;

  // inline reduce — census arrays are mutated by censusBoard, so the compiler
  // cannot preserve a useMemo here; the pool is small enough to not need one
  const topFocusedLead = focusedMemberLeads.length
    ? focusedMemberLeads.reduce((a, b) => ((b.priority ?? 0) > (a.priority ?? 0) ? b : a))
    : null;

  const nowMs = snap.generatedAtMs;

  const lensExt: LensExtremes = useMemo(
    () => ({
      maxCount: census.maxTerritoryCount,
      maxLeakageUsd: census.maxLeakageUsd,
      maxMomentum48h: census.maxMomentum48h,
      maxMailVolume: census.maxMailVolume,
      nowMs,
    }),
    [census, nowMs],
  );
  const leader = useMemo(
    () => lensLeader(lens, Array.from(census.territoryStats.values()), nowMs),
    [lens, census, nowMs],
  );
  const activeLens = LENSES.find((l) => l.id === lens) ?? null;

  // Map-4 pulse — movement ledger + per-territory call windows
  const pulse = useMemo(() => snap.pulse ?? [], [snap.pulse]);
  const pulseSummary = useMemo(() => pulseDeltaSummary(pulse, nowMs), [pulse, nowMs]);
  const visiblePulse = useMemo(() => {
    const scoped = focusedCode ? pulse.filter((e) => e.territory === focusedCode) : pulse;
    return scoped.slice(0, 7);
  }, [pulse, focusedCode]);
  const callWindows = useMemo(() => {
    const entries: Array<{ code: string; cw: CallWindow }> = [];
    for (const code of census.territoryStats.keys()) {
      const cw = territoryCallWindow(code, nowMs);
      if (cw) entries.push({ code, cw });
    }
    entries.sort(
      (a, b) =>
        (b.cw.open ? 1 : 0) - (a.cw.open ? 1 : 0) ||
        (a.cw.opensAtMs ?? Infinity) - (b.cw.opensAtMs ?? Infinity) ||
        a.code.localeCompare(b.code),
    );
    return entries;
  }, [census, nowMs]);
  const focusTerritory = useCallback(
    (code: string) => {
      const t = geometry?.territoryDrawables.find((d) => d.code === code);
      if (!t) return;
      setFocusedCode(code);
      glideToBounds(t.bounds);
      setDrawerOpen(true);
    },
    [geometry, glideToBounds],
  );

  // ---------------------------------------------------------------- render
  if (geoFailed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <SectionLabel>Theatre board — geometry unavailable</SectionLabel>
        <EmptyHint>
          Territory bundle failed to load — check public/geo/us-ca-territories.json and reload.
        </EmptyHint>
      </div>
    );
  }

  if (!geometry) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <SectionLabel>Theatre board — loading geometry</SectionLabel>
        <EmptyHint>Projecting 50 states · DC · 13 provinces and territories…</EmptyHint>
      </div>
    );
  }

  const k = view.k;
  const sw = (base: number) => base / k; // constant-on-screen stroke weight
  const fs = (base: number) => base / k; // constant-on-screen font size

  return (
    <div className="flex h-full flex-col overflow-y-auto cc-scroll p-6">
      {/* header — identity plus one honest count line; nothing else */}
      <div>
        <SectionLabel>Theatre — US + Canada spatial operations</SectionLabel>
        <p className="mt-2 font-display text-[20px] font-semibold tracking-[-0.03em] text-[#F4F5F2]">
          {census.plotted.length} plotted · {money(plottedLeakage)} exposure
          {census.offBoard.length > 0 ? ` · ${census.offBoard.length} off-board` : ""}
          {census.uncharted.length > 0 ? ` · ${census.uncharted.length} uncharted` : ""}
        </p>
      </div>

      {/* map controls — one grouped toolbar; every chip here drives the board */}
      <SoftCard className="mt-4 px-5 py-4">
        <div className="flex flex-col gap-3">
          <ControlRow label="theatre">
            <button
              onClick={() => setSelectedCluster(null)}
              className={`h-8 rounded-full px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-all ${
                selectedCluster == null
                  ? "bg-[#F4F5F2] text-[#0B0C0B]"
                  : "border border-white/[0.12] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2]"
              }`}
            >
              All theatres
            </button>
            {snap.clusters.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedCluster(c.id === selectedCluster ? null : c.id)}
                className={`h-8 rounded-full px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-all ${
                  selectedCluster === c.id
                    ? "bg-[#F4F5F2] text-[#0B0C0B]"
                    : "border border-white/[0.12] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2]"
                }`}
              >
                {c.clusterName}
              </button>
            ))}
          </ControlRow>

          <ControlRow label="filter">
            {STRIKE_FILTERS.map(([key, label]) => {
              const active = filter === key;
              const count = filterCounts[key];
              return (
                <button
                  key={key}
                  onClick={() => onFilter?.(key)}
                  aria-pressed={active}
                  title={`${count} target${count === 1 ? "" : "s"} match this filter — shared with the strike queue`}
                  className={`h-8 rounded-full px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-all ${
                    active
                      ? "bg-[#F4F5F2] text-[#0B0C0B]"
                      : `border border-white/[0.12] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2] ${count === 0 ? "opacity-45" : ""}`
                  }`}
                >
                  {label}
                  <span className={`ml-1.5 tabular-nums ${active ? "text-[#0B0C0B]/55" : "text-[#5F6460]"}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </ControlRow>

          <ControlRow label="lens">
            {LENSES.map((l) => {
              const active = lens === l.id;
              return (
                <button
                  key={l.id}
                  onClick={() => setLens(l.id)}
                  aria-pressed={active}
                  title={l.hint}
                  className={`h-8 rounded-full px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-all ${
                    active
                      ? "bg-[#F4F5F2] text-[#0B0C0B]"
                      : "border border-white/[0.12] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2]"
                  }`}
                >
                  {l.label}
                </button>
              );
            })}
          </ControlRow>
        </div>
        <p className="mt-3.5 border-t border-white/[0.06] pt-2.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#5F6460]">
          {activeLens ? `${activeLens.id} // ${activeLens.hint}` : ""}
          {leader ? ` — leader: ${leader.name} (${leader.readout})` : ""}
        </p>
      </SoftCard>

      {/* the board */}
      <SoftCard className="relative mt-4 shrink-0 overflow-hidden p-2.5">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
          className={`block w-full select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
          style={{ aspectRatio: "1200 / 640" }}
          role="img"
          aria-label="US and Canada territory map with plotted distributors"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <defs>
            <radialGradient id="ringGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#F4F5F2" stopOpacity="0.06" />
              <stop offset="100%" stopColor="#F4F5F2" stopOpacity="0" />
            </radialGradient>
          </defs>

          <rect x="0" y="0" width={BOARD_W} height={BOARD_H} fill="#0E100E" rx="8" />

          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {/* graticule — under the land */}
            <path d={geometry.graticulePath} fill="none" stroke="#1C1F1C" strokeWidth={sw(1)} pointerEvents="none" />

            {/* territories */}
            {geometry.territoryDrawables.map((t) => {
              const stat = census.territoryStats.get(t.code);
              const focused = focusedCode === t.code;
              const hovered = hoverCode === t.code;
              const dimmed = focusedCode != null && !focused;
              return (
                <path
                  key={t.code}
                  d={t.d}
                  fill={lensFill(lens, stat, lensExt, focused, hovered)}
                  stroke={
                    focused
                      ? "#8E9194"
                      : lens === "mail" && stat != null && stat.mailFailed > 0
                        ? "#B9BDB9"
                        : hovered
                          ? "#4B514D"
                          : "#2A2D2A"
                  }
                  strokeWidth={sw(focused ? 1.4 : 0.8)}
                  opacity={dimmed ? 0.45 : 1}
                  className="cursor-pointer"
                  onClick={() => {
                    if (dragState.current?.moved) return;
                    if (focusedCode === t.code) {
                      resetView();
                    } else {
                      setFocusedCode(t.code);
                      glideToBounds(t.bounds);
                      setDrawerOpen(true);
                    }
                  }}
                  onMouseEnter={() => !dragging && setHoverCode(t.code)}
                  onMouseLeave={() => setHoverCode(null)}
                >
                  <title>{`${t.name} — ${stat ? `${stat.count} plotted · ${money(stat.leakageUsd)} exposure` : "no prospects plotted"}`}</title>
                </path>
              );
            })}

            {/* lakes — water reads as water against the land ink */}
            {geometry.lakePaths.map((d, i) => (
              <path key={i} d={d} fill="#0E100E" stroke="#222522" strokeWidth={sw(0.6)} pointerEvents="none" />
            ))}

            {/* Module 7 cluster rings — geographic reach on real coastlines */}
            {snap.clusters.map((c) => {
              if (!inNaFrame(c.centroidLat, c.centroidLng)) return null; // non-NA clusters stay off-board
              const p = geometry.projection([c.centroidLng, c.centroidLat]);
              if (!p) return null;
              const [cx, cy] = p;
              const np = geometry.projection([c.centroidLng, c.centroidLat + c.radiusM / 111_320]);
              const rGeo = np ? Math.abs(np[1] - cy) : 20;
              const r = Math.max(rGeo, fs(16)); // display floor; true radius in the readout
              const active = selectedCluster == null || selectedCluster === c.id;
              return (
                <g
                  key={c.id}
                  opacity={active ? 1 : 0.25}
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dragState.current?.moved) return;
                    setSelectedCluster(c.id === selectedCluster ? null : c.id);
                  }}
                >
                  <circle cx={cx} cy={cy} r={r * 1.9} fill="url(#ringGlow)" />
                  <circle cx={cx} cy={cy} r={r} fill="none" stroke="#8E9194" strokeWidth={sw(1.2)} strokeDasharray={`${fs(3)} ${fs(4)}`} />
                  <circle cx={cx} cy={cy} r={fs(3.5)} fill="#F4F5F2" />
                  <text
                    x={cx}
                    y={cy - r - fs(9)}
                    fill={selectedCluster === c.id ? "#F4F5F2" : "#8E9194"}
                    fontSize={fs(10)}
                    fontFamily="JetBrains Mono, monospace"
                    letterSpacing={fs(1.5)}
                    textAnchor="middle"
                    pointerEvents="none"
                  >
                    {c.clusterName.toUpperCase()}
                  </text>
                  <title>{`${c.clusterName} — ${c.memberIds.length} members · ${Math.round(c.radiusM / 1000)}km radius`}</title>
                </g>
              );
            })}

            {/* territory labels — scale-aware: codes while territories are
                small on screen, full names once the zoom earns the room,
                active lens metric as the suffix either way */}
            {geometry.territoryDrawables.map((t) => {
              const stat = census.territoryStats.get(t.code);
              const has = stat != null && stat.count > 0;
              const focused = focusedCode === t.code;
              const hovered = hoverCode === t.code;
              const nameMode = k >= NAME_ZOOM;
              const screenW = (t.bounds[1][0] - t.bounds[0][0]) * k;
              const screenH = (t.bounds[1][1] - t.bounds[0][1]) * k;
              const fits = screenW >= (nameMode ? 110 : 34) && screenH >= 16;
              const visible =
                (has || nameMode || focused || hovered) && (fits || focused) && intersectsViewport(t.bounds, view);
              if (!visible) return null;
              const dimmed = focusedCode != null && !focused;
              const metric = lensMetricLabel(lens, stat, nowMs);
              return (
                <text
                  key={t.code}
                  x={t.label[0]}
                  y={t.label[1]}
                  fill={focused ? "#F4F5F2" : has ? "#8E9194" : "#3F433F"}
                  fontSize={fs(nameMode ? 10 : 9.5)}
                  fontFamily="JetBrains Mono, monospace"
                  letterSpacing={fs(1)}
                  textAnchor="middle"
                  pointerEvents="none"
                  opacity={dimmed ? 0.4 : 1}
                >
                  {focused || nameMode ? `${t.name.toUpperCase()}${metric}` : `${t.code.split("-")[1]}${metric}`}
                </text>
              );
            })}

            {/* pins — the book of business, heat-laddered */}
            {census.plotted.map((lead) => {
              const p = geometry.projection([lead.longitude!, lead.latitude!]);
              if (!p) return null;
              const [x, y] = p;
              const heat = heatLevel(lead.score?.qlvScore ?? null);
              const inCluster = selectedCluster == null || lead.clusterId === selectedCluster;
              const inFocus = focusedCode == null || leadTerritory.get(lead.id) === focusedCode;
              const opacity = inCluster ? (inFocus ? 1 : 0.3) : 0.12;
              const r = (heat === "critical" ? 5.2 : 4.4) / k;
              return (
                <g
                  key={lead.id}
                  opacity={opacity}
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (dragState.current?.moved) return;
                    onOpenDossier(lead);
                  }}
                >
                  {heat === "critical" && (
                    <circle cx={x} cy={y} r={r * 1.6} fill="none" stroke="#F4F5F2" strokeWidth={sw(1)} className="cc-svg-pulse" />
                  )}
                  <circle cx={x} cy={y} r={r} fill={HEAT_FILL[heat]} stroke="#0B0C0B" strokeWidth={sw(1.5)} />
                  <title>{`${lead.name} — QLV ${lead.score?.qlvScore ?? "—"} — ${lead.city ?? "?"} ${lead.stateProvince ?? ""} — ${lead.clusterName ?? "unclustered"}`}</title>
                </g>
              );
            })}
          </g>

          {/* HUD — QLV ladder (fixed, outside the zoom group) */}
          <g fontFamily="JetBrains Mono, monospace" fontSize="9.5" letterSpacing="1" pointerEvents="none">
            <text x={BOARD_W - 46} y={26} fill="#8E9194" textAnchor="end">
              QLV LADDER
            </text>
            {(["critical", "hot", "warm", "cool"] as const).map((h, i) => (
              <g key={h} transform={`translate(${BOARD_W - 256 + i * 56}, 40)`}>
                <circle cx={0} cy={0} r={3.5} fill={HEAT_FILL[h]} />
                <text x={9} y={3.5} fill="#8E9194">
                  {h === "critical" ? "85+" : h === "hot" ? "72+" : h === "warm" ? "50+" : "<50"}
                </text>
              </g>
            ))}
          </g>
        </svg>

        {/* overlay — breadcrumb */}
        <div className="pointer-events-none absolute left-5 top-4 flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8E9194]">
            {focusedCode
              ? `TERRITORY // ${focusedCode} · ${focusedMeta?.name ?? ""} — ${lens.toUpperCase()} LENS`
              : `CONTINENT // US + CANADA — ${lens.toUpperCase()} LENS`}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#3F433F]">
            {k > 1.02 ? `×${k.toFixed(1)} — ESC resets` : "wheel zooms · drag pans · click a territory"}
          </span>
        </div>

        {/* overlay — zoom controls */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-1.5">
          <button
            onClick={() => zoomCenter(1.4)}
            title="Zoom in"
            aria-label="Zoom in"
            className="tactile-btn size-8 bg-[#131513] text-[13px] text-[#C9CCC7] hover:bg-[#222522] hover:text-[#F4F5F2]"
          >
            +
          </button>
          <button
            onClick={() => zoomCenter(1 / 1.4)}
            title="Zoom out"
            aria-label="Zoom out"
            className="tactile-btn size-8 bg-[#131513] text-[13px] text-[#C9CCC7] hover:bg-[#222522] hover:text-[#F4F5F2]"
          >
            −
          </button>
          <button
            onClick={resetView}
            title="Reset view"
            aria-label="Reset view"
            className="tactile-btn size-8 bg-[#131513] text-[13px] text-[#C9CCC7] hover:bg-[#222522] hover:text-[#F4F5F2]"
          >
            ⌂
          </button>
        </div>

        {/* overlay — projection honesty note */}
        <div className="pointer-events-none absolute bottom-4 left-5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-[#333732]">
          Lambert conformal conic · parallels 20°/60° · central meridian 96°W · Natural Earth 10m
        </div>
      </SoftCard>

      {/* readout — the click-driven data layer, directly beneath the board */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <SoftCard className="px-6 py-5">
          {focusedStat && focusedMeta ? (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div>
                <SectionLabel>Focused territory</SectionLabel>
                <p className="mt-1.5 font-display text-[19px] font-semibold tracking-[-0.02em] text-[#F4F5F2]">
                  {focusedStat.name}
                </p>
              </div>
              <div>
                <SectionLabel>Regime</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] text-[#E9EBE7]">
                  {focusedStat.country === "CA" ? "CASL — consent-first" : "CAN-SPAM — opt-out"}
                </p>
              </div>
              <div>
                <SectionLabel>Prospects</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">{focusedStat.count}</p>
              </div>
              <div>
                <SectionLabel>Critical band</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">{focusedStat.critical}</p>
              </div>
              <div>
                <SectionLabel>Avg QLV</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">{focusedStat.avgQlv ?? "—"}</p>
              </div>
              <div>
                <SectionLabel>Exposure</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums font-medium text-[#F4F5F2]">
                  {money(focusedStat.leakageUsd)}
                </p>
              </div>
              {focusedStat.country === "CA" && (
                <div>
                  <SectionLabel>CASL consent</SectionLabel>
                  <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">
                    {focusedStat.caslTrue}/{focusedStat.count} true
                  </p>
                </div>
              )}
              <div>
                <SectionLabel>Last touch</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">
                  {focusedStat.lastTouchMs ? relTime(focusedStat.lastTouchMs, nowMs) : "—"}
                </p>
              </div>
              <div className="self-center">
                <button
                  onClick={() => setDrawerOpen(true)}
                  className="h-8 rounded-full border border-white/[0.14] bg-[#131513] px-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8E9194] transition-colors hover:border-white/30 hover:text-[#F4F5F2]"
                >
                  depth drawer →
                </button>
              </div>
            </div>
          ) : cluster ? (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <div>
                <SectionLabel>Selected theatre</SectionLabel>
                <p className="mt-1.5 font-display text-[19px] font-semibold tracking-[-0.02em] text-[#F4F5F2]">
                  {cluster.clusterName}
                </p>
              </div>
              <div>
                <SectionLabel>Anchor</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] text-[#E9EBE7]">
                  {cluster.anchorCity ?? "—"}, {cluster.anchorCountry ?? "—"}
                </p>
              </div>
              <div>
                <SectionLabel>Density</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">
                  {cluster.memberIds.length} leads · {Math.round(cluster.radiusM / 1000)}km radius
                </p>
              </div>
              <div>
                <SectionLabel>Critical band</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums text-[#E9EBE7]">{cluster.hotCount}</p>
              </div>
              <div>
                <SectionLabel>Leakage at stake</SectionLabel>
                <p className="mt-1.5 font-mono text-[13px] tabular-nums font-medium text-[#F4F5F2]">
                  {money(cluster.leakageUsd)}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed text-[#8E9194]">
              Click a state or province to focus the board — the camera glides to its bounds, the readout arms, and
              pins outside the territory dim. Cluster hooks still localize outreach: &ldquo;we&rsquo;re onboarding two
              PVF distributors in the Gulf Coast corridor this month.&rdquo;
            </p>
          )}
        </SoftCard>
        <SoftCard className="px-6 py-5">
          {focusedStat ? (
            <>
              <SectionLabel className="mb-2">Territory pulse · {focusedStat.name}</SectionLabel>
              <p className="font-display text-[14.5px] leading-relaxed tracking-[-0.01em] text-[#E9EBE7]">
                {topFocusedLead ? (
                  <>
                    Call sheet — {focusedStat.count} account{focusedStat.count === 1 ? "" : "s"} inside{" "}
                    {focusedStat.name}. Lead: {topFocusedLead.name} (QLV {topFocusedLead.score?.qlvScore ?? "—"},{" "}
                    {verticalLabel(topFocusedLead.vertical)}), {money(focusedStat.leakageUsd)} exposure across the
                    territory.
                    {focusedStat.country === "CA" &&
                      ` CASL gate: ${focusedStat.caslTrue} of ${focusedStat.count} consent-true before any mail leaves.`}
                  </>
                ) : (
                  <>No scored accounts yet — run the filter and scorer to arm this territory.</>
                )}
              </p>
            </>
          ) : cluster ? (
            <>
              <SectionLabel className="mb-2">Outreach hook · localized</SectionLabel>
              <p className="font-display text-[14.5px] leading-relaxed tracking-[-0.01em] text-[#E9EBE7]">
                &ldquo;Hey [Name], we&rsquo;re onboarding two {cluster.verticalFocus?.replace(/_/g, " ") ?? "distribution"}{" "}
                companies in the {cluster.clusterName} region this month — worth 15 minutes to see what their quote
                flow looks like?&rdquo;
              </p>
            </>
          ) : (
            <>
              <SectionLabel className="mb-2">Outreach hook · localized</SectionLabel>
              <EmptyHint>Focus a territory or select a cluster to arm the local hook</EmptyHint>
            </>
          )}
        </SoftCard>
      </div>

      {/* members */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#5F6460]">
          {focusedStat ? "territory members:" : cluster ? "cluster members:" : "plotted:"}
        </span>
        {(focusedStat ? focusedMemberLeads : cluster ? clusterLeads : census.plotted).slice(0, 24).map((l) => (
          <Chip
            key={l.id}
            tone={heatLevel(l.score?.qlvScore ?? null) === "critical" ? "inverted" : "outline"}
            className="cursor-pointer"
          >
            <span onClick={() => onOpenDossier(l)}>{l.name}</span>
          </Chip>
        ))}
        {(focusedStat ? focusedMemberLeads.length === 0 : cluster ? clusterLeads.length === 0 : census.plotted.length === 0) && (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#333732]">none on the board</span>
        )}
      </div>

      {/* honest ledger — uncharted / off-board */}
      {(census.uncharted.length > 0 || census.offBoard.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 pb-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#5F6460]">
            uncharted / off-board — {census.uncharted.length + census.offBoard.length}:
          </span>
          {census.uncharted.map((l) => (
            <Chip key={l.id} tone="outline" className="cursor-pointer" >
              <span
                onClick={() => onOpenDossier(l)}
                title={classifyLeadGeo(l).reason}
              >
                {l.name} · no geo
              </span>
            </Chip>
          ))}
          {census.offBoard.map((l) => (
            <Chip key={`ob-${l.id}`} tone="well" className="cursor-pointer">
              <span
                onClick={() => onOpenDossier(l)}
                title={classifyLeadGeo(l).reason}
              >
                {l.name} · {l.country ?? "—"}
              </span>
            </Chip>
          ))}
        </div>
      )}

      {/* pulse — territory movement ledger + call windows (Map-4). The ambient
          tape runs at the foot of the stack: click-driven readouts hug the map,
          the ledger reads as the running log beneath everything else. */}
      <SoftCard className="mt-4 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionLabel>Pulse — territory movement · 48h ledger</SectionLabel>
          <div className="flex items-center gap-3">
            {callWindows.length > 0 && (
              <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#5F6460]">
                {callWindows.filter((x) => x.cw.open).length}/{callWindows.length} call windows open
              </span>
            )}
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#3F433F]">[P] toggles</span>
          </div>
        </div>
        {pulseOpen && (
          <>
            {/* call windows — one chip per territory with plotted leads, sorted by reachability */}
            {callWindows.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {callWindows.slice(0, 10).map(({ code, cw }) => (
                  <button
                    key={code}
                    onClick={() => focusTerritory(code)}
                    title={`${cw.tz} — ${cw.label}`}
                    className={`h-8 rounded-full px-3.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-all ${
                      cw.open
                        ? "border border-white/[0.24] bg-[#1A1D1A] text-[#F4F5F2]"
                        : "border border-white/[0.08] bg-[#131513] text-[#8E9194] hover:text-[#F4F5F2]"
                    }`}
                  >
                    {code.split("-")[1]} <span className="tabular-nums">{cw.clock}</span>
                    {cw.open ? " · open" : ""}
                  </button>
                ))}
                {callWindows.length > 10 && (
                  <span className="self-center font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#3F433F]">
                    +{callWindows.length - 10} more
                  </span>
                )}
              </div>
            )}
            {/* 24h movement — only when the ledger has a real prior window */}
            {pulseSummary.mature && (
              <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8E9194]">
                24h movement —{" "}
                {pulseSummary.deltas
                  .filter((d) => d.last24h > 0)
                  .slice(0, 3)
                  .map((d) => `${d.code.split("-")[1]} ${d.readout}`)
                  .join(" · ") || "quiet board"}
              </p>
            )}
            {/* ticker — the latest entries, scoped to the focused territory */}
            <div className="mt-3 flex flex-col gap-1.5">
              {visiblePulse.length === 0 ? (
                <EmptyHint>
                  No movement in the trailing ledger{focusedCode ? ` for ${focusedCode}` : ""} — the strip stays silent
                  until something actually moves.
                </EmptyHint>
              ) : (
                visiblePulse.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-baseline gap-3 overflow-hidden font-mono text-[11px] leading-relaxed"
                  >
                    <span className="shrink-0 tabular-nums text-[#5F6460]">{relTime(e.atMs, nowMs)}</span>
                    <span className="shrink-0 text-[#8E9194]">{e.territory ?? "——"}</span>
                    <span className="shrink-0 text-[#E9EBE7]">{e.prospectName}</span>
                    <span className="min-w-0 truncate text-[#8E9194]">{e.detail}</span>
                    <span className="ml-auto shrink-0 text-[9px] uppercase tracking-[0.12em] text-[#3F433F]">
                      {e.kind}
                    </span>
                  </div>
                ))
              )}
            </div>
            {focusedCode && (
              <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-[#3F433F]">
                scoped to {focusedCode} — reset the territory to see the whole ledger
              </p>
            )}
          </>
        )}
      </SoftCard>

      {/* L1 depth — the full territory sheet */}
      <TerritoryDrawer
        stat={drawerOpen ? focusedStat : null}
        nowMs={nowMs}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onOpenDossier={onOpenDossier}
        pendingReplies={pendingReplies}
        filterLabel={filter !== "all" ? STRIKE_FILTERS.find(([k]) => k === filter)?.[1] ?? null : null}
        delta={focusedCode ? pulseSummary.deltas.find((d) => d.code === focusedCode) ?? null : null}
        ledgerMature={pulseSummary.mature}
      />
    </div>
  );
}
