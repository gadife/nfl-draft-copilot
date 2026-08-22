// Pick policies. All pure, all deterministic: same (state, seed) -> same pick.
// Each returns the chosen player plus an ordered candidate list, because the
// live harness needs the top-N for its one-round-trip click and queue sync.

import { expectedBestSurvivor } from './vorp.mjs';
import { startersValue, starterByeLoad } from './evaluate.mjs';

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF'];
const FLEX = new Set(['RB', 'WR', 'TE']);

/** Slots still unfilled, given what's already on the roster. */
function needs(roster) {
  const have = {};
  for (const p of roster) have[p.pos] = (have[p.pos] || 0) + 1;
  const left = {};
  for (const s of new Set(SLOTS)) {
    if (s === 'W/R/T') continue;
    left[s] = Math.max(0, SLOTS.filter(x => x === s).length - (have[s] || 0));
  }
  const flexNeed = SLOTS.filter(x => x === 'W/R/T').length
    - Math.max(0, ['RB', 'WR', 'TE'].reduce((a, p) =>
      a + Math.max(0, (have[p] || 0) - SLOTS.filter(x => x === p).length), 0));
  return { left, flexNeed: Math.max(0, flexNeed), have };
}

/**
 * Legality, shared by every strategy so they differ only in valuation.
 * Two jobs: cap roster composition, and refuse picks that would make a legal
 * 9-man starting lineup impossible in the rounds remaining.
 */
export function isLegal(p, state, cfg, { enforceKdefFloor = true } = {}) {
  const { roster, round } = state;
  const max = cfg.constraints.maxByPos[p.pos];
  const have = roster.filter(r => r.pos === p.pos).length;
  if (max != null && have >= max) return false;

  if (enforceKdefFloor && (p.pos === 'K' || p.pos === 'DEF')
      && round < cfg.constraints.kdefMinRound) return false;

  const picksLeft = cfg.roster.draftedRounds - roster.length;
  const { left, flexNeed } = needs(roster);
  let required = Object.values(left).reduce((a, b) => a + b, 0) + flexNeed;
  // Taking a player only helps if it reduces a requirement; otherwise it must
  // fit in the slack.
  const helps = (left[p.pos] > 0) || (FLEX.has(p.pos) && flexNeed > 0);
  if (!helps && picksLeft <= required) return false;
  return true;
}

function legalPool(state, cfg, opts) {
  return state.available.filter(p => isLegal(p, state, cfg, opts));
}

// Deterministic tiebreak everywhere: value desc, then ADP asc, then id asc.
const cmp = (key) => (a, b) =>
  (b[key] - a[key]) || ((a.adp ?? 9999) - (b.adp ?? 9999)) || (a.id < b.id ? -1 : 1);

function top(pool, key, n = 8) {
  return [...pool].sort(cmp(key)).slice(0, n);
}

/**
 * Starter-first + bye-aware rescoring.
 *
 * Two problems raw value metrics have, both observed in live mock #1:
 *
 *  1. With roster slack, a scarce-position BACKUP outranks filling an empty
 *     starter slot — the mock autodrafted a backup QB while WR2 and flex were
 *     empty. A bench QB scores nothing most weeks. So blend raw value with the
 *     player's *marginal contribution to the starting nine*.
 *  2. Nothing avoided bye collisions during the draft; the metric only punished
 *     them afterwards. Penalise a pick that pushes a bye week past the limit.
 *
 * Only the top `depth` candidates get rescored — the marginal probe rebuilds a
 * lineup per candidate, which is too slow to run across the whole pool.
 */
function slotAware(pool, key, state, cfg, depth = 20) {
  const maxBye = cfg.strategy?.maxStarterBye ?? 3;
  const byePenalty = cfg.strategy?.byePenalty ?? 12;
  const benchWeight = cfg.strategy?.benchWeight ?? 0.15;
  const repl = cfg.__replacement ?? {};
  const roster = state.roster ?? [];

  const head = [...pool].sort(cmp(key)).slice(0, depth);
  for (const p of head) {
    // Marginal value measured against a REPLACEMENT-level player at the same
    // position, not against an empty slot. Against an empty slot the gain is
    // the player's whole point total, which is not commensurate with VORP and
    // simply favours whoever scores most in absolute terms (i.e. quarterbacks).
    // This way: empty slot -> marginal ~ VORP; already-covered slot -> ~0.
    const withP = startersValue([...roster, p]);
    const withRepl = startersValue([...roster,
      { id: '__repl', pos: p.pos, custPts: repl[p.pos] ?? 0, bye: null }]);
    const marginal = withP - withRepl;

    // Bench/upside still has value (insurance, breakouts) but heavily discounted.
    p._slotScore = marginal + benchWeight * Math.max(0, (p[key] ?? 0) - marginal);

    const load = starterByeLoad(roster, p)[p.bye] ?? 0;
    if (load > maxBye) p._slotScore -= byePenalty * (load - maxBye);
  }
  const tail = [...pool].sort(cmp(key)).slice(depth);
  const minHead = head.length ? Math.min(...head.map(p => p._slotScore)) : 0;
  tail.forEach((p, i) => { p._slotScore = minHead - 1 - i * 1e-6; });
  return [...head, ...tail].sort(cmp('_slotScore'));
}

const pack = (ranked, reason) => ranked.length
  ? { player: ranked[0], dataId: ranked[0].id, reason, candidates: ranked.map(p => p.id) }
  : { player: null, dataId: null, reason: 'no legal player', candidates: [] };

// --- S0: control -----------------------------------------------------------
// Best Yahoo rank among legal players. Reproduces "just follow Yahoo", which is
// what earns a good Yahoo grade. Runs WITHOUT the K/DEF round floor, otherwise
// we'd never test whether taking them early is actually a mistake.
export const adpBaseline = (state, cfg) => {
  const pool = legalPool(state, cfg, { enforceKdefFloor: false })
    .map(p => ({ ...p, _neg: -(p.adp ?? 9999) }));
  return pack(top(pool, '_neg'), 'best Yahoo preseason rank');
};

// --- S1/S2: value ----------------------------------------------------------
export const vorpCustom = (state, cfg) =>
  pack(top(legalPool(state, cfg), 'vorp'), 'max VORP (league scoring)');

export const vorpDurability = (state, cfg) =>
  pack(top(legalPool(state, cfg), 'vorpDur'), 'max risk-adjusted VORP');

// --- S3: VONA --------------------------------------------------------------
// Reach-or-wait. Values a player by how much worse that position will be by my
// next turn, rather than by raw value now.
export const vonaScarcity = (state, cfg) => {
  const pool = legalPool(state, cfg);
  const byPos = {};
  for (const pos of new Set(pool.map(p => p.pos))) {
    byPos[pos] = expectedBestSurvivor(pool, pos, state.myNextPick, cfg);
  }
  const scored = pool.map(p => ({ ...p, vona: p.vorp - (byPos[p.pos] ?? 0) }));
  return pack(top(scored, 'vona'), 'max VONA (value over next available)');
};

// --- S4/S5: structural -----------------------------------------------------
// Masks expressed as data, applied over VORP.
function structural(mask) {
  return (state, cfg) => {
    const pool = legalPool(state, cfg);
    const r = state.round;
    const rule = mask.find(m => r >= m.from && r <= m.to);
    let scored = pool;
    if (rule) {
      if (rule.only) scored = scored.filter(p => rule.only.includes(p.pos));
      if (rule.exclude) scored = scored.filter(p => !rule.exclude.includes(p.pos));
      if (rule.bonus) scored = scored.map(p => ({
        ...p, vorp: p.vorp * (1 + (rule.bonus[p.pos] ?? 0)),
      }));
    }
    // Never let a mask paint us into an illegal roster.
    if (!scored.length) scored = pool;
    return pack(top(scored, 'vorp'), rule ? `structural r${r}` : `max VORP r${r}`);
  };
}

// Half-PPR compresses the RB/WR gap far less than full PPR, so Zero-RB is
// weaker here than its reputation. Tested, not assumed.
export const zeroRb = structural([
  { from: 1, to: 4, only: ['WR', 'TE', 'QB'] },
  { from: 5, to: 9, bonus: { RB: 0.25 } },
]);

export const heroRb = structural([
  { from: 1, to: 1, only: ['RB'] },
  { from: 2, to: 5, exclude: ['RB'] },
]);

// --- S6: tiers -------------------------------------------------------------
// 1-D Jenks on each position's value curve; act on cliffs, not on raw rank.
export function jenksBreaks(values, k) {
  if (values.length <= k) return values.map((_, i) => i);
  const gaps = values.slice(1).map((v, i) => values[i] - v)
    .map((g, i) => ({ g, i: i + 1 }))
    .sort((a, b) => b.g - a.g)
    .slice(0, k - 1)
    .map(x => x.i)
    .sort((a, b) => a - b);
  return gaps;
}

export const tierBased = (state, cfg) => {
  const pool = legalPool(state, cfg);
  const picksUntil = state.myNextPick - state.pickNo;
  const scored = [];
  for (const pos of new Set(pool.map(p => p.pos))) {
    const list = [...pool].filter(p => p.pos === pos).sort(cmp('vorp'));
    const breaks = new Set(jenksBreaks(list.map(p => p.vorp), 6));
    let tier = 1, countInTier = 0;
    const tiers = list.map((p, i) => {
      if (breaks.has(i)) { tier++; countInTier = 0; }
      countInTier++;
      return { ...p, tier, idxInTier: countInTier };
    });
    const curTier = tiers.filter(t => t.tier === tiers[0].tier);
    // Cliff bonus: last player in the current tier, and my next turn is far off.
    const cliff = curTier.length === 1 && picksUntil >= 6;
    for (const t of tiers) {
      scored.push({ ...t, tierScore: t.vorp + (cliff && t.tier === tiers[0].tier ? 15 : 0) });
    }
  }
  return pack(top(scored, 'tierScore'), 'tier-cliff aware');
};

// --- starter-first + bye-aware variants -----------------------------------
// Kept as separate strategies rather than replacing the originals, so the
// bakeoff measures whether the fix actually helps instead of assuming it.

export const vorpStarter = (state, cfg) =>
  pack(slotAware(legalPool(state, cfg), 'vorp', state, cfg).slice(0, 8),
    'starter-first VORP (bye-aware)');

export const vorpDurStarter = (state, cfg) =>
  pack(slotAware(legalPool(state, cfg), 'vorpDur', state, cfg).slice(0, 8),
    'starter-first risk-adj VORP (bye-aware)');

export const vonaStarter = (state, cfg) => {
  const pool = legalPool(state, cfg);
  const byPos = {};
  for (const pos of new Set(pool.map(p => p.pos))) {
    byPos[pos] = expectedBestSurvivor(pool, pos, state.myNextPick, cfg);
  }
  const scored = pool.map(p => ({ ...p, vona: p.vorp - (byPos[p.pos] ?? 0) }));
  return pack(slotAware(scored, 'vona', state, cfg).slice(0, 8),
    'starter-first VONA (bye-aware)');
};

export const STRATEGIES = {
  'adp-baseline': adpBaseline,
  'vorp-custom': vorpCustom,
  'vorp-durability': vorpDurability,
  'vona-scarcity': vonaScarcity,
  'zero-rb': zeroRb,
  'hero-rb': heroRb,
  'tier-based': tierBased,
  'vorp-starter': vorpStarter,
  'vorp-dur-starter': vorpDurStarter,
  'vona-starter': vonaStarter,
};

export { needs };
