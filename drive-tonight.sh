#!/bin/bash
# Unattended waiter + live driver for ControlUp 2.0 (league 600619).
set -u
cd "$(dirname "$0")"
mkdir -p mocks
LOG=mocks/live-waiter.log
echo "waiter start $(TZ=America/New_York date)" | tee -a "$LOG"

while true; do
  NOW=$(TZ=America/New_York date '+%H:%M:%S')
  PAGES=$(chrome-devtools list_pages 2>/dev/null || true)
  echo "[$NOW] poll" >> "$LOG"
  echo "$PAGES" >> "$LOG"
  if echo "$PAGES" | grep -q 'draftclient/f1/600619'; then
    echo "[$NOW] ROOM FOUND — launching mock.mjs" | tee -a "$LOG"
    node mock.mjs --strategy vona-starter --run-id 2026-09-02-live --max-minutes 90
    echo "[$(TZ=America/New_York date '+%H:%M:%S')] mock.mjs exited $?" | tee -a "$LOG"
    exit 0
  fi
  chrome-devtools press_key Shift >/dev/null 2>&1 || true
  MIN=$(TZ=America/New_York date +%H%M)
  if [ "$MIN" -ge 1928 ] && [ "$MIN" -lt 2010 ]; then
    chrome-devtools navigate_page --url "https://football.fantasysports.yahoo.com/f1/600619/draft" --timeout 30000 >> "$LOG" 2>&1 || true
    # waiting-room "Enter Draft" link if present
    chrome-devtools evaluate_script '() => { const a=[...document.querySelectorAll("a,button")].find(el=>/enter draft|join draft|go to draft|draft room/i.test(el.textContent)); if(a){a.click(); return a.textContent.trim();} return null; }' >> "$LOG" 2>&1 || true
  fi
  sleep 12
done
