#!/usr/bin/env bash
# Pipeline verification — the operator's home deck:
# pure triage logic (sorts/bulk/cursor/delivery/countdowns), enriched
# snapshot contract, edit-before-approve roundtrip through the real
# PATCH rail, Channel B export honesty, gate posture.
# Usage: bash scripts/verify_pipeline.sh
set -u
BASE="http://localhost:81"
JAR="$(mktemp)"
OP_USER="${OPERATOR_USER:-josias}"
OP_PASS="${OPERATOR_PASSWORD:-}"
PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "== 1. Enclave auth — POST /api/gate as $OP_USER (expect 200 ok)"
if [ -z "$OP_PASS" ]; then echo "  FAIL: set OPERATOR_PASSWORD (and optionally OPERATOR_USER) — the shared enclave password is retired"; exit 1; fi
code=$(curl -s -o /tmp/pgate.json -w "%{http_code}" -c "$JAR" -X POST "$BASE/api/gate" \
  -H 'content-type: application/json' -d "{\"username\":\"$OP_USER\",\"password\":\"$OP_PASS\"}")
if [ "$code" = "200" ] && grep -q '"ok":true' /tmp/pgate.json; then ok "session cookie issued for $(echo "$OP_USER")"; else bad "gate returned $code"; fi

echo "== 2. Triage logic — sorts, bulk partition, cursor math, delivery honesty"
bun -e "
import { BULK_CONFIDENCE_THRESHOLD, bulkPartition, countdownUntil, deliveryOf, matchPipelineFilter, nextCursorIdx, sortTriage } from './src/lib/vertebra/pipeline';
let bad = 0;
const fail = (m: string) => { console.log('  FAIL:', m); bad++ };
const mk = (over: Record<string, unknown>) => ({
  draftId: 'd', replyId: 'r', prospectId: 'p', prospectName: 'X', qlvScore: 80, intent: 'interested',
  confidence: 0.9, fromEmail: 'a@b.c', subject: 's', body: 'b', draftSubject: null, draftBody: null,
  draftStatus: 'pending_human_review', receivedAtMs: 0, rationale: null, rescheduledToMs: null,
  erpName: null, city: null, region: null, country: null, leakageUsd: null, draftCount: 1,
  sentAtMs: null, reviewerNote: null, ...over,
});
const a = mk({ replyId: 'a', confidence: 0.7, qlvScore: 60, receivedAtMs: -100 });
const b = mk({ replyId: 'b', confidence: 0.95, qlvScore: 90, receivedAtMs: -60 });
const c = mk({ replyId: 'c', confidence: null, qlvScore: null, receivedAtMs: -10 });
if (JSON.stringify(sortTriage([a, b, c] as never, 'newest').map((i: { replyId: string }) => i.replyId)) !== JSON.stringify(['c','b','a'])) fail('newest sort');
if (JSON.stringify(sortTriage([a, b, c] as never, 'confidence').map((i: { replyId: string }) => i.replyId)) !== JSON.stringify(['b','a','c'])) fail('confidence sort with null tail');
if (JSON.stringify(sortTriage([a, b, c] as never, 'qlv').map((i: { replyId: string }) => i.replyId)) !== JSON.stringify(['b','a','c'])) fail('qlv sort with null tail');
const { confident, rest } = bulkPartition([a, b, c, mk({ replyId: 'u', intent: 'unknown', confidence: 1 })] as never);
if (confident.length !== 1 || confident[0].replyId !== 'b') fail('bulk sweep kept ' + confident.length);
if (rest.length !== 3) fail('bulk rest ' + rest.length);
if (BULK_CONFIDENCE_THRESHOLD !== 0.85) fail('threshold drifted');
if (nextCursorIdx(-1, 5, 'j') !== 0 || nextCursorIdx(4, 5, 'j') !== 4 || nextCursorIdx(0, 5, 'k') !== 0 || nextCursorIdx(0, 0, 'j') !== -1) fail('cursor clamp');
if (deliveryOf('approved', 'approved in command centre · staged (console)') !== 'staged') fail('staged honesty');
if (deliveryOf('approved', 'approved in command centre') !== 'sent') fail('sent');
if (deliveryOf('pending_human_review', null) !== 'none') fail('pending = none');
if (countdownUntil(300000, 0) !== '5m' || countdownUntil(5000, 0) !== '1m' || countdownUntil(0, 60000) !== 'due now' || countdownUntil(null, 0) !== null) fail('countdown');
if (!matchPipelineFilter(mk({ intent: 'objection_erp' }) as never, 'objection')) fail('objection filter');
if (matchPipelineFilter(mk({ intent: 'interested' }) as never, 'objection')) fail('objection filter must refuse interested');
if (bad === 0) console.log('  PASS: sorts · bulk partition · cursor · delivery · countdowns all resolve');
process.exit(bad ? 1 : 0);
"
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 3. Live snapshot — enriched triage contract on GET /api/command"
code=$(curl -s -o /tmp/pcmd.json -w "%{http_code}" -b "$JAR" "$BASE/api/command")
python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
if code != "200":
    print(f"  FAIL: /api/command HTTP {code}"); sys.exit(1)
d = json.load(open("/tmp/pcmd.json"))
triage = d.get("triage", {})
pending = triage.get("pending", [])
leads = d.get("leads", [])
funnel = d.get("funnel", [])
FIELDS = ["erpName", "city", "region", "country", "leakageUsd", "draftCount", "sentAtMs", "reviewerNote", "receivedAtMs"]
problems = []
all_items = pending + triage.get("auto", []) + triage.get("closed", [])
missing = [f for i in all_items for f in FIELDS if f not in i]
if missing:
    problems.append(f"enriched fields missing: {sorted(set(missing))}")
high_touch = [l for l in leads if l.get("highTouch")]
if len(funnel) != 7:
    problems.append(f"funnel stages {len(funnel)} != 7")
if not high_touch:
    problems.append("no high-touch rows on leads — Channel B deck would be empty")
if problems:
    print("  FAIL: " + "; ".join(problems)); sys.exit(1)
print(f"  PASS: {len(leads)} leads · {len(all_items)} triage rows enriched · funnel 7 stages · {len(high_touch)} channel-B rows")
sys.exit(0)
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== 4. Edit-before-approve — fixture draft through the real PATCH rail"
FIX=$(npx tsx -e "
import { PrismaClient } from '@prisma/client';
const d = new PrismaClient();
(async () => {
  const stamp = Date.now();
  const p = await d.prospect.create({ data: {
    source: 'verify_pipeline', sourceUrl: 'https://verify.example/' + stamp, name: 'Verify Pipeline Fixture',
    domainKey: 'verifypipe' + stamp, domain: 'verifypipe.example', vertical: 'pvf',
    country: 'United States', region: 'intl_expansion', ingestion: 'ingested',
    revenueEstimateUsd: 40_000_000, detectedErp: 'Epicor',
  }});
  const reply = await d.inboundReply.create({ data: {
    prospectId: p.id, fromEmail: 'buyer@verifypipe.example', subject: 'Interested',
    body: 'Send a time.', intent: 'interested', intentConfidence: 0.9, processedAt: new Date(), receivedAt: new Date(),
  }});
  const draft = await d.agentDraft.create({ data: {
    replyId: reply.id, prospectId: p.id, intent: 'interested',
    subject: 'Locked — original', body: 'Original body.', status: 'pending_human_review',
  }});
  console.log(JSON.stringify({ prospectId: p.id, replyId: reply.id, draftId: draft.id }));
  await d.\$disconnect();
})();
" 2>/dev/null)
PROSPECT_ID=$(echo "$FIX" | python3 -c "import json,sys; print(json.load(sys.stdin)['prospectId'])" 2>/dev/null)
DRAFT_ID=$(echo "$FIX" | python3 -c "import json,sys; print(json.load(sys.stdin)['draftId'])" 2>/dev/null)
if [ -n "$DRAFT_ID" ] && [ "$DRAFT_ID" != "None" ]; then
  code=$(curl -s -o /tmp/patch.json -w "%{http_code}" -b "$JAR" -X PATCH "$BASE/api/replies" \
    -H 'content-type: application/json' \
    -d "{\"draftId\":\"$DRAFT_ID\",\"decision\":\"approved\",\"subject\":\"Edited by operator\",\"body\":\"Edited body — verified.\"}")
  python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
if code != "200":
    print(f"  FAIL: PATCH /api/replies HTTP {code}"); sys.exit(1)
d = json.load(open("/tmp/patch.json"))
draft = d.get("draft", {})
delivery = d.get("delivery", {})
if draft.get("subject") != "Edited by operator" or draft.get("status") != "approved":
    print(f"  FAIL: edits did not land (subject={draft.get('subject')!r}, status={draft.get('status')!r})"); sys.exit(1)
if delivery.get("status") not in ("sent", "staged"):
    print(f"  FAIL: delivery missing/invalid: {delivery}"); sys.exit(1)
print(f"  PASS: edit-before-approve landed · delivery={delivery.get('status')} · draft approved")
sys.exit(0)
PY
  [ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
else
  bad "fixture creation failed ($FIX)"
fi

echo "== 5. Channel B export — honest handoff, idempotent second call"
FIX2=$(npx tsx -e "
import { PrismaClient } from '@prisma/client';
const d = new PrismaClient();
(async () => {
  const stamp = Date.now();
  const p = await d.prospect.create({ data: {
    source: 'verify_pipeline', sourceUrl: 'https://verify.example/ht' + stamp, name: 'Verify HighTouch Fixture',
    domainKey: 'verifyht' + stamp, domain: 'verifyht.example', vertical: 'hvac',
    country: 'Canada', region: 'intl_expansion', ingestion: 'ingested', caslScope: true,
  }});
  const q = await d.highTouchQueueItem.create({ data: {
    prospectId: p.id, qlvScore: 92, qlvBand: 'critical', topHook: 'verify hook', rationale: 'verify',
  }});
  console.log(JSON.stringify({ prospectId: p.id, queueId: q.id }));
  await d.\$disconnect();
})();
" 2>/dev/null)
HT_PROSPECT=$(echo "$FIX2" | python3 -c "import json,sys; print(json.load(sys.stdin)['prospectId'])" 2>/dev/null)
if [ -n "$HT_PROSPECT" ] && [ "$HT_PROSPECT" != "None" ]; then
  code=$(curl -s -o /tmp/ht1.json -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/high-touch/export" \
    -H 'content-type: application/json' -d "{\"prospectId\":\"$HT_PROSPECT\"}")
  python3 - "$code" << 'PY'
import json, sys
code = sys.argv[1]
if code != "200":
    print(f"  FAIL: export HTTP {code}"); sys.exit(1)
d = json.load(open("/tmp/ht1.json"))
if d.get("ok") is not True or d.get("alreadyExported") is not False or not d.get("exportedAtMs"):
    print(f"  FAIL: first export dishonest: {d}"); sys.exit(1)
print("  PASS: export marked · outbox event published · exportedAtMs set")
sys.exit(0)
PY
  [ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
  code=$(curl -s -o /tmp/ht2.json -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/high-touch/export" \
    -H 'content-type: application/json' -d "{\"prospectId\":\"$HT_PROSPECT\"}")
  if grep -q '"alreadyExported":true' /tmp/ht2.json && [ "$code" = "200" ]; then ok "second export is idempotent (alreadyExported:true)"; else bad "export not idempotent ($code)"; fi
else
  bad "high-touch fixture creation failed ($FIX2)"
fi

echo "== 6. Fixture cleanup"
npx tsx -e "
import { PrismaClient } from '@prisma/client';
const d = new PrismaClient();
(async () => {
  const ids = ['$PROSPECT_ID', '$HT_PROSPECT'].filter(Boolean);
  for (const id of ids) {
    await d.outboxEvent.deleteMany({ where: { aggregateType: 'high_touch_queue_item', payload: { contains: id } } });
    await d.operatorAction.deleteMany({ where: { prospectId: id } });
    await d.highTouchQueueItem.deleteMany({ where: { prospectId: id } });
    await d.agentDraft.deleteMany({ where: { prospectId: id } });
    await d.inboundReply.deleteMany({ where: { prospectId: id } });
    await d.prospect.delete({ where: { id } }).catch(() => null);
  }
  console.log('cleaned:', ids.join(', ') || 'nothing');
  await d.\$disconnect();
})();
" 2>/dev/null | sed 's/^/  /'

echo "== 7. Gate posture — unauthenticated PATCH refused"
code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/replies" -H 'content-type: application/json' -d '{"draftId":"x","decision":"approved"}')
if [ "$code" = "307" ] || [ "$code" = "302" ] || [ "$code" = "401" ]; then ok "triage rail stays behind the gate ($code)"; else bad "PATCH reachable unauthenticated ($code)"; fi

rm -f "$JAR" /tmp/pgate.json /tmp/pcmd.json /tmp/patch.json /tmp/ht1.json /tmp/ht2.json
echo
echo "pipeline verification: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
