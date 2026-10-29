#!/bin/bash
# Reconnection experiment — fresh connect vs reconnect to a NEW bridge instance.
B1=$(cd /home/z/my-project/mini-services/telemetry-service && bun index.ts > /home/z/my-project/bridge-exp1.log 2>&1 & echo $!)
echo "== bridge#1 pid $B1 — reload page fresh =="
sleep 3
agent-browser open "http://localhost:81" >/dev/null 2>&1
sleep 6
echo "t+9s handshakes: $(grep -c 'client connected' /home/z/my-project/bridge-exp1.log)"
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.includes('Radar')); b?.click(); return 'radar'; })()" >/dev/null 2>&1
sleep 2
agent-browser snapshot 2>/dev/null | grep -oE "LINK DOWN — RECONNECTING · LAST SIGNAL [0-9]+[SM] AGO|SIGNAL STALE — LAST SIGNAL [0-9]+[SM] AGO|LIVE TELEMETRY — MODULE 8" | head -1

echo "== kill bridge#1, watch disconnect detection =="
kill $B1 2>/dev/null
sleep 8
agent-browser snapshot 2>/dev/null | grep -oE "LINK DOWN — RECONNECTING · LAST SIGNAL [0-9]+[SM] AGO|SIGNAL STALE — LAST SIGNAL [0-9]+[SM] AGO|LIVE TELEMETRY — MODULE 8" | head -1

echo "== start bridge#2 (SAME page instance, reconnect path) =="
B2=$(cd /home/z/my-project/mini-services/telemetry-service && bun index.ts > /home/z/my-project/bridge-exp2.log 2>&1 & echo $!)
for t in 5 10 20 30 45; do
  sleep $t
  H=$(agent-browser snapshot 2>/dev/null | grep -oE "LINK DOWN — RECONNECTING · LAST SIGNAL [0-9]+[SM] AGO|SIGNAL STALE — LAST SIGNAL [0-9]+[SM] AGO|LIVE TELEMETRY — MODULE 8" | head -1)
  C=$(grep -c 'client connected' /home/z/my-project/bridge-exp2.log)
  echo "cumulative +${t}s: handshakes=$C header=$H"
  [ "$C" != "0" ] && break
done
kill $B2 2>/dev/null
echo "== done =="
