#!/usr/bin/env bash
# Theatre map verification — Map-1 spine · Map-2 drawer · Map-3 lens set + deep link ·
# Map-4 pulse (call windows, movement ledger, honest 24h deltas):
# geo bundle, normalizer, census, six lens ramps, URL codec, gate posture.
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

echo "== 8. Map-3 — six live lenses, monotonic luminance, honest base fills"
bun -e "
import { censusBoard, lensFill, lensLeader, lensMetricLabel, LENSES, type BoardCensus, type LensExtremes } from './src/lib/vertebra/theatre';
import type { CommandLead } from './src/lib/vertebra/command';
let bad = 0;
const fail = (m: string) => { console.log('  FAIL:', m); bad++ };
const alpha = (fill: string) => (fill.startsWith('rgba') ? parseFloat(fill.slice(0, -1).split(',')[3]) : 0);
const DAY = 86400000;

// 8a — every lens armed
if (LENSES.length !== 6) fail('six lenses expected');
for (const l of LENSES) if (l.status !== 'live') fail(l.id + ' must be live in Map-3');

const ext: LensExtremes = { maxCount: 9, maxLeakageUsd: 900000, maxMomentum48h: 20, maxMailVolume: 9, nowMs: 1700000000000 };
const stat = (over: Record<string, unknown>) => ({
  code: 'US-TX', name: 'Texas', country: 'US', type: 'State', count: 0, critical: 0, leakageUsd: 0,
  avgQlv: null, caslTrue: 0, inSequence: 0, lastTouchMs: null, mailQueued: 0, mailStaged: 0,
  mailSent: 0, mailFailed: 0, telemetryEvents48h: 0, lastTelemetryMs: null, leads: [], ...over,
}) as never;

// 8b — empty territories stay on the honest base fill under every lens
for (const l of LENSES) if (lensFill(l.id, undefined, ext, false, false) !== '#161816') fail(l.id + ' base fill');

// 8c — luminance monotonic in each lens metric; failure accent on mail
const inc = (a: number, b: number, m: string) => { if (!(b > a)) fail(m); };
inc(alpha(lensFill('concentration', stat({ count: 1 }), ext, false, false)),
    alpha(lensFill('concentration', stat({ count: 9 }), ext, false, false)), 'concentration ramp');
inc(alpha(lensFill('momentum', stat({ count: 2, telemetryEvents48h: 2 }), ext, false, false)),
    alpha(lensFill('momentum', stat({ count: 2, telemetryEvents48h: 20 }), ext, false, false)), 'momentum ramp');
if (lensFill('momentum', stat({ telemetryEvents48h: 7 }), ext, false, false) !== '#161816') fail('momentum must refuse empty territories');
inc(alpha(lensFill('exposure', stat({ count: 1, leakageUsd: 5000 }), ext, false, false)),
    alpha(lensFill('exposure', stat({ count: 1, leakageUsd: 900000 }), ext, false, false)), 'exposure ramp');
inc(alpha(lensFill('cadence', stat({ count: 1, lastTouchMs: ext.nowMs - 200 * DAY }), ext, false, false)),
    alpha(lensFill('cadence', stat({ count: 1, lastTouchMs: ext.nowMs - 2 * DAY }), ext, false, false)), 'cadence ramp');
inc(alpha(lensFill('compliance', stat({ count: 3, caslTrue: 3, country: 'CA' }), ext, false, false)),
    alpha(lensFill('compliance', stat({ count: 3, caslTrue: 0, country: 'CA' }), ext, false, false)), 'compliance ramp');
const mailClean = alpha(lensFill('mail', stat({ count: 2, mailSent: 2 }), ext, false, false));
const mailFail = alpha(lensFill('mail', stat({ count: 2, mailSent: 1, mailFailed: 1 }), ext, false, false));
if (!(mailFail > mailClean)) fail('mail failure accent');

// 8d — label ink + caption leaders
if (lensMetricLabel('concentration', stat({ count: 4 }), ext.nowMs) !== '·4') fail('concentration label');
if (lensMetricLabel('momentum', stat({ count: 2, telemetryEvents48h: 7 }), ext.nowMs) !== '·7ev') fail('momentum label');
if (lensMetricLabel('exposure', stat({ count: 2, leakageUsd: 48000 }), ext.nowMs) !== '·\$48K') fail('exposure label');
if (lensMetricLabel('cadence', stat({ count: 1, lastTouchMs: ext.nowMs - 5 * DAY }), ext.nowMs) !== '·5d') fail('cadence label');
if (lensMetricLabel('compliance', stat({ count: 3, caslTrue: 1, country: 'CA', code: 'CA-BC' }), ext.nowMs) !== '·1/3') fail('compliance label');
if (lensMetricLabel('mail', stat({ count: 2, mailStaged: 1, mailSent: 1 }), ext.nowMs) !== '·1s/1x/0f') fail('mail label');
if (lensMetricLabel('mail', stat({ count: 1, mailQueued: 2 }), ext.nowMs) !== '·2q') fail('mail queued-only label');
if (lensMetricLabel('mail', stat({ count: 1, mailQueued: 1, mailStaged: 1 }), ext.nowMs) !== '·1s/0x/0f+1q') fail('mail queued suffix');
const leadA = lensLeader('momentum', [stat({ code: 'US-TX', name: 'Texas', count: 2, telemetryEvents48h: 7 }), stat({ code: 'CA-ON', name: 'Ontario', count: 5, telemetryEvents48h: 3 })], ext.nowMs);
if (!leadA || leadA.code !== 'US-TX' || leadA.readout.indexOf('7') !== 0) fail('momentum leader');

// 8e — censusBoard: funnel counters, telemetry sums, maxima, honest trays
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
       telemetry: { lastEventAtMs: 1699999200000, lastEventType: 'pricing_repeat_view', events48h: 5 } as never,
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
if (tx.telemetryEvents48h !== 5) fail('US-TX telemetry sum');
if (census.maxMomentum48h !== 5) fail('momentum maximum');
if (census.maxMailVolume !== 2) fail('mail volume maximum');
if (census.maxLeakageUsd !== 60000) fail('leakage maximum');
if (census.territoryStats.get('CA-BC')!.caslTrue !== 1) fail('CA-BC consent-true');
if (census.uncharted.length !== 1 || census.uncharted[0].name !== 'NoGeo') fail('uncharted tray');
if (census.offBoard.length !== 1 || census.offBoard[0].name !== 'LAPPSET') fail('off-board tray');
if (census.plotted.length !== 3) fail('plotted pool');
const leadB = lensLeader('momentum', Array.from(census.territoryStats.values()), 1700000000000);
if (!leadB || leadB.code !== 'US-TX') fail('census momentum leader');
const leadC = lensLeader('cadence', Array.from(census.territoryStats.values()), 1700000000000);
if (!leadC || leadC.code !== 'US-TX' || leadC.readout.indexOf('touched') !== 0) fail('census cadence leader');

// 8f — M1 binding math: filtering to critical leaves only the 91-QLV row on the board
const criticalBoard = censusBoard(leads.filter((l) => (l.score?.qlvScore ?? 0) >= 85), resolve);
if (criticalBoard.territoryStats.get('US-TX')!.count !== 1) fail('M1 filter does not bind the census');

if (bad === 0) console.log('  PASS: six lenses · ramps · labels · leaders · trays · M1 binding all resolve');
process.exit(bad ? 1 : 0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 9. Map-3 deep link — board state survives the URL round-trip"
bun -e "
import { encodeBoardState, parseBoardState } from './src/lib/vertebra/theatre';
let bad = 0;
const fail = (m: string) => { console.log('  FAIL:', m); bad++ };
const q = encodeBoardState({ lens: 'momentum', territory: 'US-TX', cluster: 'cl1', view: { k: 3.234, x: -123.4, y: 45.6 } });
const p = parseBoardState(q);
if (p.lens !== 'momentum') fail('lens round-trip');
if (p.territory !== 'US-TX' || p.cluster !== 'cl1') fail('territory/cluster round-trip');
if (!p.view || Math.abs(p.view.k - 3.23) > 0.001 || p.view.x !== -123 || p.view.y !== 46) fail('camera round-trip (integer-pan precision)');
if (encodeBoardState({ lens: 'concentration', territory: null, cluster: null, view: null }) !== '') fail('identity must encode to empty query');
const d = parseBoardState(null);
if (d.lens !== 'concentration' || d.territory !== null || d.view !== null) fail('defaults');
const h = parseBoardState('?tl=evil&tk=99&tx=abc&ty=-40');
if (h.lens !== 'concentration') fail('invalid lens rejected');
if (!h.view || h.view.k !== 18 || h.view.x !== 0 || h.view.y !== -40) fail('camera clamped/sanitized');
if (bad === 0) console.log('  PASS: lens, territory, cluster and camera all survive the URL');
process.exit(bad ? 1 : 0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 10. Map-4 — call windows, pulse ledger math, 24h deltas"
bun -e "
import { territoryCallWindow, pulseDeltaSummary, pulseLine, TERRITORY_TZ } from './src/lib/vertebra/theatre';
import type { PulseEvent } from './src/lib/vertebra/command';
let bad = 0;
const fail = (m: string) => { console.log('  FAIL:', m); bad++ };
const ev = (id: string, atMs: number, territory: string | null): PulseEvent =>
  ({ id, kind: 'telemetry', atMs, prospectId: 'p' + id, prospectName: 'P' + id, territory, detail: 'pricing_view' });

// 10a — the flagship clock: 14:00Z on Thu Jan 15 2026 — Houston 08:00 open, Victoria 06:00 opening in 2h
const thu = Date.UTC(2026, 0, 15, 14, 0, 0);
const tx = territoryCallWindow('US-TX', thu);
if (!tx || !tx.open) fail('US-TX must be open at 14:00Z');
if (tx && !tx.clock.startsWith('08:00')) fail('US-TX clock expected 08:00, got ' + tx.clock);
if (tx && !tx.label.startsWith('open · closes 18:00')) fail('US-TX label: ' + tx.label);
if (tx && tx.closesAtMs !== Date.UTC(2026, 0, 16, 0, 0)) fail('US-TX closesAtMs expected 00:00Z, got ' + (tx ? new Date(tx.closesAtMs).toISOString() : 'null'));
const bc = territoryCallWindow('CA-BC', thu);
if (!bc || bc.open) fail('CA-BC must be closed at 14:00Z');
if (bc && !bc.clock.startsWith('06:00')) fail('CA-BC clock expected 06:00, got ' + bc.clock);
if (bc && !bc.label.startsWith('opens 08:00 · in 2h')) fail('CA-BC label: ' + (bc?.label ?? 'null'));

// 10b — half-hour zone honesty: Newfoundland at 14:00Z reads 10:30 NST
const nl = territoryCallWindow('CA-NL', thu);
if (nl && !nl.clock.startsWith('10:30')) fail('CA-NL clock expected 10:30, got ' + nl.clock);

// 10c — weekends never open: Sat Jan 17 2026 names the next business day
const sat = Date.UTC(2026, 0, 17, 14, 0, 0);
const txSat = territoryCallWindow('US-TX', sat);
if (!txSat || txSat.open) fail('US-TX must be closed on a Saturday');
if (txSat && txSat.label !== 'opens Mon 08:00') fail('US-TX Saturday label: ' + (txSat?.label ?? 'null'));

// 10d — the clock is total: all 64 territories resolve at any hour
if (Object.keys(TERRITORY_TZ).length !== 64) fail('TZ table must cover all 64 territories, got ' + Object.keys(TERRITORY_TZ).length);
for (const code of Object.keys(TERRITORY_TZ)) {
  for (const h of [0, 6, 13, 22]) {
    if (!territoryCallWindow(code, Date.UTC(2026, 5, 15, h, 30))) fail(code + ' window unresolved at hour ' + h);
  }
}

// 10e — 24h deltas: a mature ledger compares, a young ledger refuses to fake history
const now = Date.UTC(2026, 5, 15, 14, 0, 0);
const mature = pulseDeltaSummary([
  ev('a', now - 3_600_000, 'US-TX'), ev('b', now - 7_200_000, 'US-TX'),
  ev('c', now - 3_600_000, 'CA-BC'), ev('d', now - 30 * 3_600_000, 'US-TX'),
], now);
if (!mature.mature) fail('mature ledger must arm deltas');
const txd = mature.deltas.find((d) => d.code === 'US-TX');
if (!txd || txd.last24h !== 2 || txd.prior24h !== 1 || txd.readout !== '+2 vs 1' || txd.direction !== 'up')
  fail('US-TX delta ' + JSON.stringify(txd));
const young = pulseDeltaSummary([ev('a', now - 3_600_000, 'US-TX')], now);
if (young.mature) fail('young ledger must refuse deltas');
if (young.deltas[0]?.direction !== 'quiet' || young.deltas[0]?.readout !== '· 1')
  fail('young delta readout ' + JSON.stringify(young.deltas[0]));

// 10f — ticker line formatting
const line = pulseLine(ev('a', now - 90_000, 'US-TX'), now);
if (!line.startsWith('1m ago · US-TX · Pa · pricing_view')) fail('pulseLine: ' + line);

if (bad === 0) console.log('  PASS: call windows (Houston 08:00 vs Victoria 06:00) · deltas · ticker line all resolve');
process.exit(bad ? 1 : 0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 11. Map-4 live — GET /api/command carries the pulse ledger"
code=$(curl -s -o /tmp/cmd4.json -w "%{http_code}" -b "$JAR" "$BASE/api/command")
python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
if code != "200":
    print(f"  FAIL: /api/command HTTP {code}"); sys.exit(1)
d = json.load(open("/tmp/cmd4.json"))
pulse = d.get("pulse")
if not isinstance(pulse, list) or len(pulse) == 0 or len(pulse) > 120:
    print(f"  FAIL: pulse ledger missing/malformed ({type(pulse).__name__}, {len(pulse) if isinstance(pulse, list) else 0} entries)"); sys.exit(1)
if not all(("kind" in e and "atMs" in e and "detail" in e and "territory" in e) for e in pulse):
    print("  FAIL: pulse rows missing kind/atMs/detail/territory"); sys.exit(1)
territories = {e["territory"] for e in pulse if e.get("territory")}
kinds = sorted({e["kind"] for e in pulse})
if not territories:
    print("  FAIL: no pulse row resolved to a territory"); sys.exit(1)
print(f"  PASS: pulse ledger live — {len(pulse)} entries · territories {sorted(territories)} · kinds {kinds}")
sys.exit(0)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

rm -f "$JAR" /tmp/gate.json /tmp/geo.json /tmp/lakes.json /tmp/cmd.json /tmp/cmd4.json
echo
echo "theatre map verification: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
