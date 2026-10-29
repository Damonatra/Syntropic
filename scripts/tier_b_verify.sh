#!/bin/bash
# Tier B verification — feed filters, hold buffer, alert backlog, rail quick actions.
# Runs the bridge as a child of THIS command so it stays sanctioned for the duration.

cd /home/z/my-project/mini-services/telemetry-service
bun index.ts > /home/z/my-project/bridge.log 2>&1 &
BPID=$!
echo "== bridge pid $BPID =="
sleep 6

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
has()  { if echo "$2" | grep -q "$3"; then ok "$1"; else bad "$1 — missing: $3"; fi; }

echo "== reload + enter radar =="
agent-browser open "http://localhost:81" >/dev/null 2>&1
sleep 5
agent-browser find text "◎ Radar" >/dev/null 2>&1 && agent-browser find text "◎ Radar" >/dev/null 2>&1
agent-browser eval "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('Radar')); if (b) b.click(); return b ? 'clicked' : 'not-found'; })()" 2>/dev/null | tail -1
sleep 2

SNAP=$(agent-browser snapshot 2>/dev/null)

echo "== 1. alert backlog strip =="
has "backlog label renders" "$SNAP" "ALERT BACKLOG"
has "unacked alert title" "$SNAP" "HIGH-INTENT PROSPECT ON PORTAL"
has "Lamu Fluid Power in backlog" "$SNAP" "Lamu Fluid Power"

echo "== 2. feed controls =="
has "ALL tab" "$SNAP" 'tab "All"'
has "HIGH-SIGNAL tab" "$SNAP" 'tab "High-signal"'
has "vertical chips" "$SNAP" "PVF"
has "shown counter" "$SNAP" "shown"

echo "== 3. money chips on feed cards =="
has "feed money chip" "$SNAP" "leak"

echo "== 4. HIGH-SIGNAL filter =="
agent-browser eval "(() => { const b=[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent==='High-signal'); b?.click(); return 'ok'; })()" >/dev/null 2>&1
sleep 1
S2=$(agent-browser snapshot 2>/dev/null)
has "high-signal selected" "$S2" 'selected.*High-signal\|High-signal.*selected'
CNT_HIGH=$(agent-browser eval "(() => JSON.stringify({cards: document.querySelectorAll('.cc-rise').length}))()" 2>/dev/null | tail -1)
echo "  high-signal feed cards: $CNT_HIGH"
agent-browser eval "(() => { const b=[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent==='All'); b?.click(); return 'ok'; })()" >/dev/null 2>&1
sleep 1

echo "== 5. vertical filter PVF =="
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='PVF'); b?.click(); return 'ok'; })()" >/dev/null 2>&1
sleep 1
S3=$(agent-browser snapshot 2>/dev/null)
has "PVF pressed" "$S3" 'aria-pressed'
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='All'); if(b&&b.getAttribute('aria-pressed')==='true') return 'already'; const all=[...document.querySelectorAll('button')].filter(x=>['PVF','Elec','HVAC','Fluid'].includes(x.textContent)); all.length && console.log('restoring'); return 'ok'; })()" >/dev/null 2>&1
# restore vertical=All: the vertical group's All chip
agent-browser eval "(() => { const chips=[...document.querySelectorAll('button')].filter(x=>x.textContent==='All' && x.getAttribute('aria-pressed')!==null); chips.forEach(c=>c.click()); return 'restored'; })()" >/dev/null 2>&1
sleep 1

echo "== 6. hold buffer (hover freeze) =="
HOLD=$(agent-browser eval "(() => { const list=document.querySelector('[aria-disabled]'); if(!list) return 'no-list'; list.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); return 'frozen'; })()" 2>/dev/null | tail -1)
echo "  freeze: $HOLD"
sleep 1
S4=$(agent-browser snapshot 2>/dev/null)
has "hold pill appears" "$S4" "feed held"
echo "  waiting 16s for bridge events during hold..."
sleep 16
S5=$(agent-browser snapshot 2>/dev/null)
if echo "$S5" | grep -qE "\+[0-9]+ new while held"; then
  ok "buffer counted new arrivals: $(echo "$S5" | grep -oE '\+[0-9]+ new while held' | head -1)"
else
  bad "no +N count during hold"
fi
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.includes('release')); b?.click(); return 'released'; })()" >/dev/null 2>&1
sleep 1
S6=$(agent-browser snapshot 2>/dev/null)
if echo "$S6" | grep -q "feed held"; then bad "pill did not clear on release"; else ok "pill cleared on release"; fi

echo "== 7. rail quick actions =="
S7=$(agent-browser snapshot 2>/dev/null)
has "rail money" "$S7" 'prio\|leak'
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='x · defer'); if(!b) return 'no-defer-btn'; b.click(); return 'defer-clicked'; })()" 2>/dev/null | tail -1
sleep 3
S8=$(agent-browser snapshot 2>/dev/null)
has "defer toast fired" "$S8" "DEFERRED —"
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='s · snooze'); if(!b) return 'no-snooze-btn'; b.click(); return 'snooze-clicked'; })()" 2>/dev/null | tail -1
sleep 3
S9=$(agent-browser snapshot 2>/dev/null)
has "snooze toast fired" "$S9" "SNOOZED 24H"

kill $BPID 2>/dev/null
echo "== bridge stopped =="
echo "=== RESULT: $PASS pass / $FAIL fail ==="
