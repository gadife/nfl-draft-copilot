#!/usr/bin/env node
// Fit the simulator's opponent model to harvested real draft orders.
//
//   node calibrate.mjs                 fit against everything in data/harvest/
//   node calibrate.mjs --write         persist fitted params into config.json
//
// This is what makes the simulator's strategy choice trustworthy. Two parameters
// govern opponent behaviour:
//
//   sigmaBase/sigmaPerRound — how far picks stray from ADP (grows late)
//   runBonus                — how strongly drafters chase positional runs
//
// Both are fit by maximising agreement with the observed pick sequence, so the
// sim's opponents are measured rather than assumed.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(__dirname, 'config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const { values: a } = parseArgs({ options: { write: { type: 'boolean', default: false } } });

const dir = join(__dirname, 'data', 'harvest');
if (!existsSync(dir)) throw new Error('no data/harvest — run harvest.mjs during a live mock first');
const files = readdirSync(dir).filter(f => f.endsWith('.json'));
if (!files.length) throw new Error('data/harvest is empty');

const runs = files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
// Each room may have a different number of teams (a lobby join can land in a
// non-12-team room) — round bucketing must use THAT room's team count, never
// the league's, or picks land in the wrong round for every room but the target size.
const picks = runs.flatMap(r => (r.order || [])
  .map(p => ({ ...p, __teams: r.teams || cfg.league.teams })))
  .filter(p => p.adp != null && p.pickNo != null);
if (picks.length < 20) throw new Error(`only ${picks.length} usable picks harvested; need ~20+`);

const offSizeTeams = new Set(picks.filter(p => p.__teams !== cfg.league.teams).map(p => p.__teams));
if (offSizeTeams.size) console.log(`note: harvest includes room(s) with ${[...offSizeTeams].join(', ')} teams (league is ${cfg.league.teams}) — round bucketing corrected per-room.\n`);

// --- 1. ADP deviation ------------------------------------------------------
// Residual = actual pick number minus ADP. Its spread by round is exactly what
// sigmaBase/sigmaPerRound encode.
const byRound = new Map();
for (const p of picks) {
  const round = Math.max(1, Math.ceil(p.pickNo / p.__teams));
  (byRound.get(round) ?? byRound.set(round, []).get(round)).push(p.pickNo - p.adp);
}
const rows = [...byRound.entries()].sort((x, y) => x[0] - y[0]).map(([round, d]) => {
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, d.length - 1));
  return { round, n: d.length, meanResidual: +mean.toFixed(1), sd: +sd.toFixed(1) };
});

// Least-squares fit of sd = base + perRound*round
const pts = rows.filter(r => r.n >= 3);
let base = cfg.sim.sigmaBase, per = cfg.sim.sigmaPerRound;
if (pts.length >= 3) {
  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.round, 0);
  const sy = pts.reduce((s, p) => s + p.sd, 0);
  const sxx = pts.reduce((s, p) => s + p.round * p.round, 0);
  const sxy = pts.reduce((s, p) => s + p.round * p.sd, 0);
  const denom = n * sxx - sx * sx;
  if (denom !== 0) {
    per = (n * sxy - sx * sy) / denom;
    base = (sy - per * sx) / n;
  }
}
base = Math.max(0.5, +base.toFixed(2));
per = Math.max(0, +per.toFixed(3));

// --- 2. Position runs ------------------------------------------------------
// How much more likely is position P next, given P dominated the recent window?
const look = cfg.sim.runLookback, thresh = cfg.sim.runThreshold;
let runFollow = 0, runOpp = 0;
const seq = picks.slice().sort((x, y) => x.pickNo - y.pickNo);
for (let i = look; i < seq.length; i++) {
  const win = seq.slice(i - look, i);
  const counts = {};
  for (const w of win) counts[w.pos] = (counts[w.pos] || 0) + 1;
  const hot = Object.entries(counts).filter(([, c]) => c >= thresh).map(([p]) => p);
  if (!hot.length) continue;
  if (hot.includes(seq[i].pos)) runFollow++; else runOpp++;
}
// Base rate of the hot position absent any run effect ~ its share of the pool.
const share = 1 / 5;
const observed = runFollow / Math.max(1, runFollow + runOpp);
let runBonus = observed > 0 && observed < 1
  ? +( (observed / (1 - observed)) / (share / (1 - share)) ).toFixed(2)
  : cfg.sim.runBonus;
runBonus = Math.min(4, Math.max(1, runBonus));

console.log(`harvested picks: ${picks.length} across ${runs.length} run(s)\n`);
console.log('ADP residual spread by round:');
for (const r of rows) console.log(`  r${String(r.round).padStart(2)}  n=${String(r.n).padStart(3)}  mean ${String(r.meanResidual).padStart(6)}  sd ${String(r.sd).padStart(5)}`);
console.log(`\nfitted  sigmaBase ${cfg.sim.sigmaBase} -> ${base}`);
console.log(`fitted  sigmaPerRound ${cfg.sim.sigmaPerRound} -> ${per}`);
console.log(`fitted  runBonus ${cfg.sim.runBonus} -> ${runBonus}   (run-follow rate ${(observed * 100).toFixed(0)}% of ${runFollow + runOpp} windows)`);

if (a.write) {
  cfg.sim.sigmaBase = base;
  cfg.sim.sigmaPerRound = per;
  cfg.sim.runBonus = runBonus;
  cfg.sim.calibratedFrom = { runs: runs.length, picks: picks.length, at: new Date().toISOString() };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
  console.log('\nwrote fitted params into config.json — re-run simulate.mjs to reselect the strategy');
} else {
  console.log('\n(dry run — pass --write to persist)');
}
