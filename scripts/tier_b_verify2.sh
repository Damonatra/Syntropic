#!/bin/bash
# Tier B round 2 — buffer counting during hold, release, alert ack, filter semantics.
# Page is already in frozen (held) state from the prior dispatch.

cd /home/z/my-project/mini-services/telemetry-service
bun index.ts > /home/z/my-project/bridge.log 2>&1 &
BPID=$!
echo "== bridge pid $BPID =="
sleep 1

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "== pill state before bridge events =="
P0=$(agent-browser eval "(() => { const p=[...document.querySelectorAll('button')].find(b=>/held|release/.test(b.textContent)); return p ? p.textContent.trim() : 'NO PILL'; })()" 2>/dev/null | tail -1)
echo "  pill: $P0"
echo "$P0" | grep -q "feed held" && ok "pill shows held (0 new yet)" || bad "unexpected pill: $P0"

echo "== waiting 18s for bridge telemetry while held..."
sleep 18
P1=$(agent-browser eval "(() => { const p=[...document.querySelectorAll('button')].find(b=>/held|release/.test(b.textContent)); return p ? p.textContent.trim() : 'NO PILL'; })()" 2>/dev/null | tail -1)
echo "  pill: $P1"
echo "$P1" | grep -qE "\+[0-9]+ new while held" && ok "buffer counted arrivals ($P1)" || bad "no +N during hold"

FEED_BEFORE=$(agent-browser eval "(() => document.querySelectorAll('.cc-rise').length)" 2>/dev/null | tail -1)

echo "== release the hold =="
agent-browser eval "(() => { const p=[...document.querySelectorAll('button')].find(b=>/held|release/.test(b.textContent)); p?.click(); return 'released'; })()" >/dev/null 2>&1
sleep 1
P2=$(agent-browser eval "(() => { const p=[...document.querySelectorAll('button')].find(b=>/held|release/.test(b.textContent)); return p ? 'STILL THERE' : 'cleared'; })()" 2>/dev/null | tail -1)
[ "$P2" = "cleared" ] && ok "pill cleared on release" || bad "pill stuck: $P2"
FEED_AFTER=$(agent-browser eval "(() => document.querySelectorAll('.cc-rise').length)" 2>/dev/null | tail -1)
echo "  feed cards before=$FEED_BEFORE after=$FEED_AFTER"
[ "$FEED_AFTER" -ge "$FEED_BEFORE" ] && ok "feed absorbed held arrivals" || bad "feed count dropped"

echo "== alert backlog ack =="
ACK_BEFORE=$(agent-browser eval "(() => [...document.querySelectorAll('p')].filter(p=>/unacknowledged/.test(p.textContent)).length)" 2>/dev/null | tail -1)
echo "  backlog labels before: $ACK_BEFORE"
if [ "$ACK_BEFORE" != "0" ]; then
  agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='Ack'); b?.click(); return 'acked'; })()" >/dev/null 2>&1
  sleep 1
  ACK_AFTER=$(agent-browser eval "(() => [...document.querySelectorAll('p')].filter(p=>/unacknowledged/.test(p.textContent)).length)" 2>/dev/null | tail -1)
  [ "$ACK_AFTER" = "0" ] && ok "backlog strip cleared after Ack" || bad "strip still shows: $ACK_AFTER rows"
else
  bad "no backlog strip present to ack"
fi

echo "== HIGH-SIGNAL semantics (card count all vs high) =="
agent-browser eval "(() => { const b=[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent==='High-signal'); b?.click(); return 'ok'; })()" >/dev/null 2>&1
sleep 1
C_HIGH=$(agent-browser eval "(() => document.querySelectorAll('.cc-rise').length)" 2>/dev/null | tail -1)
agent-browser eval "(() => { const b=[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent==='All'); b?.click(); return 'ok'; })()" >/dev/null 2>&1
sleep 1
C_ALL=$(agent-browser eval "(() => document.querySelectorAll('.cc-rise').length)" 2>/dev/null | tail -1)
echo "  cards high=$C_HIGH all=$C_ALL"
[ "$C_HIGH" -le "$C_ALL" ] && ok "high-signal narrows the feed" || bad "filter widened??"
[ "$C_HIGH" -gt 0 ] && ok "high-signal view non-empty" || bad "high-signal empty"

kill $BPID 2>/dev/null
echo "== bridge stopped =="
echo "=== RESULT: $PASS pass / $FAIL fail ==="
