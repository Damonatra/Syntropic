/**
 * Theatre map engine — pure geography + territory math for the US + Canada
 * spatial board. No React, no DB: the view component feeds it a CommandSnapshot
 * and the geometry bundle, it returns everything drawable.
 *
 * Projection: Lambert Conformal Conic on the ESRI "North America Lambert"
 * parameters (central meridian -96, standard parallels 20/60) — the canonical
 * conic for continental US + Canada. Geometry is bundled at build time from
 * Natural Earth 10m admin-1 (public domain); nothing is fetched beyond the
 * enclave's own static assets.
 */

import { geoConicConformal, geoContains, geoGraticule, geoPath, type GeoProjection } from "d3-geo";
import { classifyLeadGeo, TERRITORY_BY_CODE } from "./geo";
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
  leads: CommandLead[];
}

export interface BoardCensus {
  plotted: CommandLead[];
  uncharted: CommandLead[];
  offBoard: CommandLead[];
  territoryStats: Map<string, TerritoryStat>;
  maxTerritoryCount: number;
  totalPlottedLeakageUsd: number;
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
    const touch = Math.max(lead.lastActionAtMs ?? 0, lead.telemetry?.lastEventAtMs ?? 0);
    if (touch > 0) stat.lastTouchMs = Math.max(stat.lastTouchMs ?? 0, touch);
  }

  // average QLV per territory (single pass at the end)
  for (const stat of stats.values()) {
    const scored = stat.leads.map((l) => l.score?.qlvScore).filter((x): x is number => x != null);
    stat.avgQlv = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  }

  return {
    plotted,
    uncharted,
    offBoard,
    territoryStats: stats,
    maxTerritoryCount: Math.max(1, ...Array.from(stats.values()).map((s) => s.count)),
    totalPlottedLeakageUsd: plotted.reduce((s, l) => s + (l.leakageUsd ?? 0), 0),
  };
}
