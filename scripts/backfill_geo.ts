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
 *   2. country normalized to "US"/"CA" when the row is clearly one of them;
 *      rows that resolve to neither are left untouched — they are off-board
 *      on the NA map by doctrine.
 *   3. missing latitude/longitude -> static city centroid (city-level
 *      precision, no external geocoder, no egress)
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

    // 1) canonical territory text
    const territory = normalizeTerritory(r.country, r.stateProvince, r.region);
    if (territory && r.stateProvince !== territory.postal) {
      data.stateProvince = territory.postal;
    }

    // 2) canonical country
    const countryHint = normalizeCountry(r.country) ?? normalizeCountry(r.region);
    if (territory && countryHint !== null && r.country !== (territory.country === "US" ? "United States" : "Canada")) {
      data.country = territory.country === "US" ? "United States" : "Canada";
    }

    // 3-4) deterministic geocoding for missing coordinates
    let geocode: string | null = null;
    if (r.latitude == null || r.longitude == null) {
      const city = cityCentroid(r.city, territory?.country ?? countryHint);
      if (city) {
        data.latitude = city.lat;
        data.longitude = city.lng;
        geocode = `city centroid (${city.lat.toFixed(4)}, ${city.lng.toFixed(4)})`;
      } else if (territory) {
        const anchor = territoryAnchor.get(territory.code);
        if (anchor) {
          data.latitude = anchor[1];
          data.longitude = anchor[0];
          geocode = `territory anchor (${anchor[1].toFixed(4)}, ${anchor[0].toFixed(4)})`;
        }
      }
    }

    const changes = Object.keys(data);
    if (changes.length === 0) {
      report.push(`  ok      ${r.name} — ${before.status}${before.territory ? ` · ${before.territory.code}` : ""}`);
      continue;
    }

    touched += 1;
    const detail = changes.map((c) => {
      if (c === "stateProvince") return `state "${r.stateProvince}" -> "${data.stateProvince}"`;
      if (c === "country") return `country "${r.country}" -> "${data.country}"`;
      return `geo <- ${geocode}`;
    }).join(" · ");
    report.push(`  update  ${r.name} — ${detail}`);

    if (APPLY) {
      await db.prospect.update({ where: { id: r.id }, data });
    }
  }

  // summary ledger
  const plotted = rows.filter((r) => classifyLeadGeo(r).status === "plotted").length;
  const uncharted = rows.filter((r) => classifyLeadGeo(r).status === "uncharted").length;
  const offBoard = rows.filter((r) => classifyLeadGeo(r).status === "off_board").length;

  console.log(`\ntheatre geo backfill — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(report.join("\n"));
  console.log(`\nledger: ${rows.length} prospects · ${plotted} plotted · ${uncharted} uncharted · ${offBoard} off-board`);
  console.log(`changes${APPLY ? " applied" : " pending --apply"}: ${touched}`);
  if (!APPLY) console.log("run with --apply to write these changes");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
