#!/usr/bin/env node
// Turn live board state into a pick recommendation.
//
//   node advise.mjs --avail 40168,30121,... --roster 33393 --pick 9 --next 16 \
//                   --strategy vona-scarcity
//
// This is the draft-night deliverable: given who's on the board and what I
// already own, print the top candidates with one line of reasoning each.
// Prints `data-id` first, because that is the identity key.

import { parseArgs } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES } from './lib/strategies.mjs';
import { expectedBestSurvivor } from './lib/vorp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const { values: a } = parseArgs({ options: {
  avail: { type: 'string' }, roster: { type: 'string', default: '' },
  pick: { type: 'string' }, next: { type: 'string' },
  strategy: { type: 'string', default: 'vona-starter' },
  adp: { type: 'string' },            // id:adp,id:adp — real ADP off the board
  in: { type: 'string' }, top: { type: 'string', default: '6' },
}});

const rankFile = a.in || join(__dirname, 'data',
  readdirSync(join(__dirname, 'data')).filter(f => f.startsWith('rankings-')).sort().pop());
const ranks = JSON.parse(readFileSync(rankFile, 'utf8'));
const byId = new Map(ranks.players.map(p => [p.id, p]));
// Replacement levels feed the starter-first marginal calculation in strategies.
cfg.__replacement = ranks.replacement ?? {};

// Real ADP from the live board overrides the preseason-rank proxy.
let adpOverrides = 0;
if (a.adp) {
  for (const pair of a.adp.split(',')) {
    const [id, v] = pair.split(':');
    const p = byId.get(id);
    if (p && Number.isFinite(+v)) { p.adp = +v; adpOverrides++; }
  }
}

const availIds = (a.avail || '').split(',').map(s => s.trim()).filter(Boolean);
const rosterIds = a.roster.split(',').map(s => s.trim()).filter(Boolean);

const unknown = availIds.filter(id => !byId.has(id));
const available = availIds.map(id => byId.get(id)).filter(Boolean);
const roster = rosterIds.map(id => byId.get(id)).filter(Boolean);

const pickNo = +a.pick;
const round = Math.floor((pickNo - 1) / cfg.league.teams) + 1;
const myNextPick = +a.next;

const fn = STRATEGIES[a.strategy];
if (!fn) throw new Error(`unknown strategy ${a.strategy}`);

const state = { available, roster, myRoster: roster, pickNo, round, myNextPick, recent: [] };
const res = fn(state, cfg);

// Per-position "what survives to my next turn", so the reasoning can say
// whether waiting is safe rather than just naming a player.
const survive = {};
for (const pos of new Set(available.map(p => p.pos))) {
  survive[pos] = expectedBestSurvivor(available, pos, myNextPick, cfg);
}

console.log(`\n=== Pick ${pickNo} (round ${round}) · next turn ${myNextPick} · ${a.strategy} ===`);
console.log(`pool ${available.length}/${availIds.length} known${unknown.length ? ` (${unknown.length} unknown ids)` : ''}`
  + `${adpOverrides ? ` · real ADP for ${adpOverrides}` : ''}`);
if (roster.length) console.log(`roster: ${roster.map(p => `${p.pos} ${p.name}`).join(', ')}`);

const N = +a.top;
console.log(`\n  ${'data-id'.padEnd(8)} ${'player'.padEnd(22)} ${'pos'.padEnd(4)} ${'pts'.padStart(6)} ${'VORP'.padStart(6)} ${'VONA'.padStart(6)} ${'E[G]'.padStart(5)} ${'ADP'.padStart(6)}`);
for (const id of res.candidates.slice(0, N)) {
  const p = byId.get(id);
  const vona = p.vorp - (survive[p.pos] ?? 0);
  console.log(`  ${id.padEnd(8)} ${p.name.slice(0,22).padEnd(22)} ${p.pos.padEnd(4)} `
    + `${p.custPts.toFixed(1).padStart(6)} ${p.vorp.toFixed(1).padStart(6)} ${vona.toFixed(1).padStart(6)} `
    + `${(p.expGames ?? 17).toFixed(1).padStart(5)} ${String(p.adp ?? '—').padStart(6)}`
    + `${p.status ? '  ' + p.status : ''}`);
}
console.log(`\n  PICK: ${res.dataId} ${byId.get(res.dataId)?.name} — ${res.reason}`);
console.log('\n  wait-cost by position (VORP of best expected survivor at next turn):');
for (const [pos, v] of Object.entries(survive).sort((x, y) => y[1] - x[1])) {
  const best = available.filter(p => p.pos === pos).sort((x, y) => y.vorp - x.vorp)[0];
  if (!best) continue;
  console.log(`    ${pos.padEnd(4)} now ${best.vorp.toFixed(1).padStart(6)} -> then ${v.toFixed(1).padStart(6)}  (cost of waiting ${(best.vorp - v).toFixed(1)})`);
}
console.log('');
