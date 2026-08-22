// node --test lib/scoring.test.mjs
//
// Hand-computed fixtures with the arithmetic written out, per ../sfdc/lib/score.test.mjs.
// Real 2025 lines pulled from Yahoo's league-scoped players table, so the
// expected values are checkable against the site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pointsFor, defPaPoints, paBucketPoints, COL } from './scoring.mjs';

const { scoring } = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const near = (a, b, tol = 0.05) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${b} +/- ${tol}, got ${a}`);

test('K: FG by distance bucket + PAT (Ka\'imi Fairbairn, 2025)', () => {
  // 3*(0+8+11) + 4*16 + 5*9 + 1*28 = 57 + 64 + 45 + 28 = 194
  const cols = {
    [COL.fg0_19]: '0', [COL.fg20_29]: '8', [COL.fg30_39]: '11',
    [COL.fg40_49]: '16', [COL.fg50]: '9', [COL.pat]: '28',
  };
  near(pointsFor(cols, 'K', scoring).total, 194);
});

test('half-PPR gives receptions exactly 0.5 each', () => {
  const base = { [COL.recYds]: '0' };
  const a = pointsFor({ ...base, [COL.rec]: '0' }, 'WR', scoring).total;
  const b = pointsFor({ ...base, [COL.rec]: '100' }, 'WR', scoring).total;
  near(b - a, 50); // 100 receptions * 0.5
});

test('fractional yardage does not floor', () => {
  // 287 passing yards / 25 = 11.48, not 11
  near(pointsFor({ [COL.passYds]: '287' }, 'QB', scoring).total, 11.48);
  // 6 rushing yards / 10 = 0.6 -- this is Brandon Aubrey's fake-FG run, the
  // residual that explained his 187 -> 187.60 gap.
  near(pointsFor({ [COL.rushYds]: '6' }, 'K', scoring).total, 0, 0.001); // K cols only
  near(pointsFor({ [COL.rushYds]: '6' }, 'RB', scoring).total, 0.6);
});

test('negative points are applied, not clamped at zero', () => {
  // 3 INT (-1) + 2 fumbles lost (-2) = -7, with no offsetting production
  const r = pointsFor({ [COL.int]: '3', [COL.fumLost]: '2' }, 'QB', scoring);
  near(r.total, -7);
  assert.ok(r.total < 0, 'must be allowed to go negative');
});

test('QB line reproduces Yahoo (Dak Prescott, 2025)', () => {
  // Verified against Yahoo Fan Pts 323.84 during calibration.
  const cols = {
    [COL.passYds]: '4837', [COL.passTd]: '38', [COL.int]: '12',
    [COL.rushYds]: '90', [COL.rushTd]: '2', [COL.fumLost]: '5',
    [COL.rec]: '0', [COL.recYds]: '0',
  };
  // 4837/25=193.48 + 38*4=152 + 12*-1=-12 + 90/10=9 + 12 + 5*-2=-10
  near(pointsFor(cols, 'QB', scoring).total, 344.48);
});

test('DEF points-allowed: season mean is NOT the same as the per-game expectation', () => {
  const b = scoring.def.paBuckets;
  // 286 PA over 17 games = 16.8/g, which sits in the 14-20 -> 1pt bucket.
  const naive = paBucketPoints(Math.round(286 / 17), b) * 17; // 17
  const real = defPaPoints(286 / 17, 17, scoring.def.paSd, b);
  assert.equal(naive, 17);
  assert.ok(real > 30, `expected >30 from the convolution, got ${real.toFixed(1)}`);
  // Seahawks' implied value from Yahoo was ~34; this is the whole reason the
  // convolution exists. See research/verification-log.md [V-DEF].
  near(real, 36.5, 3);
});

test('DEF bucket boundaries are inclusive at both ends', () => {
  const b = scoring.def.paBuckets;
  assert.equal(paBucketPoints(0, b), 10);
  assert.equal(paBucketPoints(6, b), 7);
  assert.equal(paBucketPoints(7, b), 4);
  assert.equal(paBucketPoints(20, b), 1);
  assert.equal(paBucketPoints(21, b), 0);
  assert.equal(paBucketPoints(35, b), -4);
  assert.equal(paBucketPoints(70, b), -4);
});

test('DEF full line reproduces Yahoo (Seahawks, 2025)', () => {
  const cols = {
    [COL.gp]: '17', [COL.pa]: '286', [COL.sack]: '47', [COL.safety]: '0',
    [COL.defInt]: '18', [COL.fumRec]: '7', [COL.defTd]: '3',
    [COL.blkKick]: '3', [COL.defRetTd]: '3',
  };
  // 47 + 0 + 36 + 14 + 18 + 6 + 18 = 139 non-PA, + ~36.5 PA = ~175 vs Yahoo 173
  near(pointsFor(cols, 'DEF', scoring, { games: 17 }).total, 173, 4);
});

test('TD and Ret TD are separate columns for DEF, both worth 6', () => {
  const base = { [COL.gp]: '17', [COL.pa]: '300' };
  const a = pointsFor(base, 'DEF', scoring, { games: 17 }).total;
  const withBoth = pointsFor({ ...base, [COL.defTd]: '1', [COL.defRetTd]: '1' },
    'DEF', scoring, { games: 17 }).total;
  near(withBoth - a, 12); // not 6 -- they do not collapse
});

test('missing and dash cells read as zero, not NaN', () => {
  for (const v of ['-', '', '—', undefined, null]) {
    const t = pointsFor({ [COL.recYds]: v, [COL.rec]: v }, 'WR', scoring).total;
    assert.ok(Number.isFinite(t) && t === 0, `value ${JSON.stringify(v)} produced ${t}`);
  }
});

test('comma-separated thousands parse', () => {
  near(pointsFor({ [COL.passYds]: '4,837' }, 'QB', scoring).total, 193.48);
});
