#!/usr/bin/env node
// Scrape the full league player universe into data/players-<date>.json.
//
// Usage:
//   node scrape-board.mjs                 full scrape (all positions, proj + 2025)
//   node scrape-board.mjs --pos QB,K      only these positions
//   node scrape-board.mjs --dry-run       print what would be fetched
//   node scrape-board.mjs --max-pages 2   cap pagination (smoke test)
//
// Two stat modes per position:
//   S_PS_2026  season projections  -> what we draft on
//   S_S_2025   last season actuals -> games played, for the durability model
// Merged per player id, since the id space is global (see research/verification-log.md).

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJs, ensureYahooPage, sleep } from './lib/cdp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const STAT_MODES = { proj: 'S_PS_2026', prior: 'S_S_2025' };
const ALL_POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

const { values: args } = parseArgs({
  options: {
    pos: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'max-pages': { type: 'string', default: '30' },
    out: { type: 'string' },
  },
});

const positions = args.pos ? args.pos.split(',').map(s => s.trim().toUpperCase()) : ALL_POS;
const maxPages = Number(args['max-pages']);
const league = config.league.id;
const snippet = readFileSync(join(__dirname, 'js', 'scrape_players.js'), 'utf8')
  .replace(/^\/\/.*$/gm, '').trim();

// The CLI evaluates a bare function declaration and calls it with no arguments
// (its --args only carries element uids), so bind parameters by substituting
// the arrow header for consts.
function bind(fn, vars) {
  const decls = Object.entries(vars).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join(' ');
  const out = fn.replace(/^async\s*\([^)]*\)\s*=>\s*\{/, `async () => { ${decls}`);
  if (out === fn) throw new Error('bind: could not rewrite function signature');
  return out;
}

const jobs = positions.flatMap(p => Object.entries(STAT_MODES).map(([k, s]) => ({ pos: p, mode: k, stat: s })));

if (args['dry-run']) {
  console.log(`league ${league}, maxPages ${maxPages}`);
  for (const j of jobs) console.log(`  ${j.pos.padEnd(4)} ${j.mode.padEnd(6)} ${j.stat}`);
  process.exit(0);
}

ensureYahooPage(config.league.url);

const byId = new Map();
const degraded = [];
let headerKeysByPos = {};

for (const j of jobs) {
  process.stderr.write(`scraping ${j.pos}/${j.mode} ... `);
  let res;
  try {
    res = runJs(bind(snippet, { LEAGUE: league, POS: j.pos, STAT: j.stat, MAXPAGES: maxPages }));
  } catch (e) {
    degraded.push({ pos: j.pos, mode: j.mode, error: String(e).slice(0, 200) });
    process.stderr.write(`FAILED\n`);
    continue;
  }
  if (res.error) degraded.push({ pos: j.pos, mode: j.mode, error: res.error });
  headerKeysByPos[`${j.pos}.${j.mode}`] = res.headerKeys;

  for (const p of res.players) {
    if (!byId.has(p.id)) {
      byId.set(p.id, { id: p.id, name: p.name, team: p.team, pos: j.pos, posRaw: p.posRaw, status: p.status });
    }
    const rec = byId.get(p.id);
    rec[j.mode] = p.cols;
    if (p.status && !rec.status) rec.status = p.status;
  }
  process.stderr.write(`${res.count}\n`);
  sleep(800); // be a polite client
}

const date = new Date().toISOString().slice(0, 10);
const outPath = args.out || join(__dirname, 'data', `players-${date}.json`);
mkdirSync(dirname(outPath), { recursive: true });

const payload = {
  scrapedAt: new Date().toISOString(),
  league: { id: league, name: config.league.name },
  statModes: STAT_MODES,
  headerKeysByPos,
  degradedFields: degraded,
  count: byId.size,
  players: [...byId.values()],
};
writeFileSync(outPath, JSON.stringify(payload, null, 1));

const byPos = {};
for (const p of payload.players) byPos[p.pos] = (byPos[p.pos] || 0) + 1;
console.log(`wrote ${outPath}`);
console.log(`  ${payload.count} players:`, Object.entries(byPos).map(([k, v]) => `${k}=${v}`).join(' '));
if (degraded.length) console.log(`  DEGRADED:`, degraded);
