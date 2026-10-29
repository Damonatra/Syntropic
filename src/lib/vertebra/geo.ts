/**
 * Theatre geography — territory normalization for the US + Canada board.
 *
 * Pure logic only: no DB, no React, no geometry files. The map client and
 * the backfill scripts both lean on this module so that free-text
 * stateProvince/country entries ("Texas", "tx", "Tenn.", "Québec", "NWT")
 * resolve to one canonical territory code ("US-TX") everywhere.
 *
 * Scope is deliberate: 50 US states + DC and the 10 Canadian provinces +
 * 3 territories. Nothing else resolves — non-US/CA prospects are honestly
 * classified off-board by the caller, never force-fitted onto the map.
 */

import { CITY_CENTROID_DATA } from "./geo-cities";

export type CountryCode = "US" | "CA";

export interface TerritoryMeta {
  code: string; // "US-TX" | "CA-ON"
  name: string; // "Texas" | "Ontario"
  country: CountryCode;
  postal: string; // "TX" | "ON"
  type: "State" | "Province" | "Territory" | "District";
}

function t(code: string, name: string, type: TerritoryMeta["type"]): TerritoryMeta {
  const [country, postal] = code.split("-");
  return { code, name, country: country as CountryCode, postal, type };
}

/** The 64 theatres of operation — the complete scope of the board. */
export const TERRITORIES: readonly TerritoryMeta[] = [
  t("US-AL", "Alabama", "State"),
  t("US-AK", "Alaska", "State"),
  t("US-AZ", "Arizona", "State"),
  t("US-AR", "Arkansas", "State"),
  t("US-CA", "California", "State"),
  t("US-CO", "Colorado", "State"),
  t("US-CT", "Connecticut", "State"),
  t("US-DE", "Delaware", "State"),
  t("US-DC", "District of Columbia", "District"),
  t("US-FL", "Florida", "State"),
  t("US-GA", "Georgia", "State"),
  t("US-HI", "Hawaii", "State"),
  t("US-ID", "Idaho", "State"),
  t("US-IL", "Illinois", "State"),
  t("US-IN", "Indiana", "State"),
  t("US-IA", "Iowa", "State"),
  t("US-KS", "Kansas", "State"),
  t("US-KY", "Kentucky", "State"),
  t("US-LA", "Louisiana", "State"),
  t("US-ME", "Maine", "State"),
  t("US-MD", "Maryland", "State"),
  t("US-MA", "Massachusetts", "State"),
  t("US-MI", "Michigan", "State"),
  t("US-MN", "Minnesota", "State"),
  t("US-MS", "Mississippi", "State"),
  t("US-MO", "Missouri", "State"),
  t("US-MT", "Montana", "State"),
  t("US-NE", "Nebraska", "State"),
  t("US-NV", "Nevada", "State"),
  t("US-NH", "New Hampshire", "State"),
  t("US-NJ", "New Jersey", "State"),
  t("US-NM", "New Mexico", "State"),
  t("US-NY", "New York", "State"),
  t("US-NC", "North Carolina", "State"),
  t("US-ND", "North Dakota", "State"),
  t("US-OH", "Ohio", "State"),
  t("US-OK", "Oklahoma", "State"),
  t("US-OR", "Oregon", "State"),
  t("US-PA", "Pennsylvania", "State"),
  t("US-RI", "Rhode Island", "State"),
  t("US-SC", "South Carolina", "State"),
  t("US-SD", "South Dakota", "State"),
  t("US-TN", "Tennessee", "State"),
  t("US-TX", "Texas", "State"),
  t("US-UT", "Utah", "State"),
  t("US-VT", "Vermont", "State"),
  t("US-VA", "Virginia", "State"),
  t("US-WA", "Washington", "State"),
  t("US-WV", "West Virginia", "State"),
  t("US-WI", "Wisconsin", "State"),
  t("US-WY", "Wyoming", "State"),
  t("CA-AB", "Alberta", "Province"),
  t("CA-BC", "British Columbia", "Province"),
  t("CA-MB", "Manitoba", "Province"),
  t("CA-NB", "New Brunswick", "Province"),
  t("CA-NL", "Newfoundland and Labrador", "Province"),
  t("CA-NS", "Nova Scotia", "Province"),
  t("CA-NT", "Northwest Territories", "Territory"),
  t("CA-NU", "Nunavut", "Territory"),
  t("CA-ON", "Ontario", "Province"),
  t("CA-PE", "Prince Edward Island", "Province"),
  t("CA-QC", "Québec", "Province"),
  t("CA-SK", "Saskatchewan", "Province"),
  t("CA-YT", "Yukon", "Territory"),
];

export const TERRITORY_BY_CODE: Readonly<Record<string, TerritoryMeta>> = Object.fromEntries(
  TERRITORIES.map((x) => [x.code, x]),
);

// --------------------------------------------------------------------------- #
// Normalization helpers
// --------------------------------------------------------------------------- #

export function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** lowercase · diacritic-free · collapsed whitespace · trailing periods gone */
function cleanKey(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim();
}

const COUNTRY_ALIASES: Readonly<Record<string, CountryCode>> = {
  us: "US", usa: "US", "u.s": "US", "u.s.a": "US", america: "US",
  "united states": "US", "united states of america": "US",
  ca: "CA", can: "CA", canada: "CA",
};

export function normalizeCountry(raw: string | null | undefined): CountryCode | null {
  if (!raw) return null;
  return COUNTRY_ALIASES[cleanKey(raw)] ?? null;
}

// Alias table: canonical names + postal codes + common variants.
// Built so that "TX", "tx", "Texas", "texas", "Tex." all resolve.
const TERRITORY_ALIASES: Readonly<Record<string, string>> = (() => {
  const m: Record<string, string> = {};
  for (const x of TERRITORIES) {
    m[x.postal.toLowerCase()] = x.code;
    m[cleanKey(x.name)] = x.code;
  }
  const variants: Record<string, string> = {
    // US postal-period and abbreviation forms
    "new york city": "US-NY", cali: "US-CA", calif: "US-CA", penn: "US-PA",
    mass: "US-MA", conn: "US-CT", fla: "US-FL", tex: "US-TX", tenn: "US-TN",
    colo: "US-CO", ariz: "US-AZ", okla: "US-OK", wash: "US-WA", wis: "US-WI",
    mich: "US-MI", minn: "US-MN", ore: "US-OR", ill: "US-IL", ind: "US-IN",
    "washington dc": "US-DC", "washington d.c": "US-DC", "d.c": "US-DC",
    // Canadian variants (accent-free keys after diacritic strip)
    quebec: "CA-QC", pq: "CA-QC", newfoundland: "CA-NL",
    "newfoundland & labrador": "CA-NL", "north west territories": "CA-NT",
    nwt: "CA-NT", "n.w.t": "CA-NT", "yukon territory": "CA-YT",
    "prince edward is": "CA-PE", pei: "CA-PE", "p.e.i": "CA-PE",
  };
  Object.assign(m, variants);
  return m;
})();

/**
 * Resolve free-text country + stateProvince to a canonical territory.
 * Region ("us" / "ca" / "intl_expansion") is an optional extra hint.
 */
export function normalizeTerritory(
  country: string | null | undefined,
  stateProvince: string | null | undefined,
  region?: string | null,
): TerritoryMeta | null {
  const key = stateProvince ? cleanKey(stateProvince) : "";
  if (!key) return null;

  const direct = TERRITORY_ALIASES[key.replace(/\./g, "")] ?? TERRITORY_ALIASES[key];
  if (direct) {
    const meta = TERRITORY_BY_CODE[direct];
    const hint = normalizeCountry(country) ?? normalizeCountry(region);
    // Trust the alias unless the country hint contradicts it — e.g. an
    // Ontario row whose country was fat-fingered as "United States".
    if (!hint || hint === meta.country) return meta;
    // Contradiction: try the hint's side of the alias table first.
    const hinted = TERRITORIES.find((x) => x.country === hint && x.postal.toLowerCase() === key);
    return hinted ?? meta;
  }
  return null;
}

// --------------------------------------------------------------------------- #
// City centroid fallback (deterministic, offline — no geocoder egress)
// --------------------------------------------------------------------------- #

export interface CityCentroid {
  lat: number;
  lng: number;
  code: string; // territory code
}

const CITY_INDEX: Readonly<Record<string, CityCentroid[]>> = (() => {
  const m: Record<string, CityCentroid[]> = {};
  for (const [key, code, lat, lng] of CITY_CENTROID_DATA) {
    (m[key] ??= []).push({ lat, lng, code });
  }
  return m;
})();

/**
 * Deterministic city centroid, disambiguated by country hint when the
 * city key carries both a US and a Canadian entry (richmond, cambridge).
 */
export function cityCentroid(
  city: string | null | undefined,
  country: CountryCode | null,
): CityCentroid | null {
  if (!city) return null;
  const entries = CITY_INDEX[cleanKey(city)];
  if (!entries || entries.length === 0) return null;
  if (country) {
    const match = entries.find((e) => TERRITORY_BY_CODE[e.code]?.country === country);
    if (match) return match;
    return null; // city known, wrong country — refuse to guess across borders
  }
  return entries[0];
}

// --------------------------------------------------------------------------- #
// The North America frame — anything outside is off-board, by doctrine
// --------------------------------------------------------------------------- #

export const NA_FRAME = {
  lngMin: -180,
  lngMax: -49,
  latMin: 14,
  latMax: 84,
} as const;

export function inNaFrame(lat: number, lng: number): boolean {
  return (
    lat >= NA_FRAME.latMin && lat <= NA_FRAME.latMax && lng >= NA_FRAME.lngMin && lng <= NA_FRAME.lngMax
  );
}

export type LeadGeoStatus = "plotted" | "uncharted" | "off_board";

export interface LeadGeoClassification {
  status: LeadGeoStatus;
  territory: TerritoryMeta | null;
  reason: string;
}

/**
 * Classify a lead's geography for the board. Pure and total:
 *  - plotted     — coordinates inside the US+CA frame (territory when known)
 *  - uncharted   — no coordinates at all; the tray claims it
 *  - off_board   — coordinates outside the frame (e.g. East Africa expansion)
 */
export function classifyLeadGeo(input: {
  country: string | null;
  stateProvince: string | null;
  region?: string | null;
  latitude: number | null;
  longitude: number | null;
}): LeadGeoClassification {
  const territory = normalizeTerritory(input.country, input.stateProvince, input.region);
  const { latitude: lat, longitude: lng } = input;

  if (lat == null || lng == null) {
    return {
      status: "uncharted",
      territory,
      reason: territory ? "no coordinates on file" : "no coordinates · territory unresolved",
    };
  }
  if (!inNaFrame(lat, lng)) {
    return {
      status: "off_board",
      territory,
      reason: `outside the US + Canada frame (${lat.toFixed(2)}, ${lng.toFixed(2)})`,
    };
  }
  return {
    status: "plotted",
    territory,
    reason: territory ? territory.name : "coordinates in frame · territory unresolved",
  };
}
