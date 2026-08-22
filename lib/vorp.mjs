// Replacement level, VORP, and VONA for a 12-team league with one W/R/T flex.
// Pure.

/**
 * Positional demand, with the flex allocated endogenously.
 *
 * Do not hardcode the flex split. Award each of the league's flex slots to
 * whichever of RB/WR/TE currently has the best *marginal* (next-unclaimed)
 * player. Self-documenting, and it adapts to the actual player pool instead of
 * baking in a half-PPR assumption we haven't tested.
 */
export function computeDemand(players, cfg) {
  const teams = cfg.league.teams;
  const starters = cfg.roster.starters;
  const flexSlots = starters.filter(s => s === 'W/R/T').length * teams;

  const demand = {};
  for (const s of starters) {
    if (s === 'W/R/T') continue;
    demand[s] = (demand[s] || 0) + teams;
  }
  for (const p of Object.keys(cfg.durability.positionalPrior)) demand[p] ??= 0;

  const sorted = {};
  for (const pos of cfg.roster.flexEligible) {
    sorted[pos] = players.filter(p => p.pos === pos).sort((a, b) => b.custPts - a.custPts);
  }

  const trace = [];
  for (let i = 0; i < flexSlots; i++) {
    let best = null;
    for (const pos of cfg.roster.flexEligible) {
      const next = sorted[pos][demand[pos]];
      if (next && (!best || next.custPts > best.pts)) best = { pos, pts: next.custPts };
    }
    if (!best) break;
    demand[best.pos]++;
    trace.push(best.pos);
  }

  const flexSplit = {};
  for (const p of trace) flexSplit[p] = (flexSplit[p] || 0) + 1;
  return { demand, flexSplit };
}

/**
 * Replacement points per position: the mean of the next `smoothing` players
 * past the demand line. Averaging matters — pinning to a single boundary player
 * makes every VORP at that position hostage to one projection.
 */
export function replacementLevels(players, demand, cfg) {
  const k = cfg.vorp.replacementSmoothing;
  const out = {};
  for (const pos of Object.keys(demand)) {
    const pool = players.filter(p => p.pos === pos).sort((a, b) => b.custPts - a.custPts);
    const slice = pool.slice(demand[pos], demand[pos] + k).map(p => p.custPts);
    out[pos] = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
  }
  return out;
}

const CDF = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

/** Probability a player is still on the board at `pick`. */
export function pAvailable(adp, pick, cfg) {
  if (!adp || adp <= 0) return 1;
  const sd = Math.max(cfg.vorp.adpSdFactor * Math.sqrt(adp), 3);
  return 1 - CDF((pick - adp) / sd);
}

/**
 * VONA — value over next available. Answers the question that actually decides
 * drafts: reach now, or wait? Static VORP says who is best; VONA says what the
 * position will cost you by your next turn.
 *
 * expectedBestSurvivor = sum over that position's available players (best-first)
 * of VORP_j * P(j survives) * P(everyone better than j is gone).
 */
export function expectedBestSurvivor(available, pos, myNextPick, cfg) {
  const pool = available.filter(p => p.pos === pos).sort((a, b) => b.vorp - a.vorp);
  let carry = 1, exp = 0;
  for (const p of pool.slice(0, 40)) {
    const survive = pAvailable(p.adp, myNextPick, cfg);
    exp += p.vorp * survive * carry;
    carry *= (1 - survive);
    if (carry < 1e-4) break;
  }
  return exp;
}

export function annotate(players, cfg) {
  const { demand, flexSplit } = computeDemand(players, cfg);
  const replacement = replacementLevels(players, demand, cfg);
  for (const p of players) {
    p.vorp = p.custPts - (replacement[p.pos] ?? 0);
    p.vorpDur = p.custPtsRiskAdj - (replacement[p.pos] ?? 0);
  }
  return { demand, flexSplit, replacement };
}
