#!/usr/bin/env bash
# One-call enclave verification battery — the sandbox reaps tool-call
# processes at call end, so the stack is booted, exercised, and left to
# be reaped inside a single call. Idempotent: safe to re-run any time.
#
#   1. boot `bun run dev` detached, poll /gate until it answers
#   2. gate battery: middleware redirect, chooser, session cookie, identity
#   3. heartbeat door: door-proof (401 unsigned / 200 signed / dedup) + cleanup
set -u
cd /home/z/my-project

boot() {
  if curl -s -o /dev/null --max-time 2 http://localhost:3000/gate; then return 0; fi
  setsid nohup bun run dev >/dev/null 2>&1 < /dev/null &
  for i in $(seq 1 120); do
    curl -s -o /dev/null --max-time 2 http://localhost:3000/gate && { echo "[boot] app answering after ${i}s"; return 0; }
    sleep 1
  done
  echo "[boot] FAILED — /gate never answered"; return 1
}

echo "== boot =="
boot || exit 1

echo "== gate battery =="
code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/)
redir=$(curl -s -o /dev/null -w "%{redirect_url}" http://localhost:3000/)
echo "root no-cookie: $code -> $redir"
curl -s http://localhost:3000/api/gate | rg -o '"gate":(true|false)' | head -1

CK="$(npx tsx scripts/mint-session.ts josias 2>/dev/null)"
echo "minted: ${CK%%=*}=<len ${#CK}>"
curl -s -H "Cookie: $CK" -o /dev/null -w "root with cookie: %{http_code}\n" http://localhost:3000/
curl -s -H "Cookie: $CK" http://localhost:3000/api/gate | rg -o '"operator":\{[^}]*\}' | head -1

echo "== heartbeat door =="
npx tsx scripts/door-proof.ts
npx tsx scripts/cleanup-door-proof.ts | tail -1
echo "== done =="
