#!/usr/bin/env node
// Drive a live Yahoo mock draft.
//
//   node mock.mjs --strategy vona-starter --run-id 2026-08-21-02
//   node mock.mjs --strategy vona-starter --observe      (no picks, just log)
//
// Implements the three fixes from live mock #1:
//   1. KEEPALIVE — periodic trusted keypress. evaluate_script produces
//      UNTRUSTED events that never reset Yahoo's idle timer, so the room put us
//      in autopick before our first pick, the Draft column never rendered, and
//      the clock died with an empty queue.
//   2. AUTOPICK ALARM — treat the banner as a hard fault and clear it with a
//      real CDP click before doing anything else.
//   3. QUEUE REBUILD — clear and re-add in order. Appending puts entries at the
//      bottom, so a stale pick fires ahead of the intended one.
//
// Planner/actor split: all valuation happens OFF the clock. On the clock we do
// exactly one round-trip with a precomputed ordered candidate list.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cd, runJs, sleep, listPages } from './lib/cdp.mjs';
import { STRATEGIES } from './lib/strategies.mjs';
import { evaluateRoster } from './lib/evaluate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const { values: a } = parseArgs({ options: {
  strategy: { type: 'string', default: 'vona-starter' },
  'run-id': { type: 'string' },
  observe: { type: 'boolean', default: false },
  'queue-depth': { type: 'string', default: '6' },
  in: { type: 'string' },
  'max-minutes': { type: 'string', default: '90' },
}});

const rankPath = a.in || join(__dirname, 'data',
  readdirSync(join(__dirname, 'data')).filter(f => f.startsWith('rankings-')).sort().pop());
const ranks = JSON.parse(readFileSync(rankPath, 'utf8'));
cfg.__replacement = ranks.replacement ?? {};
const byId = new Map(ranks.players.map(p => [p.id, p]));
const strategyFn = STRATEGIES[a.strategy];
if (!strategyFn) throw new Error(`unknown strategy ${a.strategy}`);

const runId = a['run-id'] || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(__dirname, 'mocks', `${runId}-${a.strategy}`);
mkdirSync(outDir, { recursive: true });
const log = [];
const note = (o) => { log.push({ t: Date.now(), ...o }); console.error(JSON.stringify(o)); };

const STATE_JS = readFileSync(join(__dirname, 'js', 'state.js'), 'utf8').replace(/^\/\/.*$/gm, '').trim();
const ACT_JS = readFileSync(join(__dirname, 'js', 'act.js'), 'utf8').replace(/^\/\/.*$/gm, '').trim();

function bindAct(mode, ids) {
  const out = ACT_JS
    .replace("const MODE = '__MODE__';", `const MODE = ${JSON.stringify(mode)};`)
    .replace('const IDS = __IDS__;', `const IDS = ${JSON.stringify(ids)};`);
  if (out.includes('__MODE__') || out.includes('__IDS__')) throw new Error('bindAct failed');
  return out;
}

// --- select the draft client tab -------------------------------------------
const page = listPages().find(p => /\/draftclient\//.test(p.url));
if (!page) throw new Error('no draftclient tab open — join a mock first');
if (!page.selected) cd(['select_page', String(page.id)]);
note({ ev: 'attached', url: page.url, strategy: a.strategy, rankSource: rankPath.split('/').pop() });

// Fix 1: trusted input. Shift is inert on this page but resets the idle timer.
let lastKeepalive = 0;
const KEEPALIVE_MS = 20_000;
function keepalive(force = false) {
  const now = Date.now();
  if (!force && now - lastKeepalive < KEEPALIVE_MS) return;
  lastKeepalive = now;
  cd(['press_key', 'Shift'], { timeout: 20_000 });
}

// Fix 2: autopick is a hard fault. Clearing it needs a REAL CDP click; a JS
// .click() on the dialog button does nothing.
function clearAutopick() {
  // Escape first: trusted input, needs no uid, and no stale-snapshot risk.
  cd(['press_key', 'Escape'], { timeout: 20_000 });
  sleep(700);
  if (!stillAutopick()) { note({ ev: 'autopick-cleared', via: 'escape' }); keepalive(true); return true; }

  // Fall back to clicking the dialog's dismiss button. The snapshot MUST be
  // deleted first: uids change every snapshot, and reusing a stale file clicks
  // a uid that no longer exists, which fails silently and loops forever.
  const snapPath = join(__dirname, 'data', `autopick-snap-${runId}.txt`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { if (existsSync(snapPath)) unlinkSync(snapPath); } catch { /* ignore */ }
    cd(['take_snapshot', '--filePath', snapPath], { timeout: 60_000 });
    if (!existsSync(snapPath)) continue;
    const lines = readFileSync(snapPath, 'utf8').split('\n');
    const di = lines.findIndex(l => /dialog/.test(l));
    const scope = di >= 0 ? lines.slice(di) : lines;
    const uid = scope.map(l => l.match(/uid=(\S+)\s+button/)).find(Boolean)?.[1];
    if (!uid) continue;
    cd(['click', uid], { timeout: 30_000 });
    sleep(800);
    if (!stillAutopick()) {
      note({ ev: 'autopick-cleared', via: 'click', uid, attempt });
      keepalive(true);
      return true;
    }
  }
  note({ ev: 'autopick-CLEAR-FAILED' });
  return false;
}

// Cheap re-check so we never report success without verifying.
function stillAutopick() {
  try {
    return runJs(`async () => JSON.stringify({a: /put into autopick/i.test(document.body.innerText)})`,
      { retries: 0 }).a === true;
  } catch { return true; }
}

// Roster ids by matching the panel text against our rankings. The roster panel
// shows abbreviated names ("A. St. Brown"), so match on surname + position.
function resolveRoster(text) {
  const found = [];
  for (const p of ranks.players) {
    const surname = p.name.split(' ').slice(-1)[0].replace(/[^A-Za-z']/g, '');
    if (surname.length < 3) continue;
    const re = new RegExp(`\\b${surname}\\b[^A-Za-z]{0,4}(?:${p.pos})?`, 'i');
    if (re.test(text) && new RegExp(`\\b${p.pos}\\b`).test(text)) found.push(p);
  }
  // Deduplicate by surname, keeping the highest-projected match.
  const best = new Map();
  for (const p of found) {
    const k = p.name.split(' ').slice(-1)[0].toLowerCase() + '|' + p.pos;
    if (!best.has(k) || best.get(k).custPts < p.custPts) best.set(k, p);
  }
  return [...best.values()];
}

// Snake math from our actual slot, which the draftclient URL carries
// (/draftclient/f1/<league>/<slot>). When ON the clock the header reads
// "YOUR TURN" rather than "up in N Picks", so picksUntilMine is null — and
// assuming +teams is wrong precisely at a turn, where picks are back-to-back.
// VONA's whole judgement depends on this number.
const MY_SLOT = (() => {
  const m = page.url.match(/\/draftclient\/f1\/\d+\/(\d+)/);
  return m ? +m[1] : null;              // 1-based
})();

function slotOfPick(pickNo, teams) {
  const r = Math.floor((pickNo - 1) / teams);
  const i = (pickNo - 1) % teams;
  return (r % 2 === 0 ? i : teams - 1 - i) + 1;   // 1-based
}

function nextOwnPick(pickNo, teams, upIn) {
  if (MY_SLOT) {
    for (let n = pickNo + 1; n <= teams * 15; n++) {
      if (slotOfPick(n, teams) === MY_SLOT) return n;
    }
    return teams * 15 + 1;
  }
  return upIn != null ? pickNo + upIn : pickNo + teams;
}

// --- main loop --------------------------------------------------------------
const deadline = Date.now() + Number(a['max-minutes']) * 60_000;
let lastQueueKey = '';
let lastPickNo = null;
let picks = 0;

while (Date.now() < deadline) {
  keepalive();
  let st;
  try { st = runJs(STATE_JS, { retries: 1 }); }
  catch (e) { note({ ev: 'state-error', err: String(e).slice(0, 160) }); sleep(3000); continue; }

  if (st.complete) { note({ ev: 'draft-complete', roster: st.rosterCount }); break; }
  if (st.autopick) { note({ ev: 'AUTOPICK-ALARM', pickNo: st.pickNo }); clearAutopick(); sleep(1200); continue; }

  // Real ADP straight off the board beats any offline proxy.
  for (const [id, v] of Object.entries(st.adp || {})) {
    const p = byId.get(id); if (p) p.adp = v;
  }

  // Exact ids from the DOM; name matching is a fallback only.
  const roster = st.rosterIds?.length
    ? st.rosterIds.map(x => byId.get(x)).filter(Boolean)
    : resolveRoster(st.rosterText);

  // Cross-check against Yahoo's own "YOUR TEAM (n/15)" counter. A mismatch means
  // we are miscounting the roster, which silently corrupts every legality test
  // downstream — this is exactly how the queue panel got counted as rostered.
  let rosterTrusted = true;
  if (st.rosterCount != null && st.rosterIds && st.rosterIds.length !== st.rosterCount) {
    rosterTrusted = false;
    note({ ev: 'ROSTER-MISMATCH', got: st.rosterIds.length, expected: st.rosterCount, pickNo: st.pickNo });
  }
  const available = st.avail.map(id => byId.get(id)).filter(Boolean);
  const pickNo = st.pickNo ?? 0;
  const round = Math.floor((pickNo - 1) / cfg.league.teams) + 1;
  // A miscounted roster is worse than no roster: over-counting makes picksLeft
  // negative and the legality layer rejects every pick (mock #6 read 100).
  const safeRoster = rosterTrusted ? roster : roster.slice(0, Math.max(0, st.rosterCount ?? 0));
  const state = {
    available, roster: safeRoster, myRoster: safeRoster, pickNo, round,
    myNextPick: nextOwnPick(pickNo, cfg.league.teams, st.picksUntilMine),
    recent: [],
  };

  let res;
  try { res = strategyFn(state, cfg); }
  catch (e) { note({ ev: 'strategy-error', err: String(e).slice(0, 200) }); sleep(2000); continue; }

  if (st.onClock && !a.observe) {
    // If the constraint layer refuses everything (it did on 4 of 15 picks in
    // mock #2), fall back to BEST REMAINING VALUE, not raw board order. Board
    // order is Yahoo's XRank, which is how we ended up with a pile of
    // negative-VORP wide receivers.
    let ids = res.candidates;
    if (!ids.length) {
      const cap = cfg.constraints.maxByPos;
      const have = {};
      for (const p of safeRoster) have[p.pos] = (have[p.pos] || 0) + 1;
      ids = [...available]
        .filter(p => (cap[p.pos] == null) || (have[p.pos] || 0) < cap[p.pos])
        .sort((x, y) => (y.vorp ?? -1e9) - (x.vorp ?? -1e9))
        .slice(0, 8).map(p => p.id);
      if (!ids.length) {
        ids = [...available].sort((x, y) => (y.vorp ?? -1e9) - (x.vorp ?? -1e9))
          .slice(0, 8).map(p => p.id);
        note({ ev: 'cap-override-fallback', pickNo, top: byId.get(ids[0])?.name });
      }
      note({ ev: 'constraint-fallback', pickNo, top: byId.get(ids[0])?.name });
    }
    const t0 = Date.now();
    const r = runJs(bindAct('draft', ids), { retries: 1 });
    note({ ev: 'pick', pickNo, want: res.dataId, got: r.picked,
      name: byId.get(r.picked)?.name, reason: res.reason,
      // skipped tells us WHY the top choice failed: no-row (board moved on) vs
      // no-btn/btn-disabled (our availability model is wrong).
      skipped: (r.skipped || []).slice(0, 4),
      decisionToClickMs: Date.now() - t0, secondsLeft: st.secondsLeft });
    if (r.picked) { picks++; lastPickNo = pickNo; lastQueueKey = ''; }
    sleep(2500);
    continue;
  }

  // Off the clock: keep the queue mirroring our ordered candidates. This is the
  // safety net — if the clock ever dies, Yahoo autodrafts queue[0].
  const want = res.candidates.slice(0, Number(a['queue-depth']));
  const key = want.join(',');
  const queueWrong = st.queued.slice(0, want.length).join(',') !== key;
  if (want.length && queueWrong && key !== lastQueueKey && st.draftBtns === 0) {
    const r = runJs(bindAct('queue', want), { retries: 1 });
    lastQueueKey = key;
    note({ ev: 'queue-rebuilt', pickNo, top: byId.get(want[0])?.name,
      cleared: r.cleared?.length, added: r.added?.length });
  }
  sleep(2500);
}

// --- finish ----------------------------------------------------------------
let final = null;
try {
  const st = runJs(STATE_JS, { retries: 1 });
  // Exact ids from the DOM; name matching is a fallback only.
  const roster = st.rosterIds?.length
    ? st.rosterIds.map(x => byId.get(x)).filter(Boolean)
    : resolveRoster(st.rosterText);

  // Cross-check against Yahoo's own "YOUR TEAM (n/15)" counter. A mismatch means
  // we are miscounting the roster, which silently corrupts every legality test
  // downstream — this is exactly how the queue panel got counted as rostered.
  let rosterTrusted = true;
  if (st.rosterCount != null && st.rosterIds && st.rosterIds.length !== st.rosterCount) {
    rosterTrusted = false;
    note({ ev: 'ROSTER-MISMATCH', got: st.rosterIds.length, expected: st.rosterCount, pickNo: st.pickNo });
  }
  if (roster.length) {
    final = evaluateRoster(roster, cfg);
    note({ ev: 'evaluated', startPts: +final.startPts.toFixed(1),
      riskAdj: +final.startPtsRiskAdj.toFixed(1), sanity: final.sanity, pos: final.posCount });
  }
  writeFileSync(join(outDir, 'roster.json'), JSON.stringify({ roster: roster.map(p => p.id), metrics: final }, null, 1));
} catch (e) { note({ ev: 'final-error', err: String(e).slice(0, 160) }); }

writeFileSync(join(outDir, 'log.ndjson'), log.map(l => JSON.stringify(l)).join('\n'));
const lat = log.filter(l => l.ev === 'pick' && l.decisionToClickMs).map(l => l.decisionToClickMs).sort((x, y) => x - y);
writeFileSync(join(outDir, 'report.md'), [
  `# Live mock ${runId} — \`${a.strategy}\``, '',
  `Rankings: \`${rankPath.split('/').pop()}\` · ADP: ${ranks.adpSource}`, '',
  `- picks made by harness: **${picks}**`,
  `- autopick alarms: **${log.filter(l => l.ev === 'AUTOPICK-ALARM').length}**`,
  `- queue rebuilds: **${log.filter(l => l.ev === 'queue-rebuilt').length}**`,
  `- decision->click p50/p95: **${lat.length ? lat[Math.floor(lat.length * 0.5)] : '—'} / ${lat.length ? lat[Math.floor(lat.length * 0.95)] : '—'} ms**`,
  final ? `- startPts **${final.startPts.toFixed(1)}** · riskAdj ${final.startPtsRiskAdj.toFixed(1)} · sanity ${JSON.stringify(final.sanity)}` : '- roster not evaluated',
  '', '## Picks', '',
  ...log.filter(l => l.ev === 'pick').map(l => `- pick ${l.pickNo}: ${l.name ?? l.got} (wanted ${byId.get(l.want)?.name ?? l.want}) — ${l.reason} [${l.decisionToClickMs}ms]`),
].join('\n'));

console.log(`\nwrote ${outDir}/report.md  (picks=${picks}, startPts=${final ? final.startPts.toFixed(1) : 'n/a'})`);
