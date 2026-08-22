#!/usr/bin/env node
// Paired strategy bakeoff.
//
//   node simulate.mjs                        all strategies x 12 slots x N seeds
//   node simulate.mjs --seeds 20             seeds per slot
//   node simulate.mjs --strategies a,b       subset
//   node simulate.mjs --slots 1,6,12         subset (1-based)
//
// Pairing is the whole point: every strategy faces the SAME (slot, seed)
// opponents, so differencing removes slot variance, which otherwise dominates.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES } from './lib/strategies.mjs';
import { simulateDraft } from './lib/sim.mjs';
import { evaluateRoster, composite } from './lib/evaluate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const { values: args } = parseArgs({
  options: {
    seeds: { type: 'string', default: '20' },
    strategies: { type: 'string' },
    slots: { type: 'string' },
    in: { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
});

const rankPath = args.in || latest('rankings-');
const ranks = JSON.parse(readFileSync(rankPath, 'utf8'));
const players = ranks.players;
// Replacement levels feed the starter-first marginal calculation in strategies.
cfg.__replacement = ranks.replacement ?? {};

const names = args.strategies ? args.strategies.split(',') : Object.keys(STRATEGIES);
for (const n of names) if (!STRATEGIES[n]) throw new Error(`unknown strategy: ${n}`);
const slots = args.slots ? args.slots.split(',').map(s => +s - 1)
  : Array.from({ length: cfg.league.teams }, (_, i) => i);
const seedCount = Number(args.seeds);

const runs = [];
const t0 = Date.now();
for (const strategy of names) {
  for (const slot of slots) {
    for (let s = 0; s < seedCount; s++) {
      const seed = `s${s}`;
      const res = simulateDraft({
        players, strategy, strategyFn: STRATEGIES[strategy],
        mySlot: slot, seed, cfg,
      });
      const metrics = evaluateRoster(res.roster, cfg);
      runs.push({ strategy, slot, seed, metrics, log: res.log });
    }
  }
}
composite(runs, cfg);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// --- aggregate -------------------------------------------------------------
const agg = {};
for (const r of runs) {
  const a = agg[r.strategy] ??= { n: 0, startPts: [], riskAdj: [], comp: [], vorp: [], sanity: 0, pos: {} };
  a.n++;
  a.startPts.push(r.metrics.startPts);
  a.riskAdj.push(r.metrics.startPtsRiskAdj);
  a.comp.push(r.composite);
  a.vorp.push(r.metrics.vorpSum);
  if (r.metrics.sanity.length) a.sanity++;
  for (const [p, c] of Object.entries(r.metrics.posCount)) {
    a.pos[p] = (a.pos[p] || 0) + c / 1;
  }
}
const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
const sd = (x) => Math.sqrt(mean(x.map(v => (v - mean(x)) ** 2)));

// Paired differences vs the control, which is what the sample size supports.
const CONTROL = 'adp-baseline';
const paired = {};
if (names.includes(CONTROL)) {
  const key = (r) => `${r.slot}|${r.seed}`;
  const ctrl = new Map(runs.filter(r => r.strategy === CONTROL).map(r => [key(r), r]));
  for (const n of names.filter(x => x !== CONTROL)) {
    const diffs = runs.filter(r => r.strategy === n)
      .map(r => { const c = ctrl.get(key(r)); return c ? r.metrics.startPts - c.metrics.startPts : null; })
      .filter(v => v != null);
    const m = mean(diffs), s = sd(diffs);
    const se = s / Math.sqrt(diffs.length);
    paired[n] = { n: diffs.length, meanDiff: +m.toFixed(1), sd: +s.toFixed(1),
      se: +se.toFixed(1), t: +(m / (se || 1)).toFixed(2) };
  }
}

const rows = names.map(n => ({
  strategy: n,
  n: agg[n].n,
  startPts: +mean(agg[n].startPts).toFixed(1),
  startPtsSd: +sd(agg[n].startPts).toFixed(1),
  riskAdj: +mean(agg[n].riskAdj).toFixed(1),
  vorpSum: +mean(agg[n].vorp).toFixed(1),
  composite: +mean(agg[n].comp).toFixed(2),
  sanityFails: agg[n].sanity,
  avgPos: Object.fromEntries(Object.entries(agg[n].pos)
    .map(([k, v]) => [k, +(v / agg[n].n).toFixed(1)])),
})).sort((a, b) => b.composite - a.composite);

const date = new Date().toISOString().slice(0, 10);
mkdirSync(join(__dirname, 'sims'), { recursive: true });
mkdirSync(join(__dirname, 'reports'), { recursive: true });
writeFileSync(join(__dirname, 'sims', `${date}-bakeoff.json`),
  JSON.stringify({ builtAt: new Date().toISOString(), rankSource: rankPath,
    adpSource: ranks.adpSource, seedCount, slots: slots.map(s => s + 1),
    drafts: runs.length, elapsedSec: +elapsed, rows, paired }, null, 1));

const L = [];
L.push(`# Strategy bakeoff — ${date}`, '');
L.push(`${runs.length} simulated drafts (${names.length} strategies x ${slots.length} slots x ${seedCount} seeds) in ${elapsed}s.`, '');
L.push(`Rankings: \`${rankPath.split('/').pop()}\` · ADP source: **${ranks.adpSource}**`, '');
L.push('## Ranking', '');
L.push('| Strategy | Composite | StartPts | ±SD | RiskAdj | VORPsum | Sanity fails | Avg roster |');
L.push('|---|--:|--:|--:|--:|--:|--:|---|');
for (const r of rows) {
  L.push(`| \`${r.strategy}\` | ${r.composite} | **${r.startPts}** | ${r.startPtsSd} | ${r.riskAdj} `
    + `| ${r.vorpSum} | ${r.sanityFails} | ${Object.entries(r.avgPos).map(([k, v]) => `${k}${v}`).join(' ')} |`);
}
L.push('');
if (Object.keys(paired).length) {
  L.push(`## Paired vs control (\`${CONTROL}\`)`, '');
  L.push('Same slot and same opponent seed on both sides, so slot variance cancels.', '');
  L.push('| Strategy | Mean StartPts diff | SD | SE | t |');
  L.push('|---|--:|--:|--:|--:|');
  for (const [n, p] of Object.entries(paired).sort((a, b) => b[1].meanDiff - a[1].meanDiff)) {
    L.push(`| \`${n}\` | ${p.meanDiff > 0 ? '+' : ''}${p.meanDiff} | ${p.sd} | ${p.se} | ${p.t} |`);
  }
  L.push('', '`|t| > 2` is the rough bar for "not noise". Composite is z-scored **within this pool only** — compare rows here, never across reports.', '');
}
writeFileSync(join(__dirname, 'reports', `${date}-bakeoff.md`), L.join('\n'));

if (!args.quiet) {
  console.log(`${runs.length} drafts in ${elapsed}s\n`);
  console.log('strategy'.padEnd(18), 'comp'.padStart(7), 'startPts'.padStart(9), 'sd'.padStart(6), 'sanity'.padStart(7));
  for (const r of rows) {
    console.log(r.strategy.padEnd(18), String(r.composite).padStart(7),
      String(r.startPts).padStart(9), String(r.startPtsSd).padStart(6), String(r.sanityFails).padStart(7));
  }
  if (Object.keys(paired).length) {
    console.log('\npaired vs control:');
    for (const [n, p] of Object.entries(paired).sort((a, b) => b[1].meanDiff - a[1].meanDiff)) {
      console.log('  ', n.padEnd(18), `${p.meanDiff > 0 ? '+' : ''}${p.meanDiff}`.padStart(7), `t=${p.t}`.padStart(9));
    }
  }
}

function latest(prefix) {
  const dir = join(__dirname, 'data');
  const f = readdirSync(dir).filter(x => x.startsWith(prefix)).sort().pop();
  if (!f) throw new Error(`no ${prefix}*.json in data/`);
  return join(dir, f);
}
