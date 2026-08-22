// Roster metrics. Pure. Used identically by the offline sim and by live mocks,
// so results are comparable across venues.

import { rosterInjuryExposure } from './durability.mjs';

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF'];
const FLEX = new Set(['RB', 'WR', 'TE']);
const WEEKS = 17;

const eligible = (p, slot) => slot === 'W/R/T' ? FLEX.has(p.pos) : p.pos === slot;

/**
 * Fill the 9 starting slots for one week from whoever is available, best-first.
 *
 * Scarce slots are filled before the flex, otherwise a greedy pass can burn the
 * flex on a WR and leave TE empty. Returns points and which slots went unfilled.
 */
function bestLineup(roster, week, valueOf) {
  const avail = roster.filter(p => p.bye !== week);
  const used = new Set();
  let pts = 0, unfilled = 0;
  // Fixed slots first (most constrained), flex last.
  const order = SLOTS.map((s, i) => ({ s, i })).sort((a, b) =>
    (a.s === 'W/R/T' ? 1 : 0) - (b.s === 'W/R/T' ? 1 : 0));
  for (const { s } of order) {
    let best = null, bestV = -Infinity;
    for (const p of avail) {
      if (used.has(p.id) || !eligible(p, s)) continue;
      const v = valueOf(p);
      if (v > bestV) { bestV = v; best = p; }
    }
    if (best) { used.add(best.id); pts += bestV; }
    else unfilled++;
  }
  return { pts, unfilled };
}

/**
 * Season points of the optimal starting nine, ignoring byes.
 *
 * Exported because the pick policies need it: raw VORP cannot tell the
 * difference between a player who fills an empty starter slot and a player who
 * is the third-best option at a position you already have covered. Ignoring
 * byes here is deliberate — this is a fast marginal-value probe called for every
 * candidate on every pick, and bye structure is scored separately.
 */
export function startersValue(roster) {
  const used = new Set();
  let total = 0;
  const order = SLOTS.map(s => s).sort((a, b) => (a === 'W/R/T' ? 1 : 0) - (b === 'W/R/T' ? 1 : 0));
  for (const s of order) {
    let best = null, bestV = -Infinity;
    for (const p of roster) {
      if (used.has(p.id) || !eligible(p, s)) continue;
      const v = p.custPts ?? 0;
      if (v > bestV) { bestV = v; best = p; }
    }
    if (best) { used.add(best.id); total += bestV; }
  }
  return total;
}

/** How many projected starters would share `week` as a bye if `add` joined. */
export function starterByeLoad(roster, add) {
  const starters = pickStarters(add ? [...roster, add] : roster, p => p.custPts ?? 0);
  const counts = {};
  for (const p of starters) if (p.bye) counts[p.bye] = (counts[p.bye] || 0) + 1;
  return counts;
}

export function evaluateRoster(roster, cfg, { yahooGrade = null } = {}) {
  const perGame = (p) => p.custPts / (p.projGames || 17);
  // Availability-weighted per-game value. Folding risk in here means a durable
  // bench player can legitimately outrank a fragile starter for a given week,
  // which is the substitution effect we want to reward.
  const perGameRisk = (p) => perGame(p) * (p.availability ?? 1);

  let startPts = 0, startPtsRiskAdj = 0, byeUnfilled = 0, thinWeeks = 0;
  for (let w = 1; w <= WEEKS; w++) {
    const a = bestLineup(roster, w, perGame);
    const b = bestLineup(roster, w, perGameRisk);
    startPts += a.pts;
    startPtsRiskAdj += b.pts;
    byeUnfilled += a.unfilled;
    // Byes end after week 14, so anything here is a real roster-construction
    // problem, not playoff exposure. Playoff SOS needs external data (--with-sos).
    const out = roster.filter(p => p.bye === w).length;
    if (out >= 3) thinWeeks++;
  }

  // Depth: per-game points lost if each starter disappears and the best legal
  // replacement steps in. Separates a top-heavy roster from a robust one.
  const wk = 1;
  const baseline = bestLineup(roster, wk, perGame).pts;
  const starters = pickStarters(roster, perGame);
  let dropSum = 0;
  for (const s of starters) {
    const without = roster.filter(p => p.id !== s.id);
    dropSum += Math.max(0, baseline - bestLineup(without, wk, perGame).pts)
      * (1 - (s.availability ?? 1));
  }
  const depthScore = -dropSum; // less drop = better

  const durs = roster.map(p => ({
    weeklyMissed: p.chronic ? 0 : (17 - (p.expGames ?? 17)),
    chronicMissed: p.chronic ? (17 - (p.expGames ?? 17)) : 0,
    chronic: !!p.chronic,
  }));

  const posCount = {};
  for (const p of roster) posCount[p.pos] = (posCount[p.pos] || 0) + 1;

  return {
    startPts, startPtsRiskAdj,
    totalRosterPts: roster.reduce((a, p) => a + p.custPts, 0),
    vorpSum: roster.reduce((a, p) => a + (p.vorp ?? 0), 0),
    byePenalty: -(byeUnfilled + thinWeeks * 2),
    injuryExposure: -rosterInjuryExposure(durs, cfg),
    depthScore,
    yahooGrade,
    posCount,
    sanity: sanityFlags(roster, posCount, cfg, starters),
  };
}

function pickStarters(roster, valueOf) {
  const used = new Set(), out = [];
  const order = SLOTS.map(s => s).sort((a, b) => (a === 'W/R/T' ? 1 : 0) - (b === 'W/R/T' ? 1 : 0));
  for (const s of order) {
    let best = null, bestV = -Infinity;
    for (const p of roster) {
      if (used.has(p.id) || !eligible(p, s)) continue;
      const v = valueOf(p);
      if (v > bestV) { bestV = v; best = p; }
    }
    if (best) { used.add(best.id); out.push(best); }
  }
  return out;
}

/** Hard failures that should veto a strategy regardless of its composite. */
function sanityFlags(roster, posCount, cfg, starters = []) {
  const f = [];
  if (roster.length !== cfg.roster.draftedRounds) f.push(`roster=${roster.length}`);
  for (const slot of new Set(SLOTS)) {
    const need = SLOTS.filter(s => s === slot).length;
    if (slot === 'W/R/T') continue;
    if ((posCount[slot] || 0) < need) f.push(`short-${slot}`);
  }
  if ((posCount.RB || 0) <= 1) f.push('rb<=1');
  if ((posCount.WR || 0) <= 1) f.push('wr<=1');
  // Starters only. Five bench players sharing a bye is harmless; five STARTERS
  // sharing one is a hole you cannot cover.
  const byeCount = {};
  for (const p of starters) if (p.bye) byeCount[p.bye] = (byeCount[p.bye] || 0) + 1;
  if (Object.values(byeCount).some(v => v > 4)) f.push('starter-bye-stack>4');
  return f;
}

/**
 * Composite: z-score each component within the comparison pool, then weight.
 *
 * EVERY metric above is stored higher-is-better (byePenalty, injuryExposure and
 * depthScore are already negated at source), so weights are plain positive
 * magnitudes and no direction handling is needed here.
 *
 * Only meaningful RELATIVE to its pool — callers must also print raw startPts.
 */
export function composite(results, cfg) {
  const W = cfg.compositeWeights;
  const keys = Object.keys(W);
  const stats = {};
  for (const k of keys) {
    const vals = results.map(r => r.metrics[k]).filter(v => typeof v === 'number');
    if (!vals.length) { stats[k] = null; continue; }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    stats[k] = { mean, sd };
  }
  for (const r of results) {
    let score = 0, used = 0;
    for (const k of keys) {
      // Skip components with no data in this pool (e.g. yahooGrade offline)
      // rather than silently scoring them as average.
      if (!stats[k] || typeof r.metrics[k] !== 'number') continue;
      score += W[k] * ((r.metrics[k] - stats[k].mean) / stats[k].sd);
      used += W[k];
    }
    r.composite = used ? score / used * 100 : 0;
    r.compositeWeightUsed = used;
  }
  return results;
}
