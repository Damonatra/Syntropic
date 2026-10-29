#!/usr/bin/env bash
# Portal engagement ledger verification — Modules M1→M4:
#   M1 signed webhook ingest, idempotency, manual door, auto-match
#   M2 stage machine guards, verdict gate, snapshot wiring, pure logic
#   M3 forensics — evidence bound to the engagement, sha-256 dedupe, ledger events
#   M4 close — verdict-gated deliverable PDF, streaming route, close fields
# Usage: bash scripts/verify_portal.sh
set -u
BASE="http://localhost:81"
JAR="$(mktemp)"
PW="${ENCLAVE_PASSWORD:-7BP2iox9DhM2cF9LiXwsma}"
SECRET="${PORTAL_INGEST_SECRET:-vtx_portal_7f4c2a91d8e64b35a0c9f1e2d3b4a5c6}"
PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
sig()  { node -e "const c=require('crypto');process.stdout.write(c.createHmac('sha256',process.argv[1]).update(process.argv[2]).digest('hex'))" "$SECRET" "$1"; }

echo "== 0. Cleanup — remove previous verify rows (repeatable runs)"
bun -e "import {PrismaClient} from '@prisma/client'; const db=new PrismaClient(); const e=await db.engagement.deleteMany({where:{ref:{startsWith:'verify_portal_'}}}); const d=await db.auditDocument.deleteMany({where:{fileName:{startsWith:'verify_forensics_'}}}); console.log('  removed', e.count, 'prior verify engagements ·', d.count, 'verify documents'); process.exit(0)" >/dev/null 2>&1 || true

echo "== 1. Enclave auth — POST /api/gate (expect 200 ok)"
code=$(curl -s -o /tmp/gate.json -w "%{http_code}" -c "$JAR" -X POST "$BASE/api/gate" \
  -H 'content-type: application/json' -d "{\"password\":\"$PW\"}")
if [ "$code" = "200" ] && grep -q '"ok":true' /tmp/gate.json; then ok "session cookie issued"; else bad "gate returned $code"; fi

echo "== 2. Pure logic — matcher, domain normalizer, stage machine, next-action engine"
bun -e "
import { normalizeDomain, matchClient, canTransition, nextActionFor, STAGE_TRANSITIONS } from './src/lib/vertebra/portal';
let bad = 0;
const fail = (m: string) => { console.log('  FAIL:', m); bad++ };
// domain normalizer
const cases: Array<[string|null|undefined, string|null]> = [
  ['https://www.GulfCoastValve.com/quote', 'gulfcoastvalve.com'],
  ['WWW.MAPLECLIMATE.CA', 'mapleclimate.ca'],
  ['http://bayoupipe.com', 'bayoupipe.com'],
  ['not a domain', null], ['', null], [null, null], ['localhost', null],
];
for (const [raw, want] of cases) if (normalizeDomain(raw as string) !== want) fail('normalizeDomain ' + JSON.stringify(raw) + ' -> ' + normalizeDomain(raw as string));
// matcher: domain beats name, strangers stay strangers
const book = [{ id: 'p1', name: 'Gulf Coast Valve & Fitting', domain: 'gulfcoastvalve.com' }, { id: 'p2', name: 'Maple Climate Systems', domain: 'mapleclimate.ca' }];
if (matchClient(book, 'Anything LLC', 'https://www.mapleclimate.ca/contact').prospectId !== 'p2') fail('domain match');
if (matchClient(book, 'maple climate systems inc.', null).prospectId !== 'p2') fail('name fallback');
if (matchClient(book, 'Cedar Ridge Fluid Power', 'cedarridgefp.com').prospectId !== null) fail('stranger must stay stranger');
if (matchClient(book, 'Completely Different', null).prospectId !== null) fail('weak name must not match');
// stage machine: adjacent forward, one-step back before commitment, delivered one-way
if (!canTransition('paid', 'intake')) fail('paid->intake');
if (!canTransition('intake', 'paid')) fail('intake->paid (back)');
if (!canTransition('verdict', 'forensics')) fail('verdict->forensics (back)');
if (canTransition('paid', 'verdict')) fail('paid->verdict must be illegal');
if (canTransition('delivered', 'verdict')) fail('delivered must be one-way past verdict');
if (!canTransition('delivered', 'sow') && !canTransition('delivered', 'closed')) fail('delivered exits');
if (canTransition('closed', 'paid')) fail('closed is terminal');
// next-action engine: the desk always knows the next move
if (nextActionFor({ status: 'paid', contactName: null, contactEmail: null, intakeRfqPerMonth: null, intakeLineItems: null }).key !== 'run_intake') fail('paid next action');
if (nextActionFor({ status: 'forensics', contactName: 'x', contactEmail: 'x', intakeRfqPerMonth: 1, intakeLineItems: 1, documentCount: 0 }).key !== 'collect_docs') fail('forensics 0-doc next action');
if (nextActionFor({ status: 'forensics', contactName: 'x', contactEmail: 'x', intakeRfqPerMonth: 1, intakeLineItems: 1, documentCount: 3 }).action.indexOf('3 document') === -1) fail('forensics doc count readout');
if (nextActionFor({ status: 'verdict', contactName: 'x', contactEmail: 'x', intakeRfqPerMonth: 1, intakeLineItems: 1 }).key !== 'record_verdict') fail('undecided verdict next action');
if (nextActionFor({ status: 'verdict', contactName: 'x', contactEmail: 'x', intakeRfqPerMonth: 1, intakeLineItems: 1, guaranteeCleared: true, confirmedLeakageUsd: 12000 }).key !== 'generate_deliverable') fail('decided verdict next action');
if (bad === 0) console.log('  PASS: matcher · normalizer · stage machine · next-action engine all resolve');
process.exit(bad ? 1 : 0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 3. Signed webhook — valid HMAC books the payment, auto-matches the book"
BODY='{"ref":"verify_portal_signed_001","clientName":"Gulf Coast Valve & Fitting","clientDomain":"gulfcoastvalve.com","contactName":"Test Contact","contactEmail":"verify@gulfcoastvalve.com","tier":"diagnostic_audit","amountUsd":3500,"source":"portal_webhook"}'
SIGN=$(sig "$BODY")
code=$(curl -s -o /tmp/ing1.json -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/portal/ingest" \
  -H 'content-type: application/json' -H "x-vertebra-signature: $SIGN" -d "$BODY")
python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
d = json.load(open("/tmp/ing1.json"))
created = code == "201" and not d.get("duplicate")
duped = code == "200" and d.get("duplicate") is True
if not (created or duped):
    print(f"  FAIL: HTTP {code} · {d}"); sys.exit(1)
e = d.get("engagement", {})
ok_match = e.get("matched") is True and e.get("matchedVia") == "domain" and e.get("prospectId")
print(f"  {'PASS' if ok_match else 'FAIL'}: {'created' if created else 'duplicate (prior run)'} · matched={e.get('matched')} via={e.get('matchedVia')}")
sys.exit(0 if ok_match else 1)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 4. Idempotency — same ref replayed returns the existing row, ledger unchanged"
BODY='{"ref":"verify_portal_signed_001","clientName":"Gulf Coast Valve & Fitting","clientDomain":"gulfcoastvalve.com","contactName":"Test Contact","contactEmail":"verify@gulfcoastvalve.com","tier":"diagnostic_audit","amountUsd":3500,"source":"portal_webhook"}'
SIGN=$(sig "$BODY")
code=$(curl -s -o /tmp/ing2.json -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/portal/ingest" \
  -H 'content-type: application/json' -H "x-vertebra-signature: $SIGN" -d "$BODY")
python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
d = json.load(open("/tmp/ing2.json"))
if code == "200" and d.get("duplicate") is True and d.get("engagement", {}).get("ref") == "verify_portal_signed_001":
    print("  PASS: replay returned the original row — no double-booking")
    sys.exit(0)
print(f"  FAIL: HTTP {code} · {d}")
sys.exit(1)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 5. Signature enforcement — tampered HMAC refused, unsigned webhook-looking payload refused"
BAD_SIGN=$(printf '%060d' 0 | tr '0' 'a')
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/portal/ingest" \
  -H 'content-type: application/json' -H "x-vertebra-signature: $BAD_SIGN" \
  -d '{"ref":"verify_portal_evil_001","clientName":"Evil Co","amountUsd":1}')
[ "$code" = "401" ] && ok "tampered signature -> 401" || bad "tampered signature returned $code"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/portal/ingest" \
  -H 'content-type: application/json' \
  -d '{"ref":"verify_portal_evil_002","clientName":"Sneaky Co","amountUsd":1,"tier":"diagnostic_audit"}')
[ "$code" = "401" ] && ok "unsigned non-manual payload -> 401" || bad "unsigned payload returned $code"

echo "== 6. Manual door — explicit source:manual books without a signature"
code=$(curl -s -o /tmp/ing3.json -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/portal/ingest" \
  -H 'content-type: application/json' \
  -d '{"ref":"verify_portal_manual_001","clientName":"Gulf Coast Valve & Fitting","clientDomain":"gulfcoastvalve.com","tier":"diagnostic_audit","amountUsd":3500,"source":"manual"}')
python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
d = json.load(open("/tmp/ing3.json"))
created = code == "201" and not d.get("duplicate")
duped = code == "200" and d.get("duplicate") is True
if not (created or duped):
    print(f"  FAIL: HTTP {code} · {d}"); sys.exit(1)
e = d.get("engagement", {})
if e.get("matched") is not True:
    print(f"  FAIL: manual ingest should still auto-match · {e}"); sys.exit(1)
print("  PASS: manual door books and auto-matches" + (" (created)" if created else " (duplicate from prior run)"))
sys.exit(0)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 7. Payload validation — missing clientName refused"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/portal/ingest" \
  -H 'content-type: application/json' \
  -d '{"ref":"verify_portal_invalid_001","amountUsd":3500,"source":"manual"}')
[ "$code" = "400" ] && ok "invalid payload -> 400" || bad "invalid payload returned $code"

echo "== 8. Stage machine — illegal jumps refused, delivered gate enforced, verdict recorded"
ENG=$(bun -e "
import {PrismaClient} from '@prisma/client';
const db = new PrismaClient();
const g = await db.engagement.create({ data: {
  ref: 'verify_portal_flow_001', clientName: 'Verify Flow Co', clientDomain: null,
  tier: 'diagnostic_audit', amountUsd: 3500, source: 'manual', status: 'paid',
  events: { create: { kind: 'ingested', actor: 'operator', detail: 'verify fixture' } },
} });
console.log(g.id); process.exit(0);
")
patch() { curl -s -o /tmp/patch.json -w "%{http_code}" -b "$JAR" -X PATCH "$BASE/api/portal/engagements/$ENG" -H 'content-type: application/json' -d "$1"; }
code=$(patch '{"op":"stage","to":"verdict"}')
[ "$code" = "409" ] && ok "paid -> verdict jump refused (409)" || bad "illegal jump returned $code"
code=$(patch '{"op":"stage","to":"intake"}')
[ "$code" = "200" ] && ok "paid -> intake" || bad "paid->intake returned $code"
code=$(patch '{"op":"intake","rfqPerMonth":95,"lineItems":21}')
[ "$code" = "200" ] && ok "intake recorded" || bad "intake op returned $code"
patch '{"op":"stage","to":"forensics"}' >/dev/null
code=$(patch '{"op":"stage","to":"verdict"}')
[ "$code" = "200" ] && ok "forensics -> verdict" || bad "forensics->verdict returned $code"
code=$(patch '{"op":"stage","to":"delivered"}')
[ "$code" = "409" ] && ok "delivered refused without a recorded verdict (the \$10,000 guarantee gate)" || bad "verdict gate returned $code"
code=$(patch '{"op":"verdict","confirmedLeakageUsd":12500,"guaranteeCleared":true,"note":"verify verdict"}')
[ "$code" = "200" ] && ok "verdict recorded — guarantee CLEARED at \$12,500" || bad "verdict op returned $code"
code=$(patch '{"op":"stage","to":"delivered"}')
[ "$code" = "200" ] && ok "verdict -> delivered after the gate" || bad "delivered after verdict returned $code"
code=$(patch '{"op":"stage","to":"verdict"}')
[ "$code" = "409" ] && ok "delivered is one-way — no silent reopen" || bad "delivered reopen returned $code"
code=$(patch '{"op":"note","note":"operator verify note"}')
[ "$code" = "200" ] && ok "note op appends to the trail" || bad "note op returned $code"

echo "== 9. Event trail — the ledger recorded every movement"
bun -e "
import {PrismaClient} from '@prisma/client';
const db = new PrismaClient();
const evs = await db.engagementEvent.findMany({ where: { engagementId: process.argv[1] ?? '$ENG' }, orderBy: { createdAt: 'asc' } });
const kinds = evs.map(e => e.kind);
const need = ['ingested', 'stage_changed', 'verdict_recorded', 'delivered'];
const missing = need.filter(k => !kinds.includes(k));
if (missing.length === 0 && evs.length >= 8) {
  console.log('  PASS:', evs.length, 'events ·', kinds.join(' → ').slice(0, 160));
  process.exit(0);
}
console.log('  FAIL: trail incomplete —', JSON.stringify(kinds));
process.exit(1);
" "$ENG"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 10. Snapshot wiring — /api/command carries the engagement ledger"
curl -s -b "$JAR" -o /tmp/cmd_portal.json "$BASE/api/command"
python3 << 'PY'
import json, sys
d = json.load(open("/tmp/cmd_portal.json"))
engs = d.get("engagements")
if not isinstance(engs, list) or len(engs) < 3:
    print(f"  FAIL: engagements missing or sparse ({len(engs) if isinstance(engs, list) else type(engs).__name__})"); sys.exit(1)
by_ref = {e["ref"]: e for e in engs}
northline = by_ref.get("pay_landing_northline_7710")
gulf = by_ref.get("pay_landing_gulfcoast_9203")
cedar = by_ref.get("pay_landing_cedar_ridge_4471")
problems = []
if not northline or northline.get("prospectName") != "Northline Electric Supply": problems.append("northline match/read-model")
if northline and (northline.get("guaranteeCleared") is not True or northline.get("confirmedLeakageUsd") != 28400): problems.append("northline verdict fields")
if not gulf or gulf.get("prospectId") is None: problems.append("gulf match")
if not cedar or cedar.get("prospectId") is not None: problems.append("cedar must stay unmatched")
for e in engs:
    for f in ("ref", "clientName", "status", "amountUsd", "paidAtMs", "documentCount", "events"):
        if f not in e: problems.append(f"missing field {f}"); break
if problems:
    print("  FAIL:", ", ".join(problems)); sys.exit(1)
live = [e for e in engs if not e["ref"].startswith("verify_portal_")]
print(f"  PASS: {len(engs)} rows on the ledger · statuses {sorted(set(e['status'] for e in live))} · trail + verdict fields live")
sys.exit(0)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 11. Cleanup — verify rows removed, the desk keeps only honest fixtures"
bun -e "
import {PrismaClient} from '@prisma/client';
const db = new PrismaClient();
const r = await db.engagement.deleteMany({ where: { ref: { startsWith: 'verify_portal_' } } });
const total = await db.engagement.count();
console.log('  PASS: removed', r.count, 'verify rows ·', total, 'fixture engagements remain');
process.exit(0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 12. Kenya-free discipline — portal surfaces carry zero stale references"
if rg -qi "kenya|nairobi|lappset" src/lib/vertebra/portal.ts src/app/api/portal/ scripts/seed_portal.ts prisma/schema.prisma 2>/dev/null; then
  bad "stale references found in portal surfaces"
else ok "portal surfaces are clean"; fi

# ---------------------------------------------------------------------------
# M3 — forensics: evidence sealed to the engagement
# ---------------------------------------------------------------------------

echo "== 13. M3 forensics — book a verify engagement, run it to forensics"
ENG3=$(curl -s -b "$JAR" -X POST "$BASE/api/portal/ingest" \
  -H 'content-type: application/json' \
  -d '{"ref":"verify_portal_m3_001","clientName":"Gulf Coast Valve & Fitting","clientDomain":"gulfcoastvalve.com","contactName":"Forensics Contact","contactEmail":"forensics@gulfcoastvalve.com","tier":"diagnostic_audit","amountUsd":3500,"source":"manual","intake":{"rfqPerMonth":140,"lineItems":26}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('engagement',{}).get('id',''))")
[ -n "$ENG3" ] && ok "verify engagement booked ($ENG3)" || bad "verify engagement booking failed"
curl -s -o /dev/null -b "$JAR" -X PATCH "$BASE/api/portal/engagements/$ENG3" -H 'content-type: application/json' -d '{"op":"stage","to":"intake"}'
curl -s -o /dev/null -b "$JAR" -X PATCH "$BASE/api/portal/engagements/$ENG3" -H 'content-type: application/json' -d '{"op":"intake","rfqPerMonth":140,"lineItems":26}'
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X PATCH "$BASE/api/portal/engagements/$ENG3" -H 'content-type: application/json' -d '{"op":"stage","to":"forensics"}')
[ "$code" = "200" ] && ok "engagement moved to forensics" || bad "forensics move returned $code"

echo "== 14. M3 evidence — upload binds to the engagement, ledger records the arrival"
cat > /tmp/verify_forensics_quotes.csv << 'CSV'
SKU,QTY,UNIT PRICE,DESCRIPTION
GV-4410,12,184.50,butterfly valve 4in wafer
GV-8820,4,612.00,check valve 8in flanged
EL-MCC-210,36,44.25,motor contactor 210A
SPA-REF-77,1,0.00,special pricing agreement addendum line
CSV
curl -s -o /tmp/up1.json -b "$JAR" -X POST "$BASE/api/audit/parse" \
  -F "file=@/tmp/verify_forensics_quotes.csv;type=text/csv" -F "engagementId=$ENG3"
python3 << 'PY'
import json
d = json.load(open("/tmp/up1.json"))
assert d.get("ok") and d.get("documentId"), f"upload failed: {d}"
assert d.get("lineItems", 0) >= 3, f"line-item detection lost: {d}"
print(f"  PASS: evidence parsed · {d['lineItems']} line items · {d['extraction']}")
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
if bun -e "
import {PrismaClient} from '@prisma/client';
const db = new PrismaClient();
const ev = await db.engagementEvent.findFirst({ where: { engagementId: '$ENG3', kind: 'document_added' } });
if (!ev) { console.log('  FAIL: document_added event missing'); process.exit(1); }
console.log('  PASS: ledger recorded ·', ev.detail);
process.exit(0);
"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo "== 15. M3 dedupe — identical bytes resolve to the existing document"
curl -s -o /tmp/up2.json -b "$JAR" -X POST "$BASE/api/audit/parse" \
  -F "file=@/tmp/verify_forensics_quotes.csv;type=text/csv" -F "engagementId=$ENG3"
DOCS=$(bun -e "
import {PrismaClient} from '@prisma/client';
const db = new PrismaClient();
const n = await db.auditDocument.count({ where: { engagementId: '$ENG3' } });
console.log(n); process.exit(0);
")
python3 - "$DOCS" << 'PY'
import json, sys
d = json.load(open("/tmp/up2.json"))
docs = int(sys.argv[1])
if d.get("duplicate") is True and docs == 1:
    print("  PASS: replay flagged duplicate · locker holds exactly 1 document")
    sys.exit(0)
print(f"  FAIL: duplicate={d.get('duplicate')} docs={docs}")
sys.exit(1)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 16. M4 gate — deliverable refused while the verdict is undecided"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/portal/engagements/$ENG3/deliver")
[ "$code" = "409" ] && ok "deliver refused without a recorded verdict (409)" || bad "deliver gate returned $code"

echo "== 17. M4 close — verdict recorded, deliverable generated, streamed, delivered"
curl -s -o /dev/null -b "$JAR" -X PATCH "$BASE/api/portal/engagements/$ENG3" -H 'content-type: application/json' -d '{"op":"stage","to":"verdict"}'
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X PATCH "$BASE/api/portal/engagements/$ENG3" \
  -H 'content-type: application/json' \
  -d '{"op":"verdict","confirmedLeakageUsd":14200,"guaranteeCleared":true,"note":"verify verdict — crosscheck panel suggested 13968"}')
[ "$code" = "200" ] && ok "verdict recorded — \$14,200 recoverable, guarantee CLEARED" || bad "verdict op returned $code"
curl -s -o /tmp/deliver.json -b "$JAR" -X POST "$BASE/api/portal/engagements/$ENG3/deliver"
python3 << 'PY'
import json
d = json.load(open("/tmp/deliver.json"))
assert d.get("ok") and d.get("deliverableUrl") and d.get("bytes", 0) > 1000, f"deliver failed: {d}"
print(f"  PASS: deliverable generated · {d['bytes']} bytes · seal {d.get('seal')}")
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
curl -s -b "$JAR" -o /tmp/deliverable.pdf "$BASE/api/portal/engagements/$ENG3/deliverable"
if head -c 5 /tmp/deliverable.pdf | grep -q "%PDF" && [ "$(stat -c%s /tmp/deliverable.pdf)" -gt 1000 ]; then
  ok "deliverable streams — valid PDF ($(stat -c%s /tmp/deliverable.pdf) bytes)"
else bad "deliverable stream invalid"; fi
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X PATCH "$BASE/api/portal/engagements/$ENG3" -H 'content-type: application/json' -d '{"op":"stage","to":"delivered"}')
[ "$code" = "200" ] && ok "verdict → delivered — the full contract arc ran" || bad "delivered after deliver returned $code"
bun -e "
import {PrismaClient} from '@prisma/client';
const db = new PrismaClient();
const gens = await db.engagementEvent.count({ where: { engagementId: '$ENG3', kind: 'deliverable_generated' } });
const del = await db.engagementEvent.count({ where: { engagementId: '$ENG3', kind: 'delivered' } });
if (gens >= 1 && del >= 1) { console.log('  PASS: deliverable_generated + delivered events on the trail'); process.exit(0); }
console.log('  FAIL: gens', gens, 'del', del); process.exit(1);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 18. M4 snapshot — deliverable URL + evidence array live on the read model"
curl -s -b "$JAR" -o /tmp/cmd_m4.json "$BASE/api/command"
python3 << 'PY'
import json, sys
d = json.load(open("/tmp/cmd_m4.json"))
engs = {e["ref"]: e for e in d.get("engagements", [])}
e = engs.get("verify_portal_m3_001")
assert e, "verify engagement missing from snapshot"
assert e["deliverableUrl"], f"deliverableUrl missing: {e.get('deliverableUrl')}"
assert len(e.get("documents") or []) == 1, f"documents array wrong: {len(e.get('documents') or [])}"
doc = e["documents"][0]
for f in ("fileName", "sizeBytes", "sha256", "pages", "lineItems", "extraction", "createdAtMs"):
    assert f in doc, f"document field {f} missing"
print(f"  PASS: snapshot carries deliverableUrl + {len(e['documents'])} sealed document(s) · {doc['lineItems']} line items")
sys.exit(0)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 19. Cleanup — verify rows, documents and artifact removed"
bun -e "
import {PrismaClient} from '@prisma/client';
import { unlinkSync, existsSync } from 'node:fs';
const db = new PrismaClient();
const eng = await db.engagement.findUnique({ where: { ref: 'verify_portal_m3_001' }, select: { id: true } });
if (eng) {
  await db.auditDocument.deleteMany({ where: { engagementId: eng.id } });
  await db.engagement.delete({ where: { id: eng.id } });
  const p = 'db/deliverables/' + eng.id + '.pdf';
  try { if (existsSync(p)) unlinkSync(p); } catch {}
}
const total = await db.engagement.count();
console.log('  PASS: verify arc removed ·', total, 'fixture engagements remain');
process.exit(0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

rm -f "$JAR" /tmp/gate.json /tmp/ing1.json /tmp/ing2.json /tmp/ing3.json /tmp/patch.json /tmp/cmd_portal.json \
  /tmp/up1.json /tmp/up2.json /tmp/deliver.json /tmp/deliverable.pdf /tmp/cmd_m4.json /tmp/verify_forensics_quotes.csv
echo
echo "portal ledger verification: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
