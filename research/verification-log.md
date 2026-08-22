# Verification Log

Findings that the harness is built on. Each entry: what was asked, what was found, when, and how it was proven.

---

## [V-JSON] Is there a JSON player payload? — **Partially. Better answer found.**
*2026-08-21*

- The league pages are the **old server-rendered YUI site**, not the React draft client. No `__PRELOADED_STATE__`, no embedded player JSON. Only globals are `YAHOO` and `YahooCJS`.
- `pub-api.fantasysports.yahoo.com/fantasy/v2/...` is **CORS-blocked** from the page (`TypeError: Failed to fetch`) even with `credentials:'include'`. The one pub-api call the page does make (`/v3/user/subscriptions`) has its own CORS allowance. Not a usable route without OAuth.
- **Better route found: `/f1/<leagueId>/players` is same-origin, fetchable with cookies, and server-renders a complete stat table.** This is the data source. It beats scraping the draft board — simpler DOM, stable markup, full column set, no virtualization, and it works *before* the draft room opens.

```js
await fetch('/f1/<leagueId>/players?status=ALL&pos=QB&stat1=S_PS_2026&count=0', {credentials:'include'})
```

**Query parameters (confirmed from the page's own `select[name=stat1]`):**

| Param | Values |
|---|---|
| `stat1` | `S_PS_2026` season projected · `S_S_2025` 2025 actuals · `S_S_2024` · `S_PSR_2026` remaining · `S_PW_<n>` week proj · `S_SPS_2026` splits |
| `pos` | `O` (all offense) · `QB` `WR` `RB` `TE` `K` `DEF` |
| `status` | `ALL` |
| `count` | page offset, 25 rows/page |

**Because the URL is league-scoped, the "Fan Pts" column appears to be scored with the league's own settings.** That makes it a calibration target, not a replacement for the engine — we still recompute from components, then assert agreement.

---

## [V-DATAID] Is `data-ys-playerid` the same key as the draft board's `data-id`? — **Yes.**
*2026-08-21*

Cross-checked against the draft board captured on 2026-08-20:
- `32671` → J. Burrow (board headshot URL `.../32671.1.png`)
- `32696` → Jordan Love (board `data-id="32696"`, headshot `.../32696.3.png`)
- `40059` → Jahmyr Gibbs

Team defenses use a separate block: `100034` Texans, `100014` Rams, `100007` Broncos, `100026` Seahawks.

**One global player key across the players page, the draft board, and headshot URLs.** Everything keys off it.

---

## [V-K] Does Yahoo expose FG by distance? — **Yes. No approximation needed.**
*2026-08-21*

The `pos=K` table has explicit made-FG columns per bucket: `0-19 | 20-29 | 30-39 | 40-49 | 50+`, plus `PAT Made`. The planned historical-distance-mix fallback (~3.66 pts/FG) is **not needed** — delete it from the design rather than carry dead config.

Brandon Aubrey 2025: GP 17, FG `0/10/5/10/11`, PAT 47, Fan Pts **187.60**.
Hand-check: `3(0+10+5) + 4(10) + 5(11) + 1(47)` = `45+40+55+47` = **187**. A 0.60 residual remains — carried into calibration as an open item, not hand-waved.

*Note: no miss penalty in this league, so FGA is a volume signal only, never scored.*

---

## [V-DEF] Are DEF `TD` and `Ret TD` double-counted, and can points-allowed use the season mean? — **Separate columns. And no — the mean is badly wrong.**
*2026-08-21*

Full DEF column order: `Roster Status | GP | Bye | Fan Pts | Pre-Season | Actual | %Ros | Pts vs. | Sack | Safe | Int | Fum Rec | TD | Blk Kick | Ret TD`

`TD` and `Ret TD` are **distinct columns** (Seahawks show TD 3 *and* Ret TD 3), and both score 6.

**The important finding.** Backing out implied points-allowed points from Yahoo's own Fan Pts, for 2025:

| DEF | PA | PA/g | Non-PA pts | Fan Pts | Implied PA pts | Mean-bucket would give |
|---|---|---|---|---|---|---|
| Texans | 295 | 17.4 | 135 | 164.00 | **29** | 17 |
| Rams | 334 | 19.6 | 115 | 136.00 | **21** | 17 |
| Broncos | 309 | 18.2 | 112 | 143.00 | **31** | 17 |
| Seahawks | 286 | 16.8 | 139 | 173.00 | **34** | 17 |

Every team's season mean PA/g lands in the same `14–20 → 1 pt` bucket, so the naive approach returns a flat 17 points for all four. Reality ranges **21 to 34**.

**Confirmed: points-allowed must be computed by convolving a per-game PA distribution against the bucket table.** The step function is convex at the ends — shutout-ish games pay far more (+7 to +10) than blowouts cost (−1 to −4) — so the mean systematically *understates*, here by 24–100%. This alone is worth several draft positions on a DEF.

---

## [V-DEFPROJ] Yahoo's *projected* `Pts vs.` column is unusable. — **Confirmed; DEF proj falls back to Fan Pts.**
*2026-08-21*

Found while calibrating. The projected points-allowed column reads ~176–191 over 17 games, i.e. **~11 PA/game** — no NFL defense allows that (2025 actuals: 286–334, or 17–20/g). The column is not a season total, and recomputing from it overstates DEF by up to **63 points**.

Backing implied PA points out of Yahoo's *own* projected Fan Pts gives 11–16 points across 17 games (~0.8/g), consistent with Yahoo applying something close to a flat mean-bucket to its own projections.

**Resolution:** for DEF **projections**, take Yahoo's Fan Pts directly (that column is league-scored — proven exactly for offense and K) and mark `ptsSource: 'yahoo-fanpts'` in `degradedFields`. The convolution is retained and still used for **2025 actuals**, where per-game data is real and it fits to RMSE 3.7. The calibration gate excludes DEF, since comparing Fan Pts to itself would be a vacuous pass.

Low cost: DEF has the second-flattest value curve in the league (best DEF is +20.5 VORP), so precision matters least exactly where the data is worst.

---

## Calibration gate — **PASSED.**
*2026-08-21*

Recomputed points vs Yahoo's league-scored Fan Pts, 443 players above 20 pts, recomputed positions only:

| Pos | n | \|delta\| > 5 | max \|delta\| |
|---|--:|--:|--:|
| QB | 64 | 0 | 0.51 |
| RB | 96 | 0 | 0.69 |
| WR | 158 | 0 | 0.60 |
| TE | 85 | 0 | 0.46 |
| K | 40 | 0 | 0.45 |

Mean delta 0.000, **0.0% over the 5-point threshold** (gate allows 5%). Residuals are Yahoo rounding its displayed components (receptions shown as e.g. 69.2). The engine reproduces league scoring essentially exactly.

---

## Parser bugs found and fixed
*2026-08-21*

- **Injury badge**: `.player-status` matches on *every* row (it's the video/notes container). The real badge is `.ysf-player-status`. Now flags 310 players.
- **Team/position**: `([A-Za-z]{2,3})\s*-\s*([A-Z,/]+)` shredded hyphenated surnames — "Jaxon Smith-Njigba" parsed to team `ith`. Fixed by requiring spaces around the dash *and* a real position token.
- **Header keys**: Yahoo salts headers with private-use-area glyphs (sort arrows), which leaked into column keys (`Fantasy|Fan Pts`). Stripped.

---

## [V-CONFIG] Mock venue — **Resolved. No private league needed.**
*2026-08-21*

The plan asked for the wrong thing: Yahoo does not support adding bot managers to a private league. It already ships two mock venues, both scoped to the league:

| Venue | Opponents | Config | Cost |
|---|---|---|---|
| **Instant Mock Drafts** | Yahoo's algorithms | "<Your League> · 12 Teams · 15 Rounds · 1 minute", **slot selectable 1–12** | **Fantasy Plus**; free tier = 3 rounds |
| **Live Mock Drafts** (`?lobby=standard`) | real people | `quick_start_teams` = `any\|8\|10\|12\|14` | free, unlimited |

Chosen approach: simulator first, then public live mocks, recalibrate, repeat — and explicitly opted into the public lobby. Etiquette commitment: participate properly, human pace, never abandon a room mid-draft.

Scoring in the mock matches our league (Gibbs 297.75 in both), so mock rosters are directly comparable.

## [V-ORDER] Is our draft slot assigned? — **Open.**

A league note referenced a draft-order notification. If the order is randomized shortly before start, the playbook must carry all 12 slots. Assume it does until proven otherwise.

---

## Live mock run #1 — room 9367264, slot 9 of 12 (2026-08-21)

First real-venue test. Roster reached 5/15 under manual driving before the queue
took over. Findings, in order of importance:

### 1. Idle detection put us in autopick BEFORE the first pick — the run's biggest lesson

Yahoo flagged "autopick mode due to inactivity" before pick 9, because
`evaluate_script` produces **untrusted** events that never reset the idle timer.
Consequences cascaded exactly as the plan's failure ladder predicted:

- the Draft column never rendered, so the click path found zero buttons
- that looked identical to a broken selector, so time went into diagnosis
- the clock expired, and **Yahoo autodrafted from an empty queue**

It picked A. St. Brown — who happened to be our #2 candidate. That was luck, not
design. **The queue invariant was not yet established, so the safety net was absent
at the one moment it was needed.** This is the single strongest argument for the
queue-first design.

Recovery needed **real CDP clicks** (MCP `click`), not JS: close the Settings
modal, then dismiss the autopick dialog. Then live drafting resumed.

**Action for the real draft:** the manager is clicking on draft night, so genuine input exists
and idle detection is a non-issue there. For unattended mocks, emit a periodic
trusted interaction and treat `/put into autopick/i` as a hard alarm.

### 2. Trusted-vs-synthetic event boundary (see dom-contract.md)

Drafting and starring work via JS `.click()`. Modal dismissal and the autopick
toggle require real CDP input. Non-obvious and worth pinning.

### 3. The one-round-trip fallback list paid off immediately

At pick 57 the model said David Montgomery. He was taken between computing and
clicking. Because all fallbacks shipped in the same call, it dropped to Bucky
Irving with no second round-trip and no lost time. Ship the whole ordered list,
always.

### 4. Real ADP captured and merged

The draft board exposes a true `ADP` column. Merged real ADP for **146 players**
into `data/rankings-*.json` (`adpSource: yahoo-live-board`), replacing the
preseason-rank proxy where it matters most. This was the bakeoff's biggest caveat.

### 5. Process error of mine: I violated the planner/actor split

I computed recommendations *during* my turn instead of between turns, which is why
I kept arriving on the clock with an empty queue. The design says all valuation
happens off-clock. Once I actually queued 8 deep off-clock, the problem vanished.

### 6. Mock scoring matches our league

Gibbs projected 297.75 in the mock, identical to the league-scoped value for
our league — so mock rosters are directly comparable without re-scoring.

---

## Live mocks #2-#5 — harness bring-up (2026-08-21)

Eight distinct bugs, found and fixed by running against real rooms. `want==got`
(harness drafted its actual top choice) went **0/15 -> 8/15 -> 4/4**.

| # | Bug | Fix |
|---|---|---|
| 1 | Idle detection put us in autopick before pick 1; `evaluate_script` fires **untrusted** events that never reset the timer | periodic `press_key Shift` keepalive |
| 2 | `clearAutopick` reused one snapshot path; `existsSync` passed on the **stale** file and it clicked a uid that no longer existed — failing silently and looping forever | `press_key Escape` first (trusted, no uid), then fresh snapshot with unlink, and **verify the banner actually cleared** |
| 3 | Queue additions **append to the bottom**, so a stale entry fired ahead of the intended pick | clear-and-rebuild in priority order |
| 4 | `myNextPick` assumed "+teams" when on the clock (header says "YOUR TURN", so `picksUntilMine` is null). At a turn the picks are back-to-back, so VONA thought it had a full round to wait | real snake math from the slot in the draftclient URL |
| 5 | Roster resolved by surname: "Kenneth Walker III" parsed to surname **"III"**, Bijan Robinson matched Wan'Dale Robinson — 19 players for a 15-man roster, and a **bogus 1885.9 startPts** | exact `data-id` |
| 6 | Then: "outside the board table" also caught the **QUEUE panel**, inflating roster by queue depth -> `picksLeft` 0 -> constraint layer rejected every legal pick (6 of 15 picks) | anchor on the "YOUR TEAM (n/15)" panel + a `ROSTER-MISMATCH` alarm cross-checking Yahoo's own counter |
| 7 | **`want != got` root cause.** Draft targeting used `.closest('tr')`, but queue-panel entries are not table rows and the board is virtualised to ~100 rows — a player can leave the table while still being draftable from the queue. Reported as `no-row` and skipped. Tell: id `34008` skipped at picks 72 **and** 96, 24 apart — a drafted player would not keep reappearing | walk up to the nearest ancestor carrying a Draft control, checking every matching element (board **and** queue) |
| 8 | Launcher `until` loop matched a **stale** draftclient tab from the previous mock, fired instantly, and mock #4 was autodrafted end-to-end | wait on `draftclient/f1/<mlid>/` for the specific room + attach retries |

### Scores

| Run | startPts | vs sim 1854.9 | Note |
|---|--:|--:|---|
| #1 manual | 1792.7 | -62 | 2 autopick lockouts, 1 pick lost to clock |
| #2 harness | 1687.7 | -167 | bugs 4-6 active; 0/15 want==got |
| #3 harness | 1794.0 | -61 | 8/15 want==got; bug 6 diagnosed |
| #5c harness | **1842.0** | **-13** | **4/4 want==got**, sanity clean, QB2/WR5/RB4/TE2/K/DEF |

Latency was never the problem: decision->click held **1016-1146 ms** across every
run, with 27-30s left on a 60s clock.

**Still owed: one clean run from pick 1.** #5c only took the last four picks — the
earlier ones were Yahoo autodrafts while bug 2 looped — so 1842.0 is encouraging
but is NOT a clean test of the strategy.

---

## Live mock #6 — room 9377055, slot 11 (2026-08-21), fully unattended

The manager was away from the computer; Claude joined the public lobby, drove
`mock.mjs --strategy vona-starter` and `harvest.mjs` concurrently against the
same draftclient tab, and ran the whole 15-round draft to completion
unattended (one autopick-inactivity alarm early on, cleared manually; one
"no-row" virtualized-board skip at pick 67, recovered automatically by Yahoo's
queue safety net — no missed picks, 0 sanity failures, roster QB2/WR3/RB6/TE2/
K1/DEF1, startPts 1681.0).

### Bug: harvested room was 14 teams, mislabeled as 12

The public "standard" mock lobby (joined via `config.json`'s `mockLobbyUrl`,
which has "/12/" in its path) does not reliably seat 12 teams — this room
actually had 14. `harvest.mjs` stamped `cfg.league.teams` (our own league's 12)
onto the output regardless of the room's real size, and `calibrate.mjs` used
that same constant to bucket every harvested room's picks into rounds by
`pickNo / teams`. Feeding a 14-team room's picks through a 12-team round
bucketing would have corrupted the round-vs-sigma fit silently — caught only
because the harvested pick numbers ran to 210 (impossible at 12×15=180) and the
post-draft summary text directly confirmed the room size:

> "Round 2, Pick 4 (18th Overall)" ⇒ teams = (18-4)/(2-1) = 14

**Fix:** `harvest.mjs` now scrapes that same "Round X, Pick Y (Z Overall)" line
from the post-draft summary at completion and computes `teams = (Z-Y)/(X-1)`
for the first line with X>1, storing the DETECTED count rather than assuming
the league's. `calibrate.mjs` now buckets each room's picks by that room's own
recorded `teams`, not a single global constant. `room9377055.json` was
retroactively corrected from `teams: 12` to `teams: 14`.

**Lesson for future harvests:** never trust a lobby URL's implied size — verify
the actual room size (waiting room, or post-draft summary) before assuming a
harvest is comparable to the target 12-team league.

### Result: 2-room calibration confirms `vona-starter`

Combined fit (367 picks, 2 rooms): `sigmaBase` 0.5→1.2, `sigmaPerRound`
1.952→1.526, `runBonus` 2.3→1.87. Round-1 sd matched exactly between the two
independently-fit rooms (2.8 both times). Re-simulated (1800 paired drafts):
`vona-starter` +28.6 vs control (t=6.16), still 0 sanity failures — nearly
identical to the 1-room result (+27.4, t=6.06). See STATUS.md for the full
table.

---

## Live mock #7 — room 9383742, slot 12 (2026-08-21), fully unattended

Third harvested room, same unattended procedure as #6. Also landed in a
**14-team** room — confirmed both by pick-number spacing and the waiting room's
own "You will draft 12th [of 14]" notice, independent of the harvest file.

The post-draft summary-text team-count detection added after room #6 (parsing
"Round X, Pick Y (Z Overall)") **didn't fire this time**: the post-draft page
landed on the "Players Board" tab rather than "Your Team", where that text never
appears. Added a second, independent fallback to `harvest.mjs`: standard Yahoo
mocks are always 15 rounds, so `teams = round(maxPickNo / 15)` is a robust
estimate when the summary text is unavailable. `room9383742.json` corrected to
`teams: 14` via this path. Also: harvest only started at pick 26 (draft was
already underway when the harness attached), so this room contributes no
round-1 and partial round-2 data to the fit — expected, not an error.

**3-room fit** (548 picks): `sigmaBase` 1.2→2.34, `sigmaPerRound` 1.526→1.573
(small move — convergence signal), `runBonus` 1.87→1.65. Re-simulated ranking
shows the clearest separation yet: `vona-starter` +29.2 vs control (t=6.14), 0
sanity failures, while `vorp-custom`'s sanity failures got *worse* (4→11). See
STATUS.md for the full table and the freeze recommendation.

Operationally the cleanest of the three mocks: one autopick alarm at the very
last pick (cleared by `mock.mjs`'s own recovery, no manual intervention), zero
no-row skips, zero roster mismatches. Drafted roster startPts 1743.7, riskAdj
1558.3, 0 sanity failures.
