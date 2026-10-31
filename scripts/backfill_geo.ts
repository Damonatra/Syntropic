/**
 * Theatre geo backfill — normalize territory text + deterministically
 * geocode prospects missing coordinates.
 *
 * Usage:
 *   bun scripts/backfill_geo.ts           # dry-run: report what would change
 *   bun scripts/backfill_geo.ts --apply   # write the changes
 *
 * Rules (in order, first match wins — nothing is ever invented):
 *   1. stateProvince resolves via the alias table  -> canonical postal code
 *      ("Texas"/"texas"/"Tex." -> "TX"; "Québec"/"PQ" -> "QC")
 *      When stateProvince is empty, a "City, State" region string lends its
 *      second part as territory text and its first part as a city hint
 *      ("Houston, Texas" -> city "Houston", state "TX") — text the row
 *      already carries, never a guess.
 *   2. country normalized to "US"/"CA" when the row is clearly one of them;
 *      rows that resolve to neither are left untouched — they are off-board
 *      on the NA map by doctrine.
 *   3. missing latitude/longitude -> static city centroid (city-level
 *      precision, no external geocoder, no egress); a resolved centroid
 *      also claims its territory code for stateProvince/country
 *   4. still nothing -> territory label anchor (from the geometry bundle)
 *   5. still nothing -> left uncharted; the board's uncharted tray claims it
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import {
  cityCentroid,
  classifyLeadGeo,
  normalizeCountry,
  normalizeTerritory,
  TERRITORY_BY_CODE,
} from "../src/lib/vertebra/geo";

const db = new PrismaClient();
const APPLY = process.argv.includes("--apply");

interface GeoFeature {
  properties: { code: string; labelPos: [number, number] };
}
const territoryAnchor = new Map<string, [number, number]>();
try {
  const bundle = JSON.parse(readFileSync("public/geo/us-ca-territories.json", "utf8")) as {
    features: GeoFeature[];
  };
  for (const f of bundle.features) territoryAnchor.set(f.properties.code, f.properties.labelPos);
} catch {
  console.warn("warn: public/geo/us-ca-territories.json not readable — territory anchors unavailable");
}

async function main() {
  const rows = await db.prospect.findMany({
    select: {
      id: true, name: true, city: true, stateProvince: true,
      country: true, region: true, latitude: true, longitude: true,
    },
    orderBy: { createdAt: "asc" },
  });

  let touched = 0;
  const report: string[] = [];

  for (const r of rows) {
    const before = classifyLeadGeo(r);
    const data: {
      stateProvince?: string; country?: string;
      latitude?: number; longitude?: number;
    } = {};

    // 0) lend structure from the region text — "Houston, Texas" carries both
    //    a city hint and a state hint the row already owns; "US Midwest"
    //    (no comma) lends nothing
    const regionParts = (r.region ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const cityHint = r.city ?? (regionParts.length >= 2 ? regionParts[0] : null);
    const stateText = r.stateProvince ?? (regionParts.length >= 2 ? regionParts[regionParts.length - 1] : null);

    // 1) canonical territory text (stateProvince as-is, or the region's state part)
    let territory = normalizeTerritory(r.country, stateText, r.region);

    // 2) deterministic city centroid — also claims its territory code when
    //    no text evidence resolved one (the centroid table knows Cleveland
    //    is US-OH; the row should know it too)
    let geocode: string | null = null;
    const countryHint = normalizeCountry(r.country) ?? territory?.country ?? normalizeCountry(r.region);
    if (r.latitude == null || r.longitude == null) {
      const city = cityCentroid(cityHint, countryHint ?? null);
      if (city) {
        data.latitude = city.lat;
        data.longitude = city.lng;
        geocode = `city centroid (${city.lat.toFixed(4)}, ${city.lng.toFixed(4)})${r.city ? "" : ` · city hint "${cityHint}" from region`}`;
        if (!territory) territory = TERRITORY_BY_CODE[city.code] ?? null;
      }
    }

    // 3) write the canonical territory text the resolution earned
    if (territory && r.stateProvince !== territory.postal) {
      data.stateProvince = territory.postal;
    }
    if (territory && normalizeCountry(r.country) !== territory.country) {
      // only when the current value does NOT already normalize to the right
      // country — "US" stays "US", NULL and wrong values get canonicalized
      data.country = territory.country === "US" ? "United States" : "Canada";
    }

    // 4) still coordinate-less -> territory label anchor (state-centroid
    //    precision — honest, but city hints above beat it)
    if ((r.latitude == null || r.longitude == null) && data.latitude == null && territory) {
      const anchor = territoryAnchor.get(territory.code);
      if (anchor) {
        data.latitude = anchor[1];
        data.longitude = anchor[0];
        geocode = `territory anchor (${anchor[1].toFixed(4)}, ${anchor[0].toFixed(4)})`;
      }
    }

    const changes = Object.keys(data);
    if (changes.length === 0) {
      report.push(`  ok      ${r.name} — ${before.status}${before.territory ? ` · ${before.territory.code}` : ""}`);
      continue;
    }

    touched += 1;
    const detail = changes
      .filter((c) => !(c === "longitude" && changes.includes("latitude"))) // one geo line, not two
      .map((c) => {
        if (c === "stateProvince") return `state "${r.stateProvince}" -> "${data.stateProvince}"`;
        if (c === "country") return `country "${r.country}" -> "${data.country}"`;
        return `geo <- ${geocode}`;
      })
      .join(" · ");
    report.push(`  update  ${r.name} — ${detail}`);

    if (APPLY) {
      await db.prospect.update({ where: { id: r.id }, data });
    }
  }

  // summary ledger — re-read when applying, so the truth is the DB's truth
  const finalRows = APPLY
    ? await db.prospect.findMany({
        select: { id: true, name: true, city: true, stateProvince: true, country: true, region: true, latitude: true, longitude: true },
      })
    : rows;
  const plotted = finalRows.filter((r) => classifyLeadGeo(r).status === "plotted").length;
  const uncharted = finalRows.filter((r) => classifyLeadGeo(r).status === "uncharted").length;
  const offBoard = finalRows.filter((r) => classifyLeadGeo(r).status === "off_board").length;

  console.log(`\ntheatre geo backfill — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(report.join("\n"));
  console.log(`\nledger: ${finalRows.length} prospects · ${plotted} plotted · ${uncharted} uncharted · ${offBoard} off-board`);
  console.log(`changes${APPLY ? " applied" : " pending --apply"}: ${touched}`);
  if (!APPLY) console.log("run with --apply to write these changes");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
