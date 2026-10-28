#!/bin/bash
# Warms the Next dev server: starts it if :3000 isn't answering.
# (The tool sandbox reaps spawned processes between calls, so every E2E
# call opens with this prologue — the .next compile cache keeps restarts fast.)
if curl -s -o /dev/null --max-time 1 http://localhost:3000/api/ledger; then
  exit 0
fi
cd /home/z/my-project || exit 1
setsid nohup ./node_modules/.bin/next dev -p 3000 > dev.log 2>&1 < /dev/null &
disown
for i in $(seq 1 45); do
  if curl -s -o /dev/null --max-time 2 http://localhost:3000/api/ledger; then
    exit 0
  fi
  sleep 1
done
echo "dev server failed to come up" >&2
exit 1
