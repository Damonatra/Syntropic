#!/usr/bin/env bash
# Theatre map verification — Map-1 spine: geo bundle, normalizer, census, gate posture.
# Usage: bash scripts/verify_theatre_map.sh
set -u
BASE="http://localhost:81"
JAR="$(mktemp)"
PW="${ENCLAVE_PASSWORD:-7BP2iox9DhM2cF9LiXwsma}"
PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "== 1. Enclave auth — POST /api/gate (expect 200 ok)"
code=$(curl -s -o /tmp/gate.json -w "%{http_code}" -c "$JAR" -X POST "$BASE/api/gate" \
  -H 'content-type: application/json' -d "{\"password\":\"$PW\"}")
if [ "$code" = "200" ] && grep -q '"ok":true' /tmp/gate.json; then ok "session cookie issued"; else bad "gate returned $code"; fi
# gate off? then no cookie needed
if grep -q '"gated":false' /tmp/gate.json 2>/dev/null; then echo "  (gate disabled — proceeding without cookie)"; fi

echo "== 2. Territory bundle — GET /geo/us-ca-territories.json (expect 200, 64 features: 51 US + 13 CA)"
code=$(curl -s -o /tmp/geo.json -w "%{http_code}" -b "$JAR" "$BASE/geo/us-ca-territories.json")
python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
if code != "200":
    print(f"  FAIL: bundle HTTP {code}"); sys.exit(1)
d = json.load(open("/tmp/geo.json"))
feats = d["features"]
us = [f for f in feats if f["properties"]["country"] == "US"]
ca = [f for f in feats if f["properties"]["country"] == "CA"]
codes = [f["properties"]["code"] for f in feats]
checks = [
    (len(feats) == 64, f"64 features (got {len(feats)})"),
    (len(us) == 51, f"51 US (got {len(us)})"),
    (len(ca) == 13, f"13 CA (got {len(ca)})"),
    (len(set(codes)) == 64, "codes unique"),
    (all("labelPos" in f["properties"] for f in feats), "every territory has a label anchor"),
    ("US-TX" in codes and "CA-ON" in codes and "US-DC" in codes and "CA-PE" in codes,
     "TX/ON/DC/PE present"),
]
failed = [m for c, m in checks if not c]
for c, m in checks:
    print(f"  {'PASS' if c else 'FAIL'}: {m}")
sys.exit(1 if failed else 0)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 3. Lakes layer — GET /geo/na-lakes.json (expect 200, Great Lakes present)"
code=$(curl -s -o /tmp/lakes.json -w "%{http_code}" -b "$JAR" "$BASE/geo/na-lakes.json")
python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
if code != "200":
    print(f"  FAIL: lakes HTTP {code}"); sys.exit(1)
d = json.load(open("/tmp/lakes.json"))
names = {f["properties"]["name"] for f in d["features"]}
need = {"Lake Superior", "Lake Michigan", "Lake Huron", "Lake Erie", "Lake Ontario"}
missing = need - names
print(f"  {'PASS' if not missing else 'FAIL'}: {len(names)} lakes, all five Great Lakes {'present' if not missing else 'MISSING ' + str(missing)}")
sys.exit(1 if missing else 0)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 4. Normalizer — alias table resolves messy real-world inputs"
bun -e "
import { normalizeTerritory, normalizeCountry, cityCentroid } from './src/lib/vertebra/geo';
const cases: Array<[string|null,string|null,string|null,string|null]> = [
  ['United States','TX','us','US-TX'], ['USA','texas',null,'US-TX'], [null,'Tex.',null,'US-TX'],
  ['Canada','Ontario',null,'CA-ON'], [null,'Québec',null,'CA-QC'], [null,'PQ',null,'CA-QC'],
  ['Canada','NWT',null,'CA-NT'], [null,'D.C.',null,'US-DC'], [null,'washington dc',null,'US-DC'],
  ['Kenya','Lamu','intl_expansion',null], [null,null,null,null],
];
let bad = 0;
for (const [c, sp, r, want] of cases) {
  const got = normalizeTerritory(c, sp, r)?.code ?? null;
  if (got !== want) { console.log('  FAIL:', JSON.stringify([c,sp,r]), '->', got, 'want', want); bad++; }
}
if (cityCentroid('Houston','CA') !== null) { console.log('  FAIL: Houston must refuse CA hint'); bad++; }
if (cityCentroid('Richmond','CA')?.code !== 'CA-BC') { console.log('  FAIL: Richmond/CA should be BC'); bad++; }
if (normalizeCountry('United States of America') !== 'US') { console.log('  FAIL: country alias'); bad++; }
if (bad === 0) console.log('  PASS: all normalization cases resolve');
process.exit(bad ? 1 : 0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 5. Backfill — dry run (expect exit 0, ledger printed, nothing forced)"
out=$(bun scripts/backfill_geo.ts 2>&1); rc=$?
echo "$out" | grep -E "^(ledger|changes)" | sed 's/^/  /'
if [ $rc -eq 0 ] && echo "$out" | grep -q "^ledger: 12 prospects · 9 plotted · 0 uncharted · 3 off-board"; then
  ok "ledger honest — 9 plotted, 3 Kenya off-board"
else bad "unexpected ledger (rc=$rc)"; fi

echo "== 6. Live snapshot — GET /api/command (expect 200, geo fields on leads)"
code=$(curl -s -o /tmp/cmd.json -w "%{http_code}" -b "$JAR" "$BASE/api/command")
python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
if code != "200":
    print(f"  FAIL: /api/command HTTP {code}"); sys.exit(1)
d = json.load(open("/tmp/cmd.json"))
leads = d.get("leads", [])
na = [l for l in leads if (l.get("country") in ("United States", "Canada"))]
geo = [l for l in na if l.get("latitude") is not None and l.get("longitude") is not None]
kenya = [l for l in leads if l.get("country") == "Kenya"]
tx = [l for l in leads if l.get("stateProvince") == "TX"]
print(f"  PASS: {len(leads)} leads · {len(geo)}/{len(na)} US/CA geocoded · {len(kenya)} off-board · {len(tx)} in Texas"
      if len(geo) == len(na) and len(na) > 0 else
      f"  FAIL: only {len(geo)}/{len(na)} US/CA leads carry coordinates")
sys.exit(0 if len(geo) == len(na) and len(na) > 0 else 1)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 7. Gate posture — unauthenticated fetch of the bundle (expect redirect, not open access)"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/geo/us-ca-territories.json")
if [ "$code" = "307" ] || [ "$code" = "302" ]; then ok "geometry stays behind the enclave gate ($code)"; else bad "bundle reachable unauthenticated ($code)"; fi

echo "== 8. Map-2 — lens registry, concentration ramp, funnel counters, census honesty"
bun -e "
import { censusBoard, lensFill, LENSES, type BoardCensus } from './src/lib/vertebra/theatre';
import type { CommandLead } from './src/lib/vertebra/command';
let bad = 0;
const fail = (m: string) => { console.log('  FAIL:', m); bad++; };

// 8a — exactly one live lens (concentration), five planned shells
const live = LENSES.filter((l) => l.status === 'live');
if (LENSES.length !== 6) fail('six lenses expected');
if (live.length !== 1 || live[0].id !== 'concentration') fail('concentration must be the only live lens');

// 8b — concentration ramp is monotonic in count; planned lenses stay inert
const stat = (n: number) => ({ count: n } as never);
const a = parseFloat(lensFill('concentration', stat(1), 9, false, false).match(/([\d.]+)\)$/)![1]);
const b = parseFloat(lensFill('concentration', stat(9), 9, false, false).match(/([\d.]+)\)$/)![1]);
if (!(b > a)) fail('concentration ramp not monotonic');
if (lensFill('momentum', stat(9), 9, false, false) !== '#161816') fail('planned lens must stay inert');

// 8c — censusBoard: funnel counters + honest trays on synthetic leads
const mk = (over: Partial<CommandLead>): CommandLead => ({
  id: 'x', name: 'X', domain: null, vertical: null, city: null, stateProvince: null,
  country: null, region: null, revenueEstimateUsd: null, employeeCount: null, ingestion: 'ingested',
  caslScope: false, bestEmail: null, contact: null, score: null, erp: null, quotePortalType: null,
  auditImageUrl: null, latitude: null, longitude: null, clusterId: null, clusterName: null,
  lastIntentHeat: 0, telemetry: { lastEventAtMs: null, lastEventType: null, events24h: 0 } as never,
  dispatch: null, highTouch: null, leakageUsd: null, priority: 0, highIntentNow: false,
  pendingDrafts: 0, snoozedUntilMs: null, lastActionAtMs: null, ...over,
});
const resolve = (l: CommandLead) => {
  const c = l.country; const sp = l.stateProvince;
  if (c === 'United States' && sp === 'TX') return 'US-TX';
  if (c === 'Canada' && sp === 'BC') return 'CA-BC';
  return null;
};
const leads = [
  mk({ id: 'a', name: 'Gulf', country: 'United States', stateProvince: 'TX', latitude: 29.76, longitude: -95.37,
       caslScope: false, dispatch: { channel: 'channel_a_automated_email', status: 'staged', scheduledAtMs: null, steps: 1 },
       score: { qlvScore: 91, band: 'critical', factors: [], hooks: [], rationale: '', model: '', createdAt: '' } as never,
       leakageUsd: 48000 }),
  mk({ id: 'b', name: 'Bayou', country: 'United States', stateProvince: 'TX', latitude: 30.45, longitude: -91.19,
       dispatch: { channel: 'channel_a_automated_email', status: 'sent', scheduledAtMs: null, steps: 1 }, leakageUsd: 12000 }),
  mk({ id: 'c', name: 'Maple', country: 'Canada', stateProvince: 'BC', latitude: 48.43, longitude: -123.36,
       caslScope: true }),
  mk({ id: 'd', name: 'NoGeo', country: 'United States', stateProvince: 'TX' }),
  mk({ id: 'e', name: 'LAPPSET', country: 'Kenya', latitude: -2.27, longitude: 40.9 }),
];
const census: BoardCensus = censusBoard(leads, resolve);
const tx = census.territoryStats.get('US-TX')!;
if (tx.count !== 2) fail('US-TX count');
if (tx.critical !== 1) fail('US-TX critical band');
if (tx.mailStaged !== 1 || tx.mailSent !== 1 || tx.mailQueued !== 0 || tx.mailFailed !== 0) fail('US-TX funnel');
if (tx.leakageUsd !== 60000) fail('US-TX leakage');
if (census.territoryStats.get('CA-BC')!.caslTrue !== 1) fail('CA-BC consent-true');
if (census.uncharted.length !== 1 || census.uncharted[0].name !== 'NoGeo') fail('uncharted tray');
if (census.offBoard.length !== 1 || census.offBoard[0].name !== 'LAPPSET') fail('off-board tray');
if (census.plotted.length !== 3) fail('plotted pool');

// 8d — M1 binding math: filtering to critical leaves only the 91-QLV row on the board
const criticalBoard = censusBoard(leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85), resolve);
if (criticalBoard.territoryStats.get('US-TX')!.count !== 1) fail('M1 filter does not bind the census');

if (bad === 0) console.log('  PASS: lenses + funnel + trays + M1 binding all resolve');
process.exit(bad ? 1 : 0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

rm -f "$JAR" /tmp/gate.json /tmp/geo.json /tmp/lakes.json /tmp/cmd.json
echo
echo "theatre map verification: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
