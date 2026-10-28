#!/usr/bin/env bash
# Task 9 verification — invite lifecycle + rate limiting + epoch sessions.
# Server must be running on :3000 (TURN env state irrelevant to auth flows).
set -u
BASE=http://localhost:3000
J='Content-Type: application/json'
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
assert() { # assert <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1 (got $3)"; else bad "$1 (want $2, got $3)"; fi
}

code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "── A. Seeded login + baseline session ─────────────────────"
S=$(mktemp)
assert "login with seeded Apex code" 200 "$(code -c "$S" -X POST $BASE/portal/api/login -H "$J" -d '{"tenantName":"Apex Piping & Supply","accessCode":"apex-defend-26"}')"
assert "enclave readable with session (epoch 0)" 200 "$(code -b "$S" $BASE/portal/api/enclave)"

echo "── B. Invite issue → rotation → epoch kill ────────────────"
RESP=$(curl -s -X POST $BASE/api/invites -H "$J" -d '{"tenantName":"Apex Piping & Supply","issuedBy":"Damon"}')
NEWCODE=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])' 2>/dev/null)
[ -n "$NEWCODE" ] && ok "issue returns plaintext code once ($NEWCODE)" || bad "issue returned no code"
assert "old session killed by epoch bump (enclave 401)" 401 "$(code -b "$S" $BASE/portal/api/enclave)"
assert "old seeded code rejected after rotate" 401 "$(code -X POST $BASE/portal/api/login -H "$J" -d '{"tenantName":"Apex Piping & Supply","accessCode":"apex-defend-26"}')"
assert "new code accepted" 200 "$(code -c "$S" -X POST $BASE/portal/api/login -H "$J" -d "{\"tenantName\":\"Apex Piping & Supply\",\"accessCode\":\"$NEWCODE\"}")"
assert "enclave readable with new session" 200 "$(code -b "$S" $BASE/portal/api/enclave)"

echo "── C. Revoke → disabled portal → re-invite ────────────────"
G=$(mktemp)
assert "revoke Gulf access" 200 "$(code -X POST $BASE/api/invites -H "$J" -d '{"tenantName":"Gulf Coast Valve & Fitting","action":"revoke"}')"
assert "seeded Gulf code now refused (403 disabled)" 403 "$(code -X POST $BASE/portal/api/login -H "$J" -d '{"tenantName":"Gulf Coast Valve & Fitting","accessCode":"gulf-pilot-26"}')"
RG=$(curl -s -X POST $BASE/api/invites -H "$J" -d '{"tenantName":"Gulf Coast Valve & Fitting","issuedBy":"Josias"}')
GULFCODE=$(echo "$RG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])' 2>/dev/null)
[ -n "$GULFCODE" ] && ok "re-invite issues fresh code ($GULFCODE)" || bad "re-invite returned no code"
assert "fresh Gulf code accepted" 200 "$(code -X POST $BASE/portal/api/login -H "$J" -d "{\"tenantName\":\"Gulf Coast Valve & Fitting\",\"accessCode\":\"$GULFCODE\"}")"

echo "── D. GET /api/invites audit trail ────────────────────────"
TRAIL=$(curl -s $BASE/api/invites | python3 -c '
import sys,json
d=json.load(sys.stdin)
apex=[i for i in d["invites"] if i["tenantName"]=="Apex Piping & Supply" and i["status"]!="REVOKED"]
gulf_rev=[i for i in d["invites"] if i["tenantName"]=="Gulf Coast Valve & Fitting" and i["status"]=="REVOKED"]
acc=[a for a in d["access"] if a["name"]=="Apex Piping & Supply"]
print(f"{len(apex)>0}|{len(gulf_rev)>0}|{acc[0]["hasCode"] if acc else False}")')
[ "$TRAIL" = "True|True|True" ] && ok "audit trail: active apex invite, revoked gulf history, hasCode" || bad "audit trail shape: $TRAIL"

echo "── E. Login rate limiting (Midwest) ───────────────────────"
M='{"tenantName":"Midwest Trade Wholesale","accessCode":"wrong-guess"}'
for i in 1 2 3 4 5; do
  C=$(code -X POST $BASE/portal/api/login -H "$J" -d "$M")
  assert "wrong attempt $i → 401" 401 "$C"
done
C6=$(curl -s -i -X POST $BASE/portal/api/login -H "$J" -d "$M" | head -1)
case "$C6" in HTTP/1.1\ 429*) ok "6th wrong attempt → 429 ($C6)";; *) bad "6th wrong attempt → 429 (got $C6)";; esac
RETRY=$(curl -s -D - -o /dev/null -X POST $BASE/portal/api/login -H "$J" -d "$M" | rg -i "^retry-after:" | tr -dc 0-9)
[ -n "$RETRY" ] && ok "Retry-After header present ($RETRY s)" || bad "no Retry-After header"
assert "correct code ALSO blocked while locked" 429 "$(code -X POST $BASE/portal/api/login -H "$J" -d '{"tenantName":"Midwest Trade Wholesale","accessCode":"midwest-defend-26"}')"
SEC=$(python3 -c 'import sqlite3;print(sqlite3.connect("/home/z/my-project/db/custom.db").execute("SELECT COUNT(*) FROM Notification WHERE channel=\"SECURITY\" AND payload LIKE \"%LOGIN_LOCKOUT%\"").fetchone()[0])')
assert "SECURITY lockout row in ledger" 1 "$SEC"
EMAIL=$(python3 -c 'import sqlite3;print(sqlite3.connect("/home/z/my-project/db/custom.db").execute("SELECT COUNT(*) FROM Notification WHERE channel=\"EMAIL\"").fetchone()[0])')
[ "${EMAIL:-0}" -ge 2 ] && ok "EMAIL outbox rows for invites ($EMAIL)" || bad "EMAIL outbox rows missing ($EMAIL)"

echo "── F. Per-IP burst cap (30/min) ───────────────────────────"
BURST=0
for i in $(seq 1 22); do
  C=$(code -X POST $BASE/portal/api/login -H "$J" -d '{"tenantName":"Summit Industrial Fasteners","accessCode":"x"}')
  [ "$C" = "429" ] && BURST=1
done
assert "burst cap engages within window" 1 "$BURST"

echo "── G. Result ──────────────────────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
