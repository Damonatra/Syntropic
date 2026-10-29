#!/bin/bash
# Tier A verification — Radar staleness watchdog state machine.
# Runs the bridge as a child of THIS command (sanctioned while alive),
# polls the feed header + feed opacity, records every distinct state seen.

cd /home/z/my-project/mini-services/telemetry-service
bun index.ts > /home/z/my-project/bridge.log 2>&1 &
BRIDGE_PID=$!
echo "bridge pid=$BRIDGE_PID started $(date +%H:%M:%S)"

seen=""
capture() {
  h=$(agent-browser snapshot 2>/dev/null | grep -oE "LINK DOWN — RECONNECTING · LAST SIGNAL [0-9]+[SM] AGO|SIGNAL STALE — LAST SIGNAL [0-9]+[SM] AGO|LIVE TELEMETRY — MODULE 8" | head -1)
  if [ -n "$h" ]; then
    key=$(echo "$h" | cut -d' ' -f1-2)
    case "$seen" in
      *"$key"*) : ;;
      *) seen="$seen|$key"; echo "  [$(date +%H:%M:%S)] STATE: $h" ;;
    esac
  fi
}

# Phase 1: reconnect + stale window (bridge up, feed items ~15min old)
for i in $(seq 1 14); do capture; sleep 2; done

echo "--- bridge log so far ---"
tail -4 /home/z/my-project/bridge.log

echo "--- opacity + blink check (current state) ---"
agent-browser eval "(() => { const dim = document.querySelector('[aria-disabled=\"true\"]'); return JSON.stringify({ opacity: dim ? getComputedStyle(dim).opacity : '1.0 (live)', blink: document.querySelectorAll('.cc-blink').length }); })()" 2>/dev/null | tail -1

echo "--- feed card count ---"
agent-browser eval "(() => JSON.stringify({ feedCards: document.querySelectorAll('.cc-rise').length }))()" 2>/dev/null | tail -1

# Phase 2: kill bridge -> LINK DOWN re-confirm
kill $BRIDGE_PID 2>/dev/null
echo "bridge killed $(date +%H:%M:%S)"
sleep 4
capture
agent-browser eval "(() => { const dim = document.querySelector('[aria-disabled=\"true\"]'); return JSON.stringify({ opacity: dim ? getComputedStyle(dim).opacity : 'not-dimmed', blink: document.querySelectorAll('.cc-blink').length }); })()" 2>/dev/null | tail -1

echo "=== STATES OBSERVED: $seen ==="
