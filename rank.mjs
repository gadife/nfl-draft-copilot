#!/usr/bin/env node
// Score, risk-adjust, and rank the player universe.
//   data/players-<date>.json  ->  data/rankings-<date>.json + reports/<date>-cheatsheet.md
//
// Usage:
//   node rank.mjs                       latest snapshot
//   node rank.mjs --in data/players-2026-08-21.json
//   node rank.mjs --calibrate           also write research/scoring-calibration.md
//   node rank.mjs --top 60              cheat-sheet depth per position

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointsFor, fitPaSd, COL, num } from './lib/scoring.mjs';
import { expectedGames, riskAdjust } from './lib/durability.mjs';
import { annotate } from './lib/vorp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' }, top: { type: 'string', default: '40' },
    calibrate: { type: 'boolean', default: false },
  },
});

const inPath = args.in || latest('players-');
const snap = JSON.parse(readFileSync(inPath, 'utf8'));
const date = snap.scrapedAt.slice(0, 10);

// --- score -----------------------------------------------------------------
const players = [];
const degraded = [];
for (const p of snap.players) {
  if (!p.proj) { degraded.push({ id: p.id, name: p.name, why: 'no projection row' }); continue; }
  const projGames = num(p.proj[COL.gp]) || 17;
  const yahooPts = num(p.proj[COL.fanPts]);

  // DEF projections: Yahoo's projected "Pts vs." column is NOT a season total.
  // It reads ~187 over 17 games (11 PA/game), which no real defense allows —
  // 2025 actuals were 286-334. The column means something else, so recomputing
  // from it is wrong by ~60 points. Yahoo's Fan Pts column IS league-scored
  // (proven exactly for offense and K during calibration), so for DEF
  // projections we take Fan Pts directly and record it as degraded.
  // The convolution stays — it's validated against 2025 ACTUALS, where the
  // per-game data is real. See research/verification-log.md [V-DEF].
  let custPts, ptsSource = 'recomputed';
  if (p.pos === 'DEF') {
    custPts = yahooPts;
    ptsSource = 'yahoo-fanpts';
    degraded.push({ id: p.id, name: p.name, why: 'DEF proj Pts-vs column unusable; used Yahoo Fan Pts' });
  } else {
    custPts = pointsFor(p.proj, p.pos, cfg.scoring, { games: projGames }).total;
  }
  const dur = expectedGames(p, cfg);
  const rec = {
    id: p.id, name: p.name, team: p.team, pos: p.pos,
    bye: num(p.proj[COL.bye]) || null,
    status: dur.status,
    yahooPts,
    custPts, ptsSource,
    projGames,
    // Yahoo's preseason rank stands in for ADP until real ADP is scraped from
    // the draft board. Correlated but not identical -- flagged, not hidden.
    adp: num(p.proj['Rankings|Pre-Season']) || null,
    gp2025: p.prior ? num(p.prior[COL.gp]) : null,
    pts2025: p.prior ? num(p.prior[COL.fanPts]) : null,
    expGames: +dur.expGames.toFixed(2),
    availability: +dur.availability.toFixed(3),
    chronic: dur.chronic,
  };
  rec.custPtsRiskAdj = riskAdjust(custPts, projGames, dur, cfg);
  players.push(rec);
}

const meta = annotate(players, cfg);
players.sort((a, b) => b.vorp - a.vorp);
players.forEach((p, i) => { p.overallRank = i + 1; });
for (const pos of new Set(players.map(p => p.pos))) {
  players.filter(p => p.pos === pos)
    .sort((a, b) => b.vorp - a.vorp)
    .forEach((p, i) => { p.posRank = i + 1; });
}
players.sort((a, b) => b.vorp - a.vorp);

const outPath = join(__dirname, 'data', `rankings-${date}.json`);
writeFileSync(outPath, JSON.stringify({
  builtAt: new Date().toISOString(), source: inPath, date,
  demand: meta.demand, flexSplit: meta.flexSplit, replacement: meta.replacement,
  adpSource: 'yahoo-preseason-rank (proxy)',
  degradedFields: degraded, count: players.length, players,
}, null, 1));

// --- cheat sheet -----------------------------------------------------------
const topN = Number(args.top);
const L = [];
L.push(`# Cheat Sheet — ${cfg.league.name} · ${date}`, '');
L.push(`12 teams · full-PPR · ${cfg.roster.draftedRounds} rounds. Ranked by **VORP** under league scoring.`, '');
L.push('## Replacement level', '');
L.push('| Pos | Starters demanded | Replacement pts | Flex slots won |');
L.push('|---|---|---|---|');
for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
  L.push(`| ${pos} | ${meta.demand[pos] ?? 0} | ${(meta.replacement[pos] ?? 0).toFixed(1)} | ${meta.flexSplit[pos] ?? 0} |`);
}
L.push('', `Flex allocation was computed, not assumed: ${JSON.stringify(meta.flexSplit)}.`, '');

L.push('## Top 40 overall by VORP', '');
L.push('| # | data-id | Player | Pos | Tm | Bye | Pts | VORP | RiskAdj | E[G] | 2025 GP | St |');
L.push('|--:|---|---|---|---|--:|--:|--:|--:|--:|--:|---|');
for (const p of players.slice(0, 40)) {
  L.push(`| ${p.overallRank} | \`${p.id}\` | ${p.name} | ${p.pos} | ${p.team ?? ''} | ${p.bye ?? ''} `
    + `| ${p.custPts.toFixed(1)} | ${p.vorp.toFixed(1)} | ${p.custPtsRiskAdj.toFixed(1)} `
    + `| ${p.expGames.toFixed(1)} | ${p.gp2025 ?? '—'} | ${p.status ?? ''} |`);
}
L.push('');
for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
  const pool = players.filter(p => p.pos === pos).slice(0, topN);
  L.push(`## ${pos}`, '');
  L.push('| # | data-id | Player | Tm | Bye | Pts | VORP | RiskAdj | E[G] | St |');
  L.push('|--:|---|---|---|--:|--:|--:|--:|--:|---|');
  for (const p of pool) {
    L.push(`| ${p.posRank} | \`${p.id}\` | ${p.name} | ${p.team ?? ''} | ${p.bye ?? ''} `
      + `| ${p.custPts.toFixed(1)} | ${p.vorp.toFixed(1)} | ${p.custPtsRiskAdj.toFixed(1)} `
      + `| ${p.expGames.toFixed(1)} | ${p.status ?? ''} |`);
  }
  L.push('');
}
mkdirSync(join(__dirname, 'reports'), { recursive: true });
const cheatPath = join(__dirname, 'reports', `${date}-cheatsheet.md`);
writeFileSync(cheatPath, L.join('\n'));

// --- calibration -----------------------------------------------------------
if (args.calibrate) {
  const defs = snap.players.filter(p => p.pos === 'DEF' && p.prior).map(p => ({ cols: p.prior }));
  const fit = fitPaSd(defs, cfg.scoring);
  // Gate only the positions we recompute. DEF is sourced from Yahoo's Fan Pts,
  // so comparing it to itself would be a vacuous pass.
  const rows = players.map(p => ({ ...p, diff: p.custPts - p.yahooPts }))
    .filter(p => p.yahooPts > 20 && p.ptsSource === 'recomputed');
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const big = rows.filter(r => Math.abs(r.diff) > 5);
  const pct = (100 * big.length / rows.length);
  const C = [];
  C.push(`# Scoring calibration — ${date}`, '');
  C.push(`Our recomputed points vs Yahoo's league-scored "Fan Pts", ${rows.length} players with >20 pts.`, '');
  C.push(`- mean delta **${(rows.reduce((a, b) => a + b.diff, 0) / rows.length).toFixed(3)}**`);
  C.push(`- |delta| > 5: **${big.length} (${pct.toFixed(1)}%)** — gate is 5%, so this **${pct > 5 ? 'FAILS' : 'PASSES'}**`);
  C.push(`- DEF points-allowed dispersion fitted across 32 defenses on 2025 ACTUALS: **paSd = ${fit.sd}**, RMSE ${fit.rmse}`);
  C.push(`- DEF projections excluded from this gate: Yahoo's projected "Pts vs." column is not a season total`,
         `  (~187 over 17 games = 11 PA/g, vs 286-334 actual), so DEF proj points come from Yahoo Fan Pts directly.`, '');
  C.push('Residuals are dominated by Yahoo rounding its displayed component stats',
         '(e.g. receptions shown as 69.2), plus off-position stats absent from a',
         "position's column set — Brandon Aubrey's 0.60 gap was 6 rushing yards on a fake FG.", '');
  C.push('| Player | Pos | Yahoo | Ours | Delta |', '|---|---|--:|--:|--:|');
  for (const r of rows.slice(0, 15)) {
    C.push(`| ${r.name} | ${r.pos} | ${r.yahooPts.toFixed(1)} | ${r.custPts.toFixed(1)} | ${r.diff.toFixed(2)} |`);
  }
  mkdirSync(join(__dirname, 'research'), { recursive: true });
  writeFileSync(join(__dirname, 'research', 'scoring-calibration.md'), C.join('\n'));
  console.log(`calibration: mean~0, |d|>5 = ${big.length}/${rows.length} (${pct.toFixed(1)}%), paSd=${fit.sd}`);
}

console.log(`wrote ${outPath}`);
console.log(`wrote ${cheatPath}`);
console.log(`demand:`, meta.demand, `flex:`, meta.flexSplit);
if (degraded.length) console.log(`degraded: ${degraded.length} notes (see degradedFields in rankings JSON)`);

function latest(prefix) {
  const dir = join(__dirname, 'data');
  const f = readdirSync(dir).filter(x => x.startsWith(prefix)).sort().pop();
  if (!f) throw new Error(`no ${prefix}*.json in data/ — run scrape-board.mjs first`);
  return join(dir, f);
}
