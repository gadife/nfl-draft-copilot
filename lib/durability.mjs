// Expected games available (out of 17) — not an abstract risk score.
// Interpretable, testable, and it multiplies cleanly into per-game points.
// Pure.

const SEASON_GAMES = 17;

// Chronic = likely to miss 4+ consecutive weeks, so IR-eligible: you keep the
// asset and free the roster spot. Weekly = game-time decisions, which are NOT
// IR-eligible and burn a starting slot every week. The 2 IR slots only help the
// first kind, which is why the two are tracked separately.
const CHRONIC = new Set(['PUP', 'IR', 'NA', 'SUS', 'O']);

export function expectedGames(player, cfg, { age = null } = {}) {
  const d = cfg.durability;
  const pos = player.pos;
  const notes = [];

  const prior = d.positionalPrior[pos] ?? 15;
  const gp2025 = player.prior ? num(player.prior['GP*']) : null;

  // One season is noisy, so shrink hard toward the positional prior.
  let e = gp2025 != null && gp2025 > 0
    ? d.priorWeight * prior + (1 - d.priorWeight) * gp2025
    : (notes.push('no-2025-gp'), prior);

  const decay = d.ageDecay[pos];
  if (age != null && decay && age > decay.startAge) {
    e -= (age - decay.startAge) * decay.perYear;
  } else if (decay) {
    notes.push('no-age');
  }

  const status = (player.status || '').toUpperCase().replace(/[^A-Z]/g, '');
  const penalty = d.statusPenalty[status];
  if (penalty) e -= penalty;

  const [lo, hi] = d.clamp;
  const expGames = Math.max(lo, Math.min(hi, e));

  const missed = SEASON_GAMES - expGames;
  const chronic = CHRONIC.has(status);

  return {
    expGames,
    availability: expGames / SEASON_GAMES,
    missed,
    chronicMissed: chronic ? missed : 0,
    weeklyMissed: chronic ? 0 : missed,
    status: status || null,
    chronic,
    notes,
  };
}

/**
 * Risk-adjusted points, as a discount rather than a filter.
 *
 * Work per-game so we don't double-count the games assumption already baked
 * into the projection. The discount is capped (config maxDiscount) so an elite
 * but risky player gets priced, never eliminated.
 */
export function riskAdjust(projPoints, projGames, dur, cfg) {
  const g = projGames > 0 ? projGames : 17;
  const perGame = projPoints / g;
  const raw = perGame * dur.expGames;
  const floor = projPoints * (1 - cfg.durability.maxDiscount);
  // Only ever a discount: never let the model inflate a player above projection.
  return Math.max(Math.min(raw, projPoints), Math.min(floor, projPoints));
}

/**
 * Roster-level IR credit. Only 2 IR slots exist, so the credit for stashing
 * chronic-risk players diminishes sharply after the first two. Belongs here
 * rather than in the per-player rating, because it depends on who else you own.
 */
export function rosterInjuryExposure(durs, cfg) {
  const { firstTwo, thereafter } = cfg.durability.irCredit;
  const chronic = durs.filter(d => d.chronic).sort((a, b) => b.chronicMissed - a.chronicMissed);
  let loss = durs.reduce((a, d) => a + d.weeklyMissed, 0);
  chronic.forEach((d, i) => {
    loss += d.chronicMissed * (1 - (i < 2 ? firstTwo : thereafter));
  });
  return loss;
}

function num(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
