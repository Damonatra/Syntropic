#!/usr/bin/env bash
# Rail UI verification — boots the stack (single-call lifecycle), then drives
# the real browser: identity per signed operator, collapse/expand by actual
# mouse clicks on the relocated header control, posture persistence.
set -u
cd /home/z/my-project
DL=download

bash scripts/verify-door.sh || exit 1

echo "== rail ui =="
CK="$(npx tsx scripts/mint-session.ts josias 2>/dev/null)"
agent-browser cookies set enclave_session "${CK#enclave_session=}" --url http://localhost:3000 >/dev/null
agent-browser open http://localhost:3000/ >/dev/null
agent-browser wait --load networkidle >/dev/null 2>&1
agent-browser wait 2500 >/dev/null 2>&1
agent-browser set viewport 1440 900 >/dev/null
agent-browser wait 600 >/dev/null 2>&1

echo -n "josias identity: "
agent-browser eval "document.querySelector('aside')?.textContent?.match(/Operator \/\/ (\w+)/)?.[1] ?? 'no-match'" | tail -1
echo -n "toggle position: "
agent-browser eval "(()=>{const b=document.querySelector('[aria-label=\"Collapse rail\"]');if(!b)return 'missing';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y)})})()" | tail -1

agent-browser screenshot $DL/rail-josias-expanded.png >/dev/null

# real mouse click on the header control (ref from snapshot, not JS)
REF=$(agent-browser snapshot -i 2>/dev/null | rg -o 'button "Collapse rail".*?ref=(e[0-9]+)' -r '$1' | head -1)
echo "collapse ref: $REF"
agent-browser click "$REF" >/dev/null
agent-browser wait 700 >/dev/null 2>&1
echo -n "post-click width class: "
agent-browser eval "document.querySelector('aside').className.includes('w-[64px]') ? 'collapsed' : 'still-expanded'" | tail -1
echo -n "posture stored: "
agent-browser storage local syntropic:rail | tail -1
agent-browser screenshot $DL/rail-josias-collapsed.png >/dev/null

# reload — posture must survive the visit boundary
agent-browser reload >/dev/null
agent-browser wait --load networkidle >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
echo -n "after reload: "
agent-browser eval "document.querySelector('aside').className.includes('w-[64px]') ? 'still-collapsed' : 'reverted'" | tail -1

# expand again via the collapsed control
REF2=$(agent-browser snapshot -i 2>/dev/null | rg -o 'button "Expand rail".*?ref=(e[0-9]+)' -r '$1' | head -1)
echo "expand ref: $REF2"
agent-browser click "$REF2" >/dev/null
agent-browser wait 700 >/dev/null 2>&1
echo -n "post-expand width class: "
agent-browser eval "document.querySelector('aside').className.includes('w-[228px]') ? 'expanded' : 'still-collapsed'" | tail -1

# damon sees his own name
CK2="$(npx tsx scripts/mint-session.ts damon 2>/dev/null)"
agent-browser cookies set enclave_session "${CK2#enclave_session=}" --url http://localhost:3000 >/dev/null
agent-browser open http://localhost:3000/ >/dev/null
agent-browser wait --load networkidle >/dev/null 2>&1
agent-browser wait 2200 >/dev/null 2>&1
echo -n "damon identity: "
agent-browser eval "document.querySelector('aside')?.textContent?.match(/Operator \/\/ (\w+)/)?.[1] ?? 'no-match'" | tail -1
agent-browser screenshot $DL/rail-damon-expanded.png >/dev/null
echo "== done =="
