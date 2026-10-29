#!/bin/bash
# Phase 2 end-to-end verification — runs while the dev server is up inside the long call.
OUT=/home/z/my-project/scripts/phase2_verify.out
JAR=/home/z/my-project/scripts/.gate_cookies.txt
: > "$OUT"
log() { echo "$1" >> "$OUT"; }
step() { echo "" >> "$OUT"; echo "== $1 ==" >> "$OUT"; }

cd /home/z/my-project
PW="7BP2iox9DhM2cF9LiXwsma"
GULF="cmvtcxblv0005m3jea8z7y7n7"

# wait for server
for i in $(seq 1 45); do
  curl -s -o /dev/null --max-time 2 http://localhost:3000/gate && break
  sleep 2
done
curl -s -o /dev/null --max-time 3 http://localhost:3000/gate || { echo "SERVER NEVER CAME UP" >> "$OUT"; exit 1; }
log "server up (waited ~$((i*2))s)"

step "1. gate chain"
curl -s -o /dev/null -w "root ungated: %{http_code} -> %{redirect_url}\n" --max-time 5 http://localhost:3000/ >> "$OUT" 2>&1
curl -s -o /dev/null -w "api ungated: %{http_code}\n" --max-time 5 http://localhost:3000/api/command >> "$OUT" 2>&1
curl -s -c "$JAR" -X POST http://localhost:3000/api/gate -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" -w "\nlogin: [%{http_code}]\n" --max-time 5 >> "$OUT" 2>&1
curl -s -b "$JAR" -o /dev/null -w "root with cookie: %{http_code}\n" --max-time 5 http://localhost:3000/ >> "$OUT" 2>&1

step "2. evidence ledger — GET (Gulf Coast seeded fixtures)"
curl -s -b "$JAR" --max-time 8 "http://localhost:3000/api/dossier/evidence?prospectId=$GULF" >> "$OUT" 2>&1

step "3. evidence ledger — POST add + PATCH veto/restore"
ADD=$(curl -s -b "$JAR" --max-time 8 -X POST http://localhost:3000/api/dossier/evidence -H 'Content-Type: application/json' \
  -d "{\"prospectId\":\"$GULF\",\"kind\":\"operator_note\",\"verbatim\":\"dispatcher said quotes pile up every Friday and someone hand-types them into QuickBooks\",\"sourceNote\":\"e2e verify — operator note\"}")
log "$ADD"
NEWID=$(echo "$ADD" | rg -o '"id":"[a-z0-9]+"' | head -1 | cut -d'"' -f4)
if [ -n "$NEWID" ]; then
  curl -s -b "$JAR" --max-time 8 -X PATCH http://localhost:3000/api/dossier/evidence -H 'Content-Type: application/json' -d "{\"id\":\"$NEWID\",\"status\":\"vetoed\"}" -w " [veto %{http_code}]\n" >> "$OUT" 2>&1
  curl -s -b "$JAR" --max-time 8 -X PATCH http://localhost:3000/api/dossier/evidence -H 'Content-Type: application/json' -d "{\"id\":\"$NEWID\",\"status\":\"active\"}" -w " [restore %{http_code}]\n" >> "$OUT" 2>&1
fi

step "4. draft route — brief → LLM → verify (may take up to 3 min)"
curl -s -b "$JAR" --max-time 180 -X POST http://localhost:3000/api/dossier/draft -H 'Content-Type: application/json' \
  -d "{\"prospectId\":\"$GULF\"}" -w "\n[draft %{http_code}]\n" >> "$OUT" 2>&1

step "5. integrity wall — fabricated send must be refused (expect 422)"
curl -s -b "$JAR" --max-time 15 -X POST http://localhost:3000/api/dossier/email -H 'Content-Type: application/json' \
  -d "{\"prospectId\":\"$GULF\",\"subject\":\"Congratulations on the Houston expansion\",\"body\":\"Hi Marcus, we helped a distributor cut quote turnaround by 63% during their Houston expansion last quarter. Open to seeing how?\",\"override\":true}" \
  -w "\n[fabricated %{http_code}]\n" >> "$OUT" 2>&1

step "6. honest staged send — grounded text must pass (expect 200 staged + briefHash)"
curl -s -b "$JAR" --max-time 15 -X POST http://localhost:3000/api/dossier/email -H 'Content-Type: application/json' \
  -d "{\"prospectId\":\"$GULF\",\"subject\":\"four days to quote\",\"body\":\"Hi Marcus, a contractor review says quotes at Gulf Coast Valve took four days just to get a quote back on valve packages — while your own site promises 5-7 business days. Most PVF houses we work with lose hours re-keying RFQs between email threads and QuickBooks. Worth 15 minutes to see where the delay concentrates?\",\"override\":true}" \
  -w "\n[grounded %{http_code}]\n" >> "$OUT" 2>&1

step "7. dossier payload carries painSignals"
curl -s -b "$JAR" --max-time 8 "http://localhost:3000/api/dossier?id=$GULF" | rg -o '"painSignals":\[.*?\]' | head -c 600 >> "$OUT" 2>&1

step "done"
rm -f "$JAR"
