// League-accurate scoring, driven entirely by config.json (half-PPR, fractional,
// negative points on by default — edit config.json for your own league). Pure — no I/O.
//
// Yahoo's own "Fan Pts" column IS league-scored, so it serves as a calibration
// target (see fitPaSd + rank.mjs --calibrate). We still recompute from component
// stats, because strategies need to reason about the components, and because a
// silent parse error is otherwise invisible.

const num = (v) => {
  if (v === undefined || v === null) return 0;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-' || s === '—') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

// Column keys as Yahoo renders them ("Group|Leaf"). Offense has four columns
// literally named "TD", so the group prefix is load-bearing.
export const COL = {
  gp: 'GP*',
  bye: 'Bye',
  fanPts: 'Fantasy|Fan Pts',
  passYds: 'Passing|Yds', passTd: 'Passing|TD', int: 'Passing|Int',
  rushAtt: 'Rushing|Att*', rushYds: 'Rushing|Yds', rushTd: 'Rushing|TD',
  tgt: 'Receiving|Tgt*', rec: 'Receiving|Rec', recYds: 'Receiving|Yds', recTd: 'Receiving|TD',
  retTd: 'Ret|TD', twoPt: 'Misc|2PT', fumLost: 'Fum|Lost',
  fg0_19: 'Field Goals Made|0-19', fg20_29: 'Field Goals Made|20-29',
  fg30_39: 'Field Goals Made|30-39', fg40_49: 'Field Goals Made|40-49',
   fg50: 'Field Goals Made|50+', fg60: 'Field Goals Made|60+', pat: 'PAT|Made',
  pa: 'Pts vs.*', sack: 'Tackles|Sack', safety: 'Tackles|Safe',
  defInt: 'Turnovers|Int', fumRec: 'Turnovers|Fum Rec',
  defTd: 'TD', blkKick: 'Misc|Blk Kick', defRetTd: 'Ret|TD',
};

const lgamma = (z) => {
  // Lanczos approximation; plenty accurate for pmf weights.
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};

export function paBucketPoints(pa, buckets) {
  for (const [lo, hi, pts] of buckets) if (pa >= lo && pa <= hi) return pts;
  return 0;
}

/**
 * Expected fantasy points from points-allowed over `games`.
 *
 * Points allowed is scored PER GAME against a step function, so you cannot look
 * up the bucket for a season mean — the function is convex at both ends
 * (shutout +10, 35+ only -4), so the mean systematically understates. Verified
 * empirically: every 2025 defense's mean PA/g lands in the same 14-20 bucket
 * (flat 17 pts), while Yahoo's actual values range 21-34. See
 * research/verification-log.md [V-DEF].
 *
 * Negative binomial, since per-game PA is overdispersed relative to Poisson.
 */
export function defPaPoints(paPerGame, games, sd, buckets) {
  const m = Math.max(paPerGame, 0.5);
  const varv = Math.max(sd * sd, m * 1.05); // must exceed the mean to stay NB
  const r = (m * m) / (varv - m);
  const p = r / (r + m);
  let exp = 0;
  for (let k = 0; k <= 70; k++) {
    const logPmf = lgamma(k + r) - lgamma(r) - lgamma(k + 1)
      + r * Math.log(p) + k * Math.log(1 - p);
    exp += Math.exp(logPmf) * paBucketPoints(k, buckets);
  }
  return exp * games;
}

/**
 * Score one player's stat line. Returns {total, components, missing}.
 * `components` is kept so the cheat sheet and calibration report can show
 * their work, and so a wrong parse is visible rather than buried in a total.
 */
export function pointsFor(cols, pos, scoring, { games } = {}) {
  const c = {};
  const s = scoring;

  if (pos === 'K') {
    const k = s.k;
    c.fg0_19 = num(cols[COL.fg0_19]) * k.fg0_19;
    c.fg20_29 = num(cols[COL.fg20_29]) * k.fg20_29;
    c.fg30_39 = num(cols[COL.fg30_39]) * k.fg30_39;
    c.fg40_49 = num(cols[COL.fg40_49]) * k.fg40_49;
    c.fg50 = num(cols[COL.fg50]) * k.fg50;
    c.fg60 = num(cols[COL.fg60]) * (k.fg60 ?? 0);
    c.pat = num(cols[COL.pat]) * k.pat;
  } else if (pos === 'DEF') {
    const d = s.def;
    const gp = games ?? num(cols[COL.gp]) ?? 17;
    const paTotal = num(cols[COL.pa]);
    c.sack = num(cols[COL.sack]) * d.sack;
    c.safety = num(cols[COL.safety]) * d.safety;
    c.int = num(cols[COL.defInt]) * d.int;
    c.fumRec = num(cols[COL.fumRec]) * d.fumRec;
    c.td = num(cols[COL.defTd]) * d.td;
    c.blkKick = num(cols[COL.blkKick]) * d.blkKick;
    c.retTd = num(cols[COL.defRetTd]) * d.retTd;
    c.ptsAllowed = gp > 0 ? defPaPoints(paTotal / gp, gp, d.paSd, d.paBuckets) : 0;
  } else {
    const o = s.off;
    c.passYds = num(cols[COL.passYds]) / o.passYdsPer;
    c.passTd = num(cols[COL.passTd]) * o.passTd;
    c.int = num(cols[COL.int]) * o.int;
    c.rushYds = num(cols[COL.rushYds]) / o.rushYdsPer;
    c.rushTd = num(cols[COL.rushTd]) * o.rushTd;
    c.rec = num(cols[COL.rec]) * o.rec;
    c.recYds = num(cols[COL.recYds]) / o.recYdsPer;
    c.recTd = num(cols[COL.recTd]) * o.recTd;
    c.retTd = num(cols[COL.retTd]) * o.retTd;
    c.twoPt = num(cols[COL.twoPt]) * o.twoPt;
    c.fumLost = num(cols[COL.fumLost]) * o.fumLost; // negative points are ON
  }

  // No flooring and no clamp at zero: fractional and negative are both enabled.
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return { total, components: c };
}

/**
 * Fit the negative-binomial dispersion for points-allowed by matching Yahoo's
 * own Fan Pts across all defenses. Beats guessing a league-average sd, and it
 * doubles as a check that the DEF column mapping is right.
 */
export function fitPaSd(defenses, scoring, { lo = 4, hi = 16, step = 0.05 } = {}) {
  let best = { sd: null, rmse: Infinity };
  for (let sd = lo; sd <= hi; sd += step) {
    let se = 0, n = 0;
    for (const d of defenses) {
      const actual = num(d.cols[COL.fanPts]);
      if (!actual) continue;
      const sc = { ...scoring, def: { ...scoring.def, paSd: sd } };
      const { total } = pointsFor(d.cols, 'DEF', sc, { games: num(d.cols[COL.gp]) });
      se += (total - actual) ** 2; n++;
    }
    if (n) {
      const rmse = Math.sqrt(se / n);
      if (rmse < best.rmse) best = { sd: +sd.toFixed(2), rmse: +rmse.toFixed(3), n };
    }
  }
  return best;
}

export { num };
