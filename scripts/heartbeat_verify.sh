#!/usr/bin/env bash
# M4 engine-contract verification — signed heartbeat round-trip:
#   1. unsigned  → expect 401
#   2. ok pulse  → expect 200 { ok: true, deduped: false }
#   3. same ref  → expect 200 { deduped: true }   (idempotency)
#   4. fail pulse → expect 200, then the deck rings crit
set -e
BASE="http://localhost:3000/api/ops/heartbeat"
SECRET="$(rg '^OPS_HEARTBEAT_SECRET=(.+)$' -r '$1' /home/z/my-project/.env | head -1 | tr -d '\"')"
COOKIE="$(agent-browser cookies 2>/dev/null | rg '^enclave_session=' | head -1 | tr -d '\r')"
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //'; }
CURL="curl -s -H Cookie:$COOKIE"

BODY_OK='{"engineId":"turnaround-core","pulseRef":"verify-run-001","watchId":"parse_queue","status":"ok","detail":"verification pulse · queue drained · 3 docs parsed","expectEveryMs":300000}'
BODY_FAIL='{"engineId":"turnaround-core","pulseRef":"verify-run-002","watchId":"pdf_render","status":"fail","detail":"renderer crashed on brief build — retry scheduled"}'

echo "1) unsigned:"
$CURL -o /dev/null -w "%{http_code}\n" -X POST "$BASE" -H 'content-type: application/json' -d "$BODY_OK"

SIG_OK="$(sign "$BODY_OK")"
echo "2) signed ok pulse:"
$CURL -X POST "$BASE" -H 'content-type: application/json' -H "x-vertebra-signature: $SIG_OK" -d "$BODY_OK"
echo

echo "3) same pulseRef again (idempotency):"
$CURL -X POST "$BASE" -H 'content-type: application/json' -H "x-vertebra-signature: $SIG_OK" -d "$BODY_OK"
echo

SIG_FAIL="$(sign "$BODY_FAIL")"
echo "4) signed fail pulse:"
$CURL -X POST "$BASE" -H 'content-type: application/json' -H "x-vertebra-signature: $SIG_FAIL" -d "$BODY_FAIL"
echo
