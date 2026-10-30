import { normalizeTerritory, normalizeCountry, cityCentroid, classifyLeadGeo } from "../../src/lib/vertebra/geo";

const cases: Array<[string | null, string | null, string | null]> = [
  ["United States", "TX", "us"],
  ["United States", "Texas", null],
  ["USA", "texas", null],
  [null, "Tex.", null],
  [null, "tx", null],
  ["Canada", "Ontario", null],
  ["Canada", "ON", "ca"],
  [null, "Québec", null],
  [null, "quebec", null],
  [null, "PQ", null],
  ["Canada", "NWT", null],
  [null, "British Columbia", null],
  [null, "D.C.", null],
  [null, "District of Columbia", null],
  [null, "washington dc", null],
  ["United States", "Illinois", "us"],
  [null, "Ill.", null],
  ["Brazil", "São Paulo", "intl_expansion"],
  [null, "Newfoundland", null],
  ["United States", "CA", "us"],       // state context: California
  ["Canada", "BC", "ca"],
  [null, null, null],
];

for (const [c, sp, r] of cases) {
  const res = normalizeTerritory(c, sp, r);
  console.log(`(${c ?? "—"}, ${sp ?? "—"}, ${r ?? "—"}) -> ${res ? res.code : "null"}`);
}

console.log("\ncityCentroid:");
console.log("houston/US ->", cityCentroid("Houston", "US")?.code);
console.log("houston/CA ->", cityCentroid("Houston", "CA"));  // wrong country: refuse
console.log("richmond/US ->", cityCentroid("Richmond", "US")?.code);
console.log("richmond/CA ->", cityCentroid("Richmond", "CA")?.code);
console.log("richmond/null ->", cityCentroid("Richmond", null)?.code);
console.log("montréal/CA ->", cityCentroid("Montréal", "CA")?.code);
console.log("london/CA ->", cityCentroid("London", "CA")?.code);
console.log("osaka/CA ->", cityCentroid("Osaka", "CA"));

console.log("\nclassify:");
console.log(classifyLeadGeo({ country: "Canada", stateProvince: "Toronto" , region: "ca", latitude: 43.65, longitude: -79.38 }));
console.log(classifyLeadGeo({ country: "Brazil", stateProvince: "São Paulo", region: "intl_expansion", latitude: -23.55, longitude: -46.63 }));
console.log(classifyLeadGeo({ country: null, stateProvince: null, region: null, latitude: null, longitude: null }));
