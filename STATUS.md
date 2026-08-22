# STATUS — read this first

Last updated: 2026-08-21 (evening). Draft is **Wed Sep 2 2026, 8:00pm EDT** — check
the countdown before planning; this file may be stale.

## Where things stand

**Built and validated**
- Data pipeline: `scrape-board.mjs` → 1,192 players from Yahoo's league-scoped
  `/f1/<leagueId>/players` pages (same-origin fetch, both projected and 2025 actual).
- Scoring engine: **exact**. 0 of 443 players off by >5 pts vs Yahoo's own
  league-scored numbers. 11 unit tests pass (`node --test lib/scoring.test.mjs`).
- VORP/VONA, durability, tiers, evaluation harness, 10 strategies.
- Simulator: 1,800 paired drafts in ~3 min (10 strategies × 12 slots × 15 seeds).
- Real ADP merged for 146 players from the live draft board.
- Live-mock harness (`mock.mjs`) — 8 bugs found and fixed, see verification-log.

**Current leading strategy: `vona-starter`** — +27.4 vs the ADP-baseline control
(t=6.06) with **0 sanity failures**, under the *calibrated* opponent model. Not
yet frozen; confirm with 2–3 more harvested rooms. See the calibration section.

## Opponent model — CALIBRATED FROM 3 ROOMS, RECOMMEND FREEZE (2026-08-21)

Room 3: `data/harvest/room9383742.json`, our slot 12, also landed in a **14-team**
room (confirmed both by pick-number spacing and the waiting room's own "You will
draft 12th [of 14]" notice). The post-draft-summary regex detection from room 2's
fix didn't fire this time — the harness landed on the "Players Board" tab
post-draft instead of "Your Team", so the "Round X, Pick Y (Z Overall)" text
never appeared. Added a second, independent fallback in `harvest.mjs`:
`teams = round(maxPickNo / 15)` (standard mocks are always 15 rounds), used only
when the summary-text detection fails. Room 3's file was corrected to `teams: 14`.
Note: harvest only started at pick 26 here (draft was already underway when the
harness attached), so this room contributes no round-1 and partial round-2 data.

**3-room fit (548 picks total):** `sigmaBase` 1.2→2.34, `sigmaPerRound`
1.526→1.573 (barely moved between rooms 2 and 3 — good convergence signal),
`runBonus` 1.87→1.65.

**Re-simulated ranking (1800 paired drafts) — clearest separation of the three runs:**

| Strategy | paired vs control | t | startPts | sanity fails |
|---|--:|--:|--:|--:|
| `vona-starter` | **+29.2** | 6.14 | 1863.5 | **0** |
| `vorp-starter` | +23.6 | 4.91 | 1857.9 | **0** |
| `vorp-dur-starter` | +22.0 | 4.46 | 1856.2 | **0** |
| `vorp-custom` | +15.1 | 3.20 | 1849.4 | 11 |
| `tier-based` | +13.0 | 2.68 | 1847.3 | 8 |
| `vona-scarcity` | +3.6 | 0.78 | 1837.9 | 7 |
| `vorp-durability` | +1.3 | 0.27 | 1835.6 | 5 |
| `hero-rb` | -16.1 | -3.32 | 1818.2 | 7 |
| `zero-rb` | -44.7 | -8.51 | 1789.6 | 19 |

`vona-starter` is no longer just statistically tied with `vorp-custom` — it now
clearly leads on paired advantage AND is the only top-tier strategy with 0
sanity failures across **all 3 independently-harvested rooms**. `vorp-custom`'s
sanity failures got *worse* this round (4→11), moving the wrong direction for a
"maybe it's noise" read.

Room 3's drafted roster: startPts 1743.7, riskAdj 1558.3, 0 sanity failures,
QB2/WR3/RB6/TE2/K1/DEF1 — cleanest operational run of the three (one autopick
alarm at the very last pick, cleared automatically by `mock.mjs`'s own recovery;
zero no-row skips, zero roster mismatches).

**Recommendation: freeze `vona-starter`.** 3 independent rooms (1 confirmed
12-team, 2 confirmed-and-corrected 14-team) all agree, and `sigmaPerRound` has
stabilized between the last two fits. Remaining honest caveat: only 1 of 3 rooms
was the actual target size (12 teams) — the round-bucketing fix makes this a
correctness non-issue, but it's still an open question whether 14-team opponent
behavior fully generalizes to a 12-team room. Not blocking a freeze given the
convergence signal, but worth one more *verified-12-team* room opportunistically
if one comes up before Sep 2.

## Opponent model — CALIBRATED FROM 2 ROOMS (2026-08-21) [superseded by 3-room fit above]

Room 1: `data/harvest/room9375193.json`, 180-pick real 12-team draft, 179 usable.
Room 2: `data/harvest/room9377055.json`, harvested live with Claude driving
`mock.mjs --strategy vona-starter` unattended while the manager was away — **but this
public "standard" mock lobby actually seated 14 teams, not 12** (confirmed from
the post-draft summary: "Round 2, Pick 4 (18th Overall)" ⇒ (18-4)/(2-1)=14, and
the harvest's own pick numbers ran to 210 = 14×15, impossible at 12 teams).

**Bug caught before it touched config.json:** `harvest.mjs` blindly stamped
`cfg.league.teams` (our own league's 12) onto every harvest file instead of
detecting the room's actual size, and `calibrate.mjs` used that same global
constant to bucket ALL rooms' picks into rounds. Fitting round-vs-sigma on a
14-team room's picks divided by 12 would have silently corrupted the model.
**Fixed both**: `harvest.mjs` now derives team count from the post-draft "Round
X, Pick Y (Z Overall)" summary text and stamps it per-room; `calibrate.mjs`
buckets each room's picks by *that room's own* team count. Room 2's file was
retroactively corrected (`teams: 14`, noted in the JSON).

| param | round-1 guess | 1-room fit | **2-room fit** |
|---|--:|--:|--:|
| `sigmaBase` | 2 | 0.5 | **1.2** |
| `sigmaPerRound` | 0.6 | 1.952 | **1.526** |
| `runBonus` | 1.6 | 2.3 | **1.87** |

Round-1 sd (2.8) matched exactly between the two independently-fit rounds —
reassuring — but sd still climbs steeply late (25 by round 15), and round 15's
mean residual (-17.4) looks like a real late-round-autopicker effect, not noise.

**Effect on strategy ranking (1800 paired drafts, 2-room-calibrated):**

| Strategy | paired vs control | t | startPts | sanity fails |
|---|--:|--:|--:|--:|
| `vona-starter` | **+28.6** | 6.16 | 1858.1 | **0** |
| `vorp-custom` | +26.1 | 6.21 | 1855.5 | 4 |
| `vorp-starter` | +24.9 | 5.42 | 1854.3 | **0** |
| `vorp-dur-starter` | +18.5 | 4.05 | 1847.9 | **0** |
| `tier-based` | +18.4 | 3.77 | 1847.8 | 4 |
| `vona-scarcity` | +16.0 | 3.43 | 1845.5 | 3 |
| `vorp-durability` | +9.9 | 2.13 | 1839.3 | 2 |
| `hero-rb` | -9.9 | -2.04 | 1819.5 | 10 |
| `zero-rb` | -31.2 | -6.19 | 1798.2 | 11 |

**`vona-starter`'s edge held almost exactly (+27.4 → +28.6) across two
independently-harvested rooms of different sizes, still with 0 sanity
failures** — the strongest confirmation yet that it isn't a one-room artifact.
`vorp-custom` closed slightly (+29.1 → +26.1) and its sanity failures dropped
(17 → 4) but didn't reach 0. On the "startPts + sanity" rule, **`vona-starter`
is still the pick.**

Our own drafted roster from room 2 (`mocks/2026-08-21-r9377055-vona-starter/`):
startPts 1681.0, riskAdj 1462.8, 0 sanity failures, QB2/WR3/RB6/TE2/K1/DEF1.
**Not comparable to the sim's ~1858 prediction** — that's a 12-team lineup
construction, this roster was drafted in a 14-team room where the talent pool
is split among more teams. Treat this as a clean operational run (harness
picked correctly all game, one "no-row" virtualized-board hiccup recovered by
Yahoo's queue safety net), not a startPts validation point.

**Caveat: still only 2 rooms, and one was off-target size.** Public "standard"
lobby joins don't reliably land in 12-team rooms — verify team count in the
waiting room (or from the URL/config after joining) before committing next
time, so a genuine 12-team confirmation room isn't accidentally skipped.

## Next actions, in order

1. **Freeze `vona-starter`** — confirmed stable across 3 independently-harvested
   rooms (1 twelve-team, 2 fourteen-team) with 0 sanity failures in all 3 and a
   converging `sigmaPerRound` fit. See the calibration section above.
2. **Build the draft-day playbook**: tiered cheat sheet keyed by `data-id`,
   round-by-round rules, contingencies, **all 12 slots** (Yahoo randomizes draft
   order shortly before start).
3. **Mandatory data refresh** after NFL final cuts (~Aug 26), plus T−4h on draft
   day. Re-run `scrape-board.mjs` then `rank.mjs --calibrate`.
4. Opportunistic: one more harvested room, ideally verified 12-team, if a mock
   comes up before Sep 2 — not blocking the freeze above.

## Architecture decision (important — don't relitigate)

**Simulator selects the strategy. Live mocks calibrate the opponent model.**

Live mocks cannot do strategy selection: ~1 draft per 40 min, one slot,
uncontrolled opponents. Comparing 10 strategies needs paired runs across 12
slots. Earlier sessions burned a lot of effort hardening the *picking* harness
against fast autopick-heavy public rooms — an artifact of the test venue that
does **not** apply to the real draft (12 engaged managers, 60s clock), and which
matters less anyway because **the manager clicks on draft night; Claude advises.**

The draft-night deliverable is `advise.mjs` + the playbook, not autonomous
drafting. `advise.mjs` has worked correctly on every invocation.

## Honest caveats

- **The sim is not validated against a clean live run.** No full 15-pick
  uninterrupted harness run was ever achieved. Best partial results: 1842.0
  (4/4 correct picks) and 1802.6, vs the sim's 1854.9 prediction. Encouraging,
  not proof.
- **Durability model is thin** — a shrunk positional prior plus an injury badge,
  no age data. This is why the *composite* ranks `vorp-durability` first while it
  is the weakest significant strategy on raw points (+8.5, t=1.6). Select on
  startPts + sanity until age inputs exist.
- **ADP is real for 146 players**, preseason-rank proxy for the rest.
- **Playoff strength-of-schedule is not modelled.** NFL byes end week 14 so byes
  cannot collide with weeks 16–17; real playoff optimisation needs external SOS
  data. Gated, weight 0, disclosed — not faked.
- **[V-ORDER] RESOLVED (2026-08-21)**: per the league notes at
  `/f1/<leagueId>/league_notes` — *"The draft order will be **randomly determined
  approximately 30 minutes before the draft begins**"*, and *"Draft room will open
  30 min before your draft time."* So the slot is revealed when the room opens,
  giving a genuine 30-minute orientation window — not a 5-minute scramble.
  **Consequence: the playbook must carry all 12 slot plans**, with a "confirm
  slot at T-30, select its plan" step. Do not build anything slot-agnostic.

## Hard-won gotchas (full detail in research/)

- Player identity is **`data-id` only**, never display text.
- **Never `take_snapshot`** on the draft page inline (~118k chars). Use
  `--filePath` inside the workspace (`/tmp` is rejected) and grep it.
- **`Escape` clears the autopick banner.** JS `.click()` cannot — Yahoo needs
  *trusted* CDP input for modals and the autopick toggle (drafting and starring
  do work via JS).
- Yahoo puts you in autopick for inactivity; `evaluate_script` doesn't reset the
  idle timer. Keepalive = periodic `press_key Shift`.
- The board is **virtualised (~100 rows)** and the **queue panel renders players
  outside any table** — never target picks via `.closest('tr')`.
- The roster panel must be found as the smallest container mentioning
  "YOUR TEAM (" that does **not** contain the board table. Getting this wrong
  once reported 100 rostered players and locked out every pick.
- Column positions shift under position filters — always map columns by header
  text, never fixed index.
