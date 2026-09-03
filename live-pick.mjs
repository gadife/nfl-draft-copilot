#!/usr/bin/env node
// Draft-night picker: JSON state in, JSON pick out. No browser.
//
//   node live-pick.mjs --state data/live-state.json
//   node live-pick.mjs --avail 40059,40055 --roster '' --pick 12 --next 13
//
import { parseArgs } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES } from './lib/strategies.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const { values: a } = parseArgs({ options: {
  state: { type: 'string' },
  avail: { type: 'string' },
  roster: { type: 'string', default: '' },
  pick: { type: 'string' },
  next: { type: 'string' },
  strategy: { type: 'string', default: 'vona-starter' },
  in: { type: 'string' },
  top: { type: 'string', default: '8' },
  slot: { type: 'string' },
  teams: { type: 'string' },
}});

const rankFile = a.in || join(__dirname, 'data',
  readdirSync(join(__dirname, 'data')).filter(f => f.startsWith('rankings-')).sort().pop());
const ranks = JSON.parse(readFileSync(rankFile, 'utf8'));
cfg.__replacement = ranks.replacement ?? {};
const byId = new Map(ranks.players.map(p => [p.id, p]));

const st = a.state ? JSON.parse(readFileSync(a.state, 'utf8')) : {};
for (const [id, v] of Object.entries(st.adp || {})) {
  const p = byId.get(id);
  if (p && Number.isFinite(+v)) p.adp = +v;
}

const availIds = (st.avail || (a.avail || '').split(',')).map(s => String(s).trim()).filter(Boolean);
const rosterIds = (st.rosterIds || (a.roster || '').split(',')).map(s => String(s).trim()).filter(Boolean);
const available = availIds.map(id => byId.get(id)).filter(Boolean);
const roster = rosterIds.map(id => byId.get(id)).filter(Boolean);

const teams = +(a.teams || st.teams || cfg.league.teams);
const pickNo = +(a.pick || st.pickNo || 0);
const slot = +(a.slot || st.slot || 0);
const round = Math.floor(Math.max(0, pickNo - 1) / teams) + 1;

function slotOf(n) {
  const r = Math.floor((n - 1) / teams);
  const i = (n - 1) % teams;
  return (r % 2 === 0 ? i : teams - 1 - i) + 1;
}
function nextOwn() {
  if (a.next) return +a.next;
  if (st.myNextPick) return +st.myNextPick;
  if (slot) {
    for (let n = pickNo + 1; n <= teams * 15; n++) if (slotOf(n) === slot) return n;
    return teams * 15 + 1;
  }
  if (st.picksUntilMine != null) return pickNo + st.picksUntilMine;
  return pickNo + teams;
}

const fn = STRATEGIES[a.strategy];
if (!fn) throw new Error(`unknown strategy ${a.strategy}`);
const myNextPick = nextOwn();
const state = { available, roster, myRoster: roster, pickNo, round, myNextPick, recent: [] };
const res = fn(state, cfg);

let ids = res.candidates;
if (!ids.length) {
  const cap = cfg.constraints.maxByPos;
  const have = {};
  for (const p of roster) have[p.pos] = (have[p.pos] || 0) + 1;
  ids = [...available]
    .filter(p => cap[p.pos] == null || (have[p.pos] || 0) < cap[p.pos])
    .sort((x, y) => (y.vorp ?? -1e9) - (x.vorp ?? -1e9))
    .slice(0, 8).map(p => p.id);
  if (!ids.length) {
    ids = [...available].sort((x, y) => (y.vorp ?? -1e9) - (x.vorp ?? -1e9))
      .slice(0, 8).map(p => p.id);
  }
}

const topN = +a.top;
const candidates = ids.slice(0, topN).map(id => {
  const p = byId.get(id);
  return p ? { id: p.id, name: p.name, pos: p.pos, vorp: +p.vorp.toFixed(1), adp: p.adp ?? null, status: p.status ?? null } : { id };
});
const out = {
  pick: ids[0] || null,
  name: byId.get(ids[0])?.name ?? null,
  reason: res.reason,
  pickNo, round, myNextPick, slot: slot || null,
  roster: roster.map(p => `${p.pos} ${p.name}`),
  known: available.length,
  unknown: availIds.length - available.length,
  candidates,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
