/**
 * Geo resolution — Phase 11.8 (edge-first).
 *
 * Three-tier strategy, single entry point via `resolveGeo`:
 *   1. PRIMARY  — edge-injected headers (Vercel / Cloudflare / Nginx geoip).
 *                 Authoritative when present; zero latency, zero egress.
 *   2. FALLBACK — cached external provider lookup for self-hosted
 *                 deployments without edge headers. A cache miss answers
 *                 with the env fallback NOW and refreshes in the background
 *                 so the request path never waits on egress.
 *                 GEO_PROVIDER=none disables all outbound lookups.
 *   3. ENV      — GEO_FALLBACK_CITY / GEO_FALLBACK_COUNTRY for air-gapped
 *                 demos and provider outages.
 *
 * Privacy: IPs are never stored raw. `sanitizeIp` strips ports and zeroes
 * the IPv4 last octet (IPv6 → /64) unless IP_PRIVACY_MODE says otherwise —
 * 'full' keeps the complete address, 'off' stores nothing at all.
 */

export type Geo = { city: string | null; country: string | null };
export type GeoSource = 'edge' | 'provider' | 'fallback' | 'private' | 'none';

const CACHE = new Map<string, { geo: Geo; at: number }>();
const CACHE_TTL_MS = 24 * 3_600e3;
const CACHE_MAX = 5_000;

const PRIVATE_RE =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|f[cd][0-9a-f]{2}:)/i;

/** "Sanitized IP": port-stripped; IPv4 last octet zeroed / IPv6 → /64
 *  unless IP_PRIVACY_MODE=full. 'off' returns null — store nothing. */
export function sanitizeIp(raw: string | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  const v4port = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4port) ip = v4port[1];
  const mode = process.env.IP_PRIVACY_MODE ?? 'truncated';
  if (mode === 'off') return null;
  if (mode === 'full') return ip;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::`;
  const octets = ip.split('.');
  return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.0` : ip;
}

function envFallback(): Geo {
  return {
    city: process.env.GEO_FALLBACK_CITY || null,
    country: process.env.GEO_FALLBACK_COUNTRY || null,
  };
}

/** PRIMARY: edge-injected headers (Vercel / Cloudflare / Nginx geoip).
 *  Authoritative when present; city is URI-decoded, country normalized to
 *  ISO-3166 alpha-2 uppercase. */
export function geoFromHeaders(h: Headers): Geo | null {
  const rawCity = h.get('x-vercel-ip-city') ?? h.get('cf-ipcity') ?? h.get('x-geo-city');
  const rawCountry = h.get('x-vercel-ip-country') ?? h.get('cf-ipcountry') ?? h.get('x-geo-country');
  if (!rawCity && !rawCountry) return null;
  let city: string | null = null;
  if (rawCity) {
    try {
      city = decodeURIComponent(rawCity);
    } catch {
      city = rawCity;
    }
  }
  return { city, country: rawCountry ? rawCountry.toUpperCase() : null };
}

/** FALLBACK: cached external lookup for self-hosted deployments (no edge
 *  headers). Miss returns the env fallback NOW, refreshes cache in the
 *  background. GEO_PROVIDER=none disables egress entirely. */
export function getGeoByIp(fullIp: string | null): { geo: Geo; source: GeoSource } {
  if (!fullIp || PRIVATE_RE.test(fullIp)) return { geo: { city: null, country: null }, source: 'private' };

  const hit = CACHE.get(fullIp);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { geo: hit.geo, source: 'provider' };

  if ((process.env.GEO_PROVIDER ?? 'ip-api') === 'none') {
    return { geo: envFallback(), source: 'fallback' };
  }

  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 2_500);
  fetch(`http://ip-api.com/json/${encodeURIComponent(fullIp)}?fields=city,countryCode,status`, { signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { status?: string; city?: string; countryCode?: string } | null) => {
      if (!d || d.status !== 'success') return;
      if (CACHE.size >= CACHE_MAX) {
        const oldest = CACHE.keys().next().value;
        if (oldest !== undefined) CACHE.delete(oldest);
      }
      CACHE.set(fullIp, { geo: { city: d.city || null, country: d.countryCode || null }, at: Date.now() });
    })
    .catch(() => {})
    .finally(() => clearTimeout(kill));

  return hit ? { geo: hit.geo, source: 'provider' } : { geo: envFallback(), source: 'fallback' };
}

/** Single entry point for every route: edge headers win, provider second. */
export function resolveGeo(h: Headers, ip: string | null): { geo: Geo; source: GeoSource } {
  const edge = geoFromHeaders(h);
  if (edge) return { geo: edge, source: 'edge' };
  return getGeoByIp(ip);
}
