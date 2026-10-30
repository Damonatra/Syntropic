#!/usr/bin/env bash
# Live smoke for the Enclave connections panel — one bundled command because
# background processes do not survive across tool calls.
set -u
cd /home/z/my-project

echo "=== prisma db push (idempotent) ==="
npx prisma db push --skip-generate 2>&1 | tail -2

if ! curl -sf -o /dev/null http://localhost:3000/; then
  echo "=== booting dev server ==="
  nohup npm run dev > dev.log 2>&1 &
  for i in $(seq 1 45); do
    curl -sf -o /dev/null http://localhost:3000/ && break
    sleep 1
  done
fi
curl -sf -o /dev/null http://localhost:3000/ || { echo "SERVER FAILED TO BOOT"; tail -20 dev.log; exit 1; }
echo "server up"

echo "=== 1. GET /api/ops/integrations — fleet + rows ==="
curl -s http://localhost:3000/api/ops/integrations | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('fleet:', json.dumps(d.get('fleet'), indent=None))
for r in d['integrations']:
    rw = r.get('runway')
    print(f\"  {r['provider']:<18} {r['kind']:<8} {r['status']:<8} circuit={r['circuitState']:<6} key={r['keyPresent']} runway={rw['level'] if rw else '-'}\")
"

echo "=== 2. arm apollo + declare 900-credit plan allowance ==="
curl -s -X PATCH http://localhost:3000/api/ops/integrations -H 'Content-Type: application/json' -d '{"provider":"apollo","status":"armed"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('arm:', d.get('ok'), '-', d.get('note',''))"
curl -s -X PATCH http://localhost:3000/api/ops/integrations -H 'Content-Type: application/json' -d '{"provider":"apollo","quotaRemaining":900}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('quota:', d.get('ok'), '-', d.get('note',''))"

echo "=== 3. probe apollo (no key yet — must fail honestly) ==="
curl -s -X POST http://localhost:3000/api/ops/integrations/probe -H 'Content-Type: application/json' -d '{"provider":"apollo"}' | python3 -m json.tool | head -14

echo "=== 4. resolve attempt with apollo armed-but-unkeyed — must refuse with named reason ==="
curl -s -X POST http://localhost:3000/api/contacts/resolve -H 'Content-Type: application/json' -d '{"name":"Vera Lyan","domain":"acme.test"}' | python3 -m json.tool | head -10

echo "=== 5. final snapshot — refusal feed should count the resolver refusal ==="
curl -s http://localhost:3000/api/ops/integrations | python3 -c "
import json,sys
d = json.load(sys.stdin)
apollo = next(r for r in d['integrations'] if r['provider']=='apollo')
print('apollo:', json.dumps({k: apollo.get(k) for k in ('status','keyPresent','quotaRemaining','refusals24h','refusalsTotal')}, indent=None))
print('runway:', json.dumps(apollo.get('runway'), indent=None))
print('fleet:', d['fleet']['verdict'])
"
echo "=== smoke complete ==="
