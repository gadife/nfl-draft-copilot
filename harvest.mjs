#!/usr/bin/env node
// Harvest the real draft order from a live room. Observation only — no picks.
//
//   node harvest.mjs --run-id h1 --max-minutes 80
//
// Why this exists: the simulator selects the strategy, but its OPPONENT MODEL is
// invented. If that model is wrong, the strategy it picks is wrong. Live mocks
// can't provide statistical power for strategy selection (one slot, ~1 draft per
// 40 min, uncontrolled opponents) but they ARE the only source of ground truth
// for how real drafters behave.
//
// Observing is also far more robust than drafting: no clock pressure, no click
// reliability, and it survives the fast autopick-heavy rooms that defeated the
// picking harness.
//
// Output: an ordered list of {pickNo, id} — enough to fit ADP deviation and
// position-run intensity.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cd, runJs, sleep, listPages } from './lib/cdp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
const { values: a } = parseArgs({ options: {
  'run-id': { type: 'string' }, 'max-minutes': { type: 'string', default: '80' },
}});

const rankPath = join(__dirname, 'data',
  readdirSync(join(__dirname, 'data')).filter(f => f.startsWith('rankings-')).sort().pop());
const ranks = JSON.parse(readFileSync(rankPath, 'utf8'));
const byId = new Map(ranks.players.map(p => [p.id, p]));

const page = listPages().find(p => /\/draftclient\//.test(p.url));
if (!page) throw new Error('no draftclient tab open');
if (!page.selected) cd(['select_page', String(page.id)]);

// Poll fast and keep it tiny: in autopick-heavy rooms picks land every 2-5s.
const PROBE = `async () => {
  const t = document.body.innerText.replace(/\\s+/g,' ').trim();
  const head = t.slice(0, 200);
  const board = [...document.querySelectorAll('table')]
    .find(x => [...x.querySelectorAll('thead th')].some(h => /^ADP$/i.test(h.textContent.trim())));
  const ids = board ? [...board.querySelectorAll('tbody tr')]
    .map(tr => tr.querySelector('.ys-player[data-id]')?.getAttribute('data-id')).filter(Boolean) : [];
  const m = head.match(/PICK\\s+(\\d+)/i);
  return JSON.stringify({ pickNo: m ? +m[1] : null, ids,
    complete: /Draft Complete/i.test(t) });
}`;

const runId = a['run-id'] || 'h' + Date.now();
mkdirSync(join(__dirname, 'data', 'harvest'), { recursive: true });
const outPath = () => join(__dirname, 'data', 'harvest', `${runId}.json`);

// A lobby join can land in a room sized differently than our own league (seen:
// a "12-team" mock_lobby URL actually seated 14) — never assume cfg.league.teams.
// The post-draft summary prints "Round X, Pick Y (Z Overall)" lines; teams =
// (Z-Y)/(X-1) for any line with X>1.
let detectedTeams = null;
function detectTeams() {
  try {
    const { t } = runJs(`async () => JSON.stringify({t: document.body.innerText.replace(/\\s+/g,' ').trim()})`, { retries: 0 });
    for (const m of t.matchAll(/Round\s+(\d+),\s*Pick\s+(\d+)\s*\((\d+)(?:st|nd|rd|th)\s*Overall\)/gi)) {
      const [, r, p, z] = m.slice(1).map(Number);
      if (r > 1 && (z - p) % (r - 1) === 0) return (z - p) / (r - 1);
    }
  } catch { /* best effort */ }
  // Fallback: the post-draft page doesn't always land on the "Your Team" tab
  // that prints the round summary (seen: it landed on "Players Board" instead,
  // where that text never appears). Standard mocks are always 15 rounds, so
  // teams = maxPickNo / 15 is a robust independent estimate.
  if (order.length) {
    const maxPick = Math.max(...order.map(o => o.pickNo).filter(Number.isFinite));
    const est = Math.round(maxPick / 15);
    if (est > 0 && Math.abs(maxPick / 15 - est) < 0.34) return est;
  }
  return null;
}

function flush() {
  writeFileSync(outPath(), JSON.stringify({
    harvestedAt: new Date().toISOString(), room: page.url,
    teams: detectedTeams || cfg.league.teams, count: order.length, order,
  }, null, 1));
}
const deadline = Date.now() + Number(a['max-minutes']) * 60_000;
const order = [];          // [{pickNo, id}]
const seenGone = new Set();
let prev = null;
let keep = 0;

while (Date.now() < deadline) {
  if (Date.now() - keep > 20_000) { cd(['press_key', 'Shift'], { timeout: 15_000 }); keep = Date.now(); }
  let st;
  try { st = runJs(PROBE, { retries: 0 }); } catch { sleep(1200); continue; }

  if (prev) {
    // Anything that left the board was drafted. The board is virtualised, so
    // only trust disappearances from the region we can see continuously: an id
    // that was present and is now absent while the board still has rows.
    if (st.ids.length > 20) {
      const now = new Set(st.ids);
      for (const id of prev) {
        if (!now.has(id) && !seenGone.has(id)) {
          seenGone.add(id);
          order.push({ pickNo: st.pickNo, id, name: byId.get(id)?.name ?? null,
            pos: byId.get(id)?.pos ?? null, adp: byId.get(id)?.adp ?? null });
        }
      }
    }
  }
  prev = st.ids;
  // Flush as we go. Writing only at exit means a kill (or starting a new
  // session) throws away the whole harvest.
  if (order.length && order.length % 10 === 0) flush();
  if (st.complete) { detectedTeams = detectTeams(); break; }
  sleep(1100);
}

flush();
console.log(`harvested ${order.length} picks -> ${outPath()}`);
