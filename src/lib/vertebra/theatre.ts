/**
 * Theatre map engine — pure geography + territory math for the US + Canada
 * spatial board. No React, no DB: the view component feeds it a CommandSnapshot
 * and the geometry bundle, it returns everything drawable — including the six
 * lens ramps and the URL codec that makes the whole board state deep-linkable.
 *
 * Projection: Lambert Conformal Conic on the ESRI "North America Lambert"
 * parameters (central meridian -96, standard parallels 20/60) — the canonical
 * conic for continental US + Canada. Geometry is bundled at build time from
 * Natural Earth 10m admin-1 (public domain); nothing is fetched beyond the
 * enclave's own static assets.
 */

import { geoConicConformal, geoContains, geoGraticule, geoPath, type GeoProjection } from "d3-geo";
import { classifyLeadGeo, TERRITORY_BY_CODE } from "./geo";
import { money, relTime } from "./command";
import type { CommandLead } from "./command";

// --------------------------------------------------------------------------- #
// Geometry bundle types (public/geo/*.json)
// --------------------------------------------------------------------------- #

export interface TerritoryFeature {
  type: "Feature";
  properties: {
    code: string; // "US-TX"
    name: string; // "Texas"
    country: "US" | "CA";
    postal: string; // "TX"
    type: string; // "State" | "Province" | "Territory" | "District"
    labelPos: [number, number]; // [lng, lat] — representative interior point
  };
  geometry: { type: string; coordinates: unknown };
}

export interface LakeFeature {
  type: "Feature";
  properties: { name: string };
  geometry: { type: string; coordinates: unknown };
}

export interface GeoBundle {
  territories: { features: TerritoryFeature[] };
  lakes: { features: LakeFeature[] };
}

let bundleCache: Promise<GeoBundle | null> | null = null;

/** Load the bundled NA geometry once per session; null on failure. */
export function loadGeoBundle(): Promise<GeoBundle | null> {
  bundleCache ??= Promise.all([
    fetch("/geo/us-ca-territories.json").then((r) => r.json()),
    fetch("/geo/na-lakes.json").then((r) => r.json()).catch(() => ({ features: [] })),
  ])
    .then(([territories, lakes]: [{ features: TerritoryFeature[] }, { features: LakeFeature[] }]) => ({
      territories,
      lakes,
    }))
    .catch(() => {
      bundleCache = null; // allow retry on next mount
      return null;
    });
  return bundleCache;
}

// --------------------------------------------------------------------------- #
// Projection + precomputed drawable geometry
// --------------------------------------------------------------------------- #

export const BOARD_W = 1200;
export const BOARD_H = 640;
export const BOARD_PAD = 46;

/**
 * Territories excluded from the initial frame fit (not from rendering):
 * the arctic giants and Hawaii would stretch the default view into mostly
 * empty tundra. They remain fully clickable and reachable by pan/zoom.
 */
const FIT_EXCLUDE = new Set(["US-AK", "US-HI", "CA-YT", "CA-NT", "CA-NU"]);

export interface TerritoryDrawable {
  code: string;
  name: string;
  country: "US" | "CA";
  type: string;
  d: string; // svg path
  bounds: [[number, number], [number, number]]; // projected local bounds
  label: [number, number]; // projected label anchor
}

export interface BoardGeometry {
  projection: GeoProjection;
  territoryDrawables: TerritoryDrawable[];
  lakePaths: string[];
  graticulePath: string;
}

export function buildBoardGeometry(bundle: GeoBundle): BoardGeometry {
  const projection = geoConicConformal()
    .parallels([20, 60])
    .rotate([96, 0])
    .fitExtent(
      [
        [BOARD_PAD, BOARD_PAD],
        [BOARD_W - BOARD_PAD, BOARD_H - BOARD_PAD],
      ],
      {
        type: "FeatureCollection",
        features: bundle.territories.features.filter((f) => !FIT_EXCLUDE.has(f.properties.code)),
      } as never,
    );

  const path = geoPath(projection);

  const territoryDrawables: TerritoryDrawable[] = bundle.territories.features.map((f) => {
    const label = projection(f.properties.labelPos);
    return {
      code: f.properties.code,
      name: f.properties.name,
      country: f.properties.country,
      type: f.properties.type,
      d: path(f as never) ?? "",
      bounds: path.bounds(f as never),
      label: label ? [label[0], label[1]] : [0, 0],
    };
  });

  const lakePaths = bundle.lakes.features.map((f) => path(f as never) ?? "").filter(Boolean);

  const graticule = geoGraticule().step([10, 10]).extent([
    [-180, 13],
    [-48, 85],
  ]);
  const graticulePath = path(graticule()) ?? "";

  return { projection, territoryDrawables, lakePaths, graticulePath };
}

// --------------------------------------------------------------------------- #
// Lead → territory resolution + aggregate stats
// --------------------------------------------------------------------------- #

/**
 * geoContains-backed territory resolution against the raw bundle features.
 * Text normalization is primary (the backfill canonicalizes stateProvince);
 * point-in-polygon over the real geometry is the fallback for messy or
 * missing text. Memoized by rounded coordinates — pins share city centroids.
 */
export function makeTerritoryResolver(bundle: GeoBundle) {
  const memo = new Map<string, string | null>();
  return (lead: CommandLead): string | null => {
    const cls = classifyLeadGeo(lead);
    if (cls.territory) return cls.territory.code;
    if (lead.latitude == null || lead.longitude == null) return null;
    const key = `${lead.latitude.toFixed(3)},${lead.longitude.toFixed(3)}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    let hit: string | null = null;
    for (const f of bundle.territories.features) {
      if (geoContains(f as never, [lead.longitude, lead.latitude])) {
        hit = f.properties.code;
        break;
      }
    }
    memo.set(key, hit);
    return hit;
  };
}

export interface TerritoryStat {
  code: string;
  name: string;
  country: "US" | "CA";
  type: string;
  count: number;
  critical: number;
  leakageUsd: number;
  avgQlv: number | null;
  caslTrue: number;
  inSequence: number;
  lastTouchMs: number | null;
  /** Mail funnel — dispatch status distribution across the territory. */
  mailQueued: number;
  mailStaged: number;
  mailSent: number;
  mailFailed: number;
  /** Trailing-48h telemetry events summed across the territory (MOMENTUM lens). */
  telemetryEvents48h: number;
  lastTelemetryMs: number | null;
  leads: CommandLead[];
}

export interface BoardCensus {
  plotted: CommandLead[];
  uncharted: CommandLead[];
  offBoard: CommandLead[];
  territoryStats: Map<string, TerritoryStat>;
  maxTerritoryCount: number;
  totalPlottedLeakageUsd: number;
  /** Per-lens maxima — the ramps normalize against these. */
  maxLeakageUsd: number;
  maxMomentum48h: number;
  maxMailVolume: number;
}

/** Classify every lead for the board and aggregate per-territory stats. */
export function censusBoard(leads: CommandLead[], resolver: (lead: CommandLead) => string | null): BoardCensus {
  const plotted: CommandLead[] = [];
  const uncharted: CommandLead[] = [];
  const offBoard: CommandLead[] = [];
  const stats = new Map<string, TerritoryStat>();

  for (const lead of leads) {
    const cls = classifyLeadGeo(lead);
    if (cls.status === "uncharted") {
      uncharted.push(lead);
      continue;
    }
    if (cls.status === "off_board") {
      offBoard.push(lead);
      continue;
    }
    plotted.push(lead);
    const code = resolver(lead);
    if (!code) continue;

    const meta = TERRITORY_BY_CODE[code];
    if (!meta) continue;

    let stat = stats.get(code);
    if (!stat) {
      stat = {
        code,
        name: meta.name,
        country: meta.country,
        type: meta.type,
        count: 0,
        critical: 0,
        leakageUsd: 0,
        avgQlv: null,
        caslTrue: 0,
        inSequence: 0,
        lastTouchMs: null,
        mailQueued: 0,
        mailStaged: 0,
        mailSent: 0,
        mailFailed: 0,
        telemetryEvents48h: 0,
        lastTelemetryMs: null,
        leads: [],
      };
      stats.set(code, stat);
    }

    stat.count += 1;
    stat.leads.push(lead);
    const qlv = lead.score?.qlvScore ?? null;
    if (qlv != null && qlv >= 85) stat.critical += 1;
    stat.leakageUsd += lead.leakageUsd ?? 0;
    if (lead.caslScope) stat.caslTrue += 1;
    if (lead.dispatch != null) stat.inSequence += 1;
    switch (lead.dispatch?.status) {
      case "staged": stat.mailStaged += 1; break;
      case "sent": stat.mailSent += 1; break;
      case "failed": stat.mailFailed += 1; break;
      case "queued": stat.mailQueued += 1; break;
    }
    stat.telemetryEvents48h += lead.telemetry?.events48h ?? 0;
    const lastTel = lead.telemetry?.lastEventAtMs ?? null;
    if (lastTel != null) stat.lastTelemetryMs = Math.max(stat.lastTelemetryMs ?? 0, lastTel);
    const touch = Math.max(lead.lastActionAtMs ?? 0, lead.telemetry?.lastEventAtMs ?? 0);
    if (touch > 0) stat.lastTouchMs = Math.max(stat.lastTouchMs ?? 0, touch);
  }

  // average QLV per territory (single pass at the end)
  for (const stat of stats.values()) {
    const scored = stat.leads.map((l) => l.score?.qlvScore).filter((x): x is number => x != null);
    stat.avgQlv = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  }

  const allStats = Array.from(stats.values());
  return {
    plotted,
    uncharted,
    offBoard,
    territoryStats: stats,
    maxTerritoryCount: Math.max(1, ...allStats.map((s) => s.count)),
    totalPlottedLeakageUsd: plotted.reduce((s, l) => s + (l.leakageUsd ?? 0), 0),
    maxLeakageUsd: Math.max(1, ...allStats.map((s) => s.leakageUsd)),
    maxMomentum48h: Math.max(1, ...allStats.map((s) => s.telemetryEvents48h)),
    maxMailVolume: Math.max(
      1,
      ...allStats.map((s) => s.mailQueued + s.mailStaged + s.mailSent + s.mailFailed),
    ),
  };
}

// --------------------------------------------------------------------------- #
// Lenses — one territory metric per board state, luminance never chroma
// --------------------------------------------------------------------------- #

export type LensId =
  | "concentration"
  | "momentum"
  | "exposure"
  | "cadence"
  | "compliance"
  | "mail";

export interface LensDef {
  id: LensId;
  label: string;
  hint: string;
  /** "live" lenses shade the board; "planned" stay inert until they can read real data. */
  status: "live" | "planned";
}

/** All six armed — every one reads a metric the snapshot actually carries. */
export const LENSES: readonly LensDef[] = [
  { id: "concentration", label: "CONCENTRATION", hint: "accounts per territory", status: "live" },
  { id: "momentum", label: "MOMENTUM", hint: "telemetry events / 48h — brighter = hotter feed", status: "live" },
  { id: "exposure", label: "EXPOSURE", hint: "leakage at stake — brighter = more exposure", status: "live" },
  { id: "cadence", label: "CADENCE", hint: "touch recency — brighter = fresher", status: "live" },
  { id: "compliance", label: "COMPLIANCE", hint: "CASL consent gaps — brighter = more unresolved", status: "live" },
  { id: "mail", label: "MAIL", hint: "funnel volume — staged / sent / failed", status: "live" },
] as const;

/** Board-level maxima + clock the lens ramps normalize against. */
export interface LensExtremes {
  maxCount: number;
  maxLeakageUsd: number;
  maxMomentum48h: number;
  maxMailVolume: number;
  nowMs: number;
}

const BASE_FILL = "#161816";
const BASE_HOVER = "#181A18";
const BASE_FOCUS = "#1A1D1A";

/** Luminance ink — one grey ramp for every lens; chroma never enters the board. */
function ramp(alpha: number, focused: boolean, hover: boolean): string {
  const a = Math.min(0.3, alpha + (focused ? 0.06 : hover ? 0.03 : 0));
  return `rgba(244,245,242,${a.toFixed(3)})`;
}

/**
 * Territory fill for the active lens. Every ramp is sqrt-eased luminance over
 * a metric the snapshot really carries; territories with nothing to measure
 * stay on the base fill, so the board never fakes intensity it cannot read.
 */
export function lensFill(
  lens: LensId,
  stat: TerritoryStat | undefined,
  ext: LensExtremes,
  focused: boolean,
  hover: boolean,
): string {
  if (!stat || stat.count === 0) return focused ? BASE_FOCUS : hover ? BASE_HOVER : BASE_FILL;
  switch (lens) {
    case "concentration": {
      const t = Math.sqrt(stat.count / Math.max(1, ext.maxCount));
      return ramp(0.05 + 0.13 * t, focused, hover);
    }
    case "momentum": {
      const t = Math.sqrt(Math.min(1, stat.telemetryEvents48h / Math.max(1, ext.maxMomentum48h)));
      let alpha = 0.05 + 0.14 * t;
      // a live board deserves a live tell — territory pinged within the hour
      if (stat.lastTelemetryMs != null && ext.nowMs - stat.lastTelemetryMs <= 3_600_000) alpha += 0.03;
      return ramp(alpha, focused, hover);
    }
    case "exposure": {
      const t = Math.sqrt(Math.min(1, stat.leakageUsd / Math.max(1, ext.maxLeakageUsd)));
      return ramp(0.05 + 0.14 * t, focused, hover);
    }
    case "cadence": {
      if (stat.lastTouchMs == null) return ramp(0.02, focused, hover);
      const days = (ext.nowMs - stat.lastTouchMs) / 86_400_000;
      // discrete buckets — cadence is a clock, not a continuum
      const alpha = days <= 3 ? 0.19 : days <= 10 ? 0.14 : days <= 30 ? 0.09 : days <= 90 ? 0.05 : 0.03;
      return ramp(alpha, focused, hover);
    }
    case "compliance": {
      if (stat.country === "CA") {
        const unresolved = (stat.count - stat.caslTrue) / stat.count;
        return ramp(0.04 + 0.13 * unresolved, focused, hover);
      }
      // CAN-SPAM opt-out jurisdiction — consent debt is structurally lower,
      // and the board refuses to invent a US risk ramp it cannot measure
      return ramp(0.04, focused, hover);
    }
    case "mail": {
      const vol = stat.mailQueued + stat.mailStaged + stat.mailSent + stat.mailFailed;
      if (vol === 0) return ramp(0.02, focused, hover);
      const t = Math.sqrt(Math.min(1, vol / Math.max(1, ext.maxMailVolume)));
      return ramp(0.05 + 0.12 * t + (stat.mailFailed > 0 ? 0.05 : 0), focused, hover);
    }
  }
}

/** Compact per-territory suffix for the label ink under the active lens. */
export function lensMetricLabel(lens: LensId, stat: TerritoryStat | undefined, nowMs: number): string {
  if (!stat || stat.count === 0) return "";
  switch (lens) {
    case "concentration":
      return `·${stat.count}`;
    case "momentum":
      return stat.telemetryEvents48h > 0 ? `·${stat.telemetryEvents48h}ev` : "";
    case "exposure":
      return stat.leakageUsd > 0 ? `·${money(stat.leakageUsd)}` : "";
    case "cadence": {
      if (stat.lastTouchMs == null) return "";
      const d = Math.floor((nowMs - stat.lastTouchMs) / 86_400_000);
      return d < 1 ? "·<1d" : `·${d}d`;
    }
    case "compliance":
      return stat.country === "CA" ? `·${stat.caslTrue}/${stat.count}` : "";
    case "mail": {
      const q = stat.mailQueued;
      if (q + stat.mailStaged + stat.mailSent + stat.mailFailed === 0) return "";
      // queued-only funnels read as queued — never as a fake zero triple
      if (stat.mailStaged + stat.mailSent + stat.mailFailed === 0) return `·${q}q`;
      return `·${stat.mailStaged}s/${stat.mailSent}x/${stat.mailFailed}f${q > 0 ? `+${q}q` : ""}`;
    }
  }
}

/** The territory that leads the active metric, phrased for the caption line. */
export function lensLeader(
  lens: LensId,
  stats: TerritoryStat[],
  nowMs: number,
): { code: string; name: string; readout: string } | null {
  let best: TerritoryStat | null = null;
  for (const s of stats) {
    if (s.count === 0) continue;
    if (best == null) {
      best = s;
      continue;
    }
    switch (lens) {
      case "concentration":
        if (s.count > best.count) best = s;
        break;
      case "momentum":
        if (s.telemetryEvents48h > best.telemetryEvents48h) best = s;
        break;
      case "exposure":
        if (s.leakageUsd > best.leakageUsd) best = s;
        break;
      case "cadence":
        if ((s.lastTouchMs ?? -Infinity) > (best.lastTouchMs ?? -Infinity)) best = s;
        break;
      case "compliance": {
        const gaps = (t: TerritoryStat) => (t.country === "CA" ? t.count - t.caslTrue : 0);
        if (gaps(s) > gaps(best)) best = s;
        break;
      }
      case "mail": {
        const vol = (t: TerritoryStat) => t.mailQueued + t.mailStaged + t.mailSent + t.mailFailed;
        if (vol(s) > vol(best)) best = s;
        break;
      }
    }
  }
  if (!best) return null;
  const readout =
    lens === "concentration"
      ? `${best.count} accounts`
      : lens === "momentum"
        ? `${best.telemetryEvents48h} events / 48h`
        : lens === "exposure"
          ? `${money(best.leakageUsd)} at stake`
          : lens === "cadence"
            ? best.lastTouchMs != null
              ? `touched ${relTime(best.lastTouchMs, nowMs)}`
              : "untouched"
            : lens === "compliance"
              ? best.country === "CA"
                ? `${best.count - best.caslTrue} consent gaps`
                : "opt-out regime"
              : `${best.mailStaged} staged · ${best.mailSent} sent · ${best.mailFailed} failed`;
  return { code: best.code, name: best.name, readout };
}

// --------------------------------------------------------------------------- #
// Deep link — the whole board state survives a copy/paste of the URL
// --------------------------------------------------------------------------- #

export interface BoardUrlState {
  lens: LensId;
  territory: string | null;
  cluster: string | null;
  /** Camera; null = identity frame. */
  view: { k: number; x: number; y: number } | null;
}

const URL_K_MAX = 18; // keep in lock-step with MAX_K in the view

export function encodeBoardState(s: BoardUrlState): string {
  const p = new URLSearchParams();
  if (s.lens !== "concentration") p.set("tl", s.lens);
  if (s.territory) p.set("tt", s.territory);
  if (s.cluster) p.set("tc", s.cluster);
  if (s.view && (s.view.k !== 1 || s.view.x !== 0 || s.view.y !== 0)) {
    p.set("tk", s.view.k.toFixed(2));
    p.set("tx", String(Math.round(s.view.x)));
    p.set("ty", String(Math.round(s.view.y)));
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}

export function parseBoardState(search: string | null | undefined): BoardUrlState {
  const out: BoardUrlState = { lens: "concentration", territory: null, cluster: null, view: null };
  if (!search) return out;
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return out;
  }
  const tl = p.get("tl");
  if (tl && LENSES.some((l) => l.id === tl)) out.lens = tl as LensId;
  out.territory = p.get("tt");
  out.cluster = p.get("tc");
  const k = parseFloat(p.get("tk") ?? "");
  if (Number.isFinite(k) && k > 1) {
    out.view = {
      k: Math.min(URL_K_MAX, k),
      x: parseFloat(p.get("tx") ?? "0") || 0,
      y: parseFloat(p.get("ty") ?? "0") || 0,
    };
  }
  return out;
}
