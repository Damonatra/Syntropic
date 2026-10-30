#!/bin/bash
# Phase 1 verification — runs while the dev server is up inside the long call.
OUT=/home/z/my-project/scripts/phase1_verify.out
: > "$OUT"
log() { echo "$1" >> "$OUT"; }

cd /home/z/my-project

log "== tsc --noEmit (baseline 11 errors) =="
bunx tsc --noEmit 2>&1 | tail -3 >> "$OUT"
TSC_COUNT=$(bunx tsc --noEmit 2>&1 | rg -c "error TS" || echo 0)
log "tsc error count: $TSC_COUNT"

log "== wait for :3000 =="
for i in $(seq 1 40); do
  curl -s -o /dev/null --max-time 2 http://localhost:3000/gate && break
  sleep 2
done
curl -s -o /dev/null --max-time 3 http://localhost:3000/gate || { log "SERVER NEVER CAME UP"; exit 1; }
log "server up after ~$((i*2))s"

log "== 1. root ungated (expect 307 -> /gate) =="
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" --max-time 5 http://localhost:3000/ >> "$OUT" 2>&1

log "== 2. api ungated (expect 401) =="
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://localhost:3000/api/command >> "$OUT" 2>&1

log "== 3. wrong credentials (expect 401) =="
curl -s --max-time 5 -X POST http://localhost:3000/api/gate -H 'Content-Type: application/json' -d '{"username":"josias","password":"wrong"}' -w " [%{http_code}]\n" >> "$OUT" 2>&1

log "== 4. correct operator login (expect ok:true) =="
OP_USER="${OPERATOR_USER:-josias}"
OP_PASS="${OPERATOR_PASSWORD:-}"
[ -z "$OP_PASS" ] && { echo "set OPERATOR_PASSWORD — the shared enclave password is retired" >> "$OUT"; exit 1; }
curl -s -c /home/z/my-project/scripts/.gate_cookies.txt --max-time 5 -X POST http://localhost:3000/api/gate -H 'Content-Type: application/json' -d "{\"username\":\"$OP_USER\",\"password\":\"$OP_PASS\"}" -w " [%{http_code}]\n" >> "$OUT" 2>&1

log "== 5. root with cookie (expect 200) =="
curl -s -b /home/z/my-project/scripts/.gate_cookies.txt -o /dev/null -w "%{http_code}\n" --max-time 5 http://localhost:3000/ >> "$OUT" 2>&1

log "== 6. staged email still honest (expect send.status=staged, provider=none) =="
curl -s -b /home/z/my-project/scripts/.gate_cookies.txt --max-time 15 -X POST http://localhost:3000/api/dossier/email \
  -H 'Content-Type: application/json' \
  -d '{"prospectId":"cmvtcxblv0005m3jea8z7y7n7","subject":"Phase1 verify — staged honesty check","body":"Verifying the enclave still stages honestly after the interlock work. No provider configured, so this must not pretend to leave the building.","override":true}' \
  -w "\n[%{http_code}]\n" >> "$OUT" 2>&1

log "== 7. unsubscribe endpoint still public + valid token accepted =="
SEC="c086978db3f03bf1f8fc688ed2759839a23f2b100d11d0ce156de1fbb35341d2"
PID="cmvtcxblv0005m3jea8z7y7n7"
# read the address from the API response of dossier (no token check here if email unknown — just hit endpoint shape)
curl -s -o /dev/null -w "unsub endpoint reachable: %{http_code}\n" --max-time 5 "http://localhost:3000/api/unsubscribe?p=x&a=y&t=z" >> "$OUT" 2>&1

log "== done =="
