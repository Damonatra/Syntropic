/**
 * Firmographic classification — TypeScript parity with
 * `vertebra/ingestion/normalizer.py` + `vertebra/enrichment/casl.py`.
 * The console runs the same rules the Python engine enforces in production.
 */

export const VERTICALS = ["pvf", "electrical", "hvac", "fluid_power"] as const;
export type Vertical = (typeof VERTICALS)[number];
export type Region = "us" | "ca";

export const REVENUE_FLOOR_USD = 10_000_000;
export const REVENUE_CEILING_USD = 150_000_000;

const VERTICAL_KEYWORDS: Record<Vertical, string[]> = {
  pvf: ["pipe", "valve", "fitting", "pvf", "flange", "industrial piping", "plumbing wholesale"],
  electrical: ["electrical", "electric supply", "electric distributor", "wire & cable", "switchgear", "conduit"],
  hvac: ["hvac", "heating", "ventilation", "air conditioning", "refrigeration", "hydronics", "boiler", "ductwork"],
  fluid_power: ["fluid power", "hydraulic", "pneumatic", "motion control", "bearings & power transmission", "compressor"],
};

const VERTICAL_PRIORITY: Vertical[] = ["pvf", "fluid_power", "hvac", "electrical"];

const CA_PROVINCES = new Set([
  "alberta", "british columbia", "manitoba", "new brunswick", "newfoundland", "newfoundland and labrador",
  "nova scotia", "ontario", "prince edward island", "quebec", "saskatchewan", "yukon",
  "northwest territories", "nunavut",
]);
const CA_PROVINCE_CODES = new Set(["ab", "bc", "mb", "nb", "nl", "ns", "nt", "nu", "on", "pe", "qc", "sk", "yt"]);
const US_STATE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la",
  "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
]);
const CA_POSTAL_RE = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;

export function classifyVertical(...texts: (string | null | undefined)[]): Vertical | null {
  const blob = texts.filter(Boolean).join(" ").toLowerCase();
  if (!blob.trim()) return null;
  for (const vertical of VERTICAL_PRIORITY) {
    if (VERTICAL_KEYWORDS[vertical].some((kw) => blob.includes(kw))) return vertical;
  }
  return null;
}

export function detectRegion(input: {
  stateProvince?: string | null;
  country?: string | null;
  postalCode?: string | null;
  domain?: string | null;
}): Region | null {
  const prov = (input.stateProvince ?? "").trim().toLowerCase();
  const country = (input.country ?? "").trim().toLowerCase();
  if (["canada", "ca", "can"].includes(country) || CA_PROVINCES.has(prov) || CA_PROVINCE_CODES.has(prov)) return "ca";
  if (["usa", "us", "united states", "united states of america"].includes(country) || US_STATE_CODES.has(prov)) return "us";
  if (input.postalCode && CA_POSTAL_RE.test(input.postalCode)) return "ca";
  if (input.domain && input.domain.toLowerCase().endsWith(".ca")) return "ca";
  return null;
}

export function isCanadianDomain(domain: string | null | undefined): boolean {
  return Boolean(domain && domain.toLowerCase().endsWith(".ca"));
}

export function evaluateCaslScope(input: {
  domain?: string | null;
  region?: Region | null;
  stateProvince?: string | null;
  country?: string | null;
}): { scope: boolean; reason: string | null } {
  if (isCanadianDomain(input.domain)) return { scope: true, reason: "ca_domain" };
  if (input.country && ["canada", "ca", "can"].includes(input.country.trim().toLowerCase()))
    return { scope: true, reason: "ca_country" };
  if (input.region === "ca") return { scope: true, reason: "ca_region" };
  const prov = (input.stateProvince ?? "").trim().toLowerCase();
  if (prov && CA_PROVINCES.has(prov)) return { scope: true, reason: "ca_province" };
  return { scope: false, reason: null };
}

const REV_PER_EMPLOYEE: Record<Vertical | "default", [number, number]> = {
  pvf: [450_000, 1_100_000],
  electrical: [550_000, 1_300_000],
  hvac: [400_000, 950_000],
  fluid_power: [400_000, 1_000_000],
  default: [400_000, 1_200_000],
};

export function estimateRevenue(employeeCount: number | null, vertical: Vertical | null): number | null {
  if (!employeeCount || employeeCount < 1) return null;
  const [lowPer, highPer] = REV_PER_EMPLOYEE[vertical ?? "default"];
  return Math.round((employeeCount * lowPer + employeeCount * highPer) / 2);
}

export interface CorridorInput {
  vertical: Vertical | null;
  revenueEstimateUsd: number | null;
  employeeCount: number | null;
}

export function corridorCheck(input: CorridorInput): { accepted: boolean; reason: string | null } {
  if (!input.vertical) return { accepted: false, reason: "vertical_unmatched" };
  const revenue = input.revenueEstimateUsd ?? estimateRevenue(input.employeeCount, input.vertical);
  if (revenue == null) return { accepted: false, reason: "revenue_unknown" };
  if (revenue < REVENUE_FLOOR_USD)
    return { accepted: false, reason: `revenue_below_floor (${revenue.toLocaleString()} < ${REVENUE_FLOOR_USD.toLocaleString()})` };
  if (revenue > REVENUE_CEILING_USD)
    return { accepted: false, reason: `revenue_above_ceiling (${revenue.toLocaleString()} > ${REVENUE_CEILING_USD.toLocaleString()})` };
  return { accepted: true, reason: null };
}

export function registrableDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim().toLowerCase();
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      /* fallthrough */
    }
  }
  value = value.split("/")[0].split("?")[0].split(":")[0].replace(/^[.@]+|[.@]+$/g, "");
  return value.includes(".") ? value : null;
}

export function formatRevenue(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 1)}M`;
  return `$${(usd / 1_000).toFixed(0)}K`;
}
