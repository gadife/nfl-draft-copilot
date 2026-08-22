// Offline snake-draft simulator. The primary evidence engine: paired runs
// (same slot, same opponent seed) cancel the draft-slot variance that otherwise
// swamps strategy differences.

import { rngFor, gauss } from './rng.mjs';
import { isLegal, needs } from './strategies.mjs';

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF'];

/** Snake order: pick number (1-based) -> team index (0-based). */
export function snakeTeam(pickNo, teams) {
  const round = Math.floor((pickNo - 1) / teams);
  const idx = (pickNo - 1) % teams;
  return round % 2 === 0 ? idx : teams - 1 - idx;
}

function botLegal(p, roster, round, cfg) {
  const max = cfg.constraints.maxByPos[p.pos];
  const have = roster.filter(r => r.pos === p.pos).length;
  if (max != null && have >= max) return false;
  // Bots hold K/DEF slightly later than our floor, matching observed behaviour.
  if ((p.pos === 'K' || p.pos === 'DEF') && round < cfg.sim.botKdefMinRound) return false;
  const picksLeft = cfg.roster.draftedRounds - roster.length;
  const { left, flexNeed } = needs(roster);
  const required = Object.values(left).reduce((a, b) => a + b, 0) + flexNeed;
  const helps = (left[p.pos] > 0) || (['RB', 'WR', 'TE'].includes(p.pos) && flexNeed > 0);
  return helps || picksLeft > required;
}

/**
 * Opponent pick.
 *
 * Two components, and the second one matters more than it looks:
 *  - noisy ADP, with noise growing by round (late rounds are guesswork)
 *  - POSITION RUNS: if a position is going hot, opponents chase it. A pure-ADP
 *    model misses this entirely and therefore systematically overrates
 *    "wait on RB" strategies. This is the difference between a sim that is
 *    useful and one that lies.
 */
function botPick(state, cfg, rand, archetype) {
  const { available, roster, round, recent } = state;
  const s = cfg.sim;
  const sigma = s.sigmaBase + s.sigmaPerRound * round;

  const runCount = {};
  for (const pos of recent.slice(-s.runLookback)) runCount[pos] = (runCount[pos] || 0) + 1;

  const pool = available.filter(p => botLegal(p, roster, round, cfg));
  if (!pool.length) return available[0] ?? null;

  const { left, flexNeed } = needs(roster);

  let best = null, bestScore = Infinity;
  for (const p of pool) {
    let score = (p.adp ?? 9999) + gauss(rand, 0, sigma);
    if ((runCount[p.pos] ?? 0) >= s.runThreshold) score /= s.runBonus;
    if (archetype === 'runFollower' && (runCount[p.pos] ?? 0) >= 2) score /= s.runBonus;
    if (archetype === 'positionalNeed' && (left[p.pos] > 0 || (flexNeed > 0
        && ['RB', 'WR', 'TE'].includes(p.pos)))) score *= 0.75;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}

function assignArchetypes(teams, mySlot, rand, cfg) {
  const { adpNoisy, runFollower } = cfg.sim.archetypes;
  const out = [];
  for (let i = 0; i < teams; i++) {
    if (i === mySlot) { out.push('me'); continue; }
    const r = rand();
    out.push(r < adpNoisy ? 'adpNoisy' : r < adpNoisy + runFollower ? 'runFollower' : 'positionalNeed');
  }
  return out;
}

/**
 * Run one draft. `mySlot` is 0-based.
 * Opponent randomness depends only on (seed, slot) — NOT on the strategy — so
 * paired comparisons across strategies see identical opponent behaviour.
 */
export function simulateDraft({ players, strategy, strategyFn, mySlot, seed, cfg }) {
  const teams = cfg.league.teams;
  const rounds = cfg.roster.draftedRounds;
  const totalPicks = teams * rounds;

  const oppRand = rngFor('opp', seed, mySlot);
  const archRand = rngFor('arch', seed, mySlot);
  const archetypes = assignArchetypes(teams, mySlot, archRand, cfg);

  const available = players.map(p => ({ ...p }));
  const byId = new Map(available.map(p => [p.id, p]));
  const rosters = Array.from({ length: teams }, () => []);
  const recent = [];
  const log = [];

  for (let pickNo = 1; pickNo <= totalPicks; pickNo++) {
    const team = snakeTeam(pickNo, teams);
    const round = Math.floor((pickNo - 1) / teams) + 1;
    const pool = available.filter(p => !p._taken);

    let chosen = null, reason = null, candidates = null;
    if (team === mySlot) {
      const myNextPick = nextOwnPick(pickNo, mySlot, teams, totalPicks);
      const res = strategyFn({
        available: pool, roster: rosters[team], myRoster: rosters[team],
        pickNo, round, myNextPick, recent: [...recent],
      }, cfg);
      chosen = res.player ? byId.get(res.player.id) : null;
      reason = res.reason; candidates = res.candidates;
      // Fallback must still respect legality, or we log an illegal roster.
      if (!chosen) chosen = pool.find(p => isLegal(p, { roster: rosters[team], round, available: pool }, cfg))
        ?? pool[0];
    } else {
      chosen = botPick({ available: pool, roster: rosters[team], round, recent }, cfg, oppRand,
        archetypes[team]);
      if (!chosen) chosen = pool[0];
    }
    if (!chosen) break;

    chosen._taken = true;
    rosters[team].push(chosen);
    recent.push(chosen.pos);
    if (team === mySlot) {
      log.push({ pickNo, round, id: chosen.id, name: chosen.name, pos: chosen.pos,
        vorp: +(chosen.vorp ?? 0).toFixed(1), reason,
        alternatives: (candidates || []).slice(1, 4) });
    }
  }

  return { strategy, mySlot, seed, roster: rosters[mySlot], allRosters: rosters, log };
}

/** In a snake, my next pick after `pickNo`. */
export function nextOwnPick(pickNo, mySlot, teams, totalPicks) {
  for (let n = pickNo + 1; n <= totalPicks; n++) {
    if (snakeTeam(n, teams) === mySlot) return n;
  }
  return totalPicks + 1;
}
