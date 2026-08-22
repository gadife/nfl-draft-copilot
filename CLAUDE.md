# NFL Draft Training

> **Read `STATUS.md` first** — current state, next actions, and hard-won gotchas.

Train for a Yahoo fantasy football draft: **league and date configured in `config.json`.**

Optimize for **true team strength** — projected starting-lineup points under *this league's* scoring, plus depth and bye structure. Yahoo's letter grade is a 4%-weight telltale, not the target; it largely measures "did you follow Yahoo's rankings" and is roughly anti-correlated with the goal. A prior draft in a different league graded B+, which is the thing we're trying to beat on substance rather than on grade.

**`config.json` is the source of truth.** If this document and config disagree, config wins.

## The league

12 teams · snake · half-PPR (0.5/reception) · fractional and negative points both ON · 1-minute pick clock.
Roster: QB, WR, WR, RB, RB, TE, W/R/T, K, DEF + 6 BN + **2 IR** → 15 drafted rounds.
Playoffs weeks 16–17. **NFL byes end after week 14, so byes cannot collide with the playoffs** — do not conflate the two.

A separate practice draft on 2026-08-20 was a *10-team standard-scoring* league. Its rankings do not transfer.

## Operating laws

These are hard rules. The first three each come from a specific failure on 2026-08-20.

1. **Player identity is `data-id` only.** `<div class="ys-player" data-id="32696">`. Never match on display text. A pick that cannot resolve to a `data-id` is not a pick. *(Matching "J. Love" by name queued Jordan Love the QB instead of the intended RB, and Yahoo autodrafted him.)*
2. **Never call `take_snapshot` in a draft room.** It returned 118k chars / 2920 lines and overflowed context. All page reads go through targeted `evaluate_script` returning compact JSON.
3. **The queue invariant.** Yahoo autodrafts from the queue when the clock expires, so `queue[0]` must always equal the strategy's current #1 pick, reconciled off the clock after every opponent pick. This turns the queue from the thing that broke us into the safety net: a missed click becomes harmless. *(A pick was lost to the clock on 2026-08-20.)*
4. **On-clock budget: one round-trip.** No screenshots, no LLM reasoning, no multi-step planning while on the clock. The decision was made before the clock started.
5. **Determinism.** Seeded RNG (`lib/rng.mjs`), no `Math.random`, no wall-clock in any pick policy. Ties break on (VORP desc, ADP asc, dataId asc). Every run must replay from its log.
6. **Never fake missing data.** If a field is unavailable, record it in `degradedFields` and say so in the report. Notably: playoff strength-of-schedule needs external data — gate it behind `--with-sos` and set its weight to 0 when absent rather than substituting bye-week data for it.

## Workflow

| Command | Writes |
|---|---|
| `node scrape-board.mjs` | `data/players-<date>.json` |
| `node rank.mjs` | `data/rankings-<date>.json`, `reports/<date>-cheatsheet.{md,html}` |
| `node rank.mjs --calibrate` | `research/scoring-calibration.md` |
| `node simulate.mjs --seeds 15` | `sims/<date>-bakeoff.json`, `reports/<date>-bakeoff.md` |
| `node harvest.mjs` | `data/harvest/<run>.json` — real draft order, observation only |
| `node calibrate.mjs --write` | fits the sim's opponent model into `config.json` |
| `node mock.mjs --strategy <s>` | `mocks/<run>/report.md` |
| `node advise.mjs --avail … --roster … --pick N --next M` | **the draft-night deliverable** — prints top candidates + wait-cost |

`playbook.mjs` is **not built yet** (see STATUS.md next actions). There is no
separate `bakeoff.mjs` — `simulate.mjs` writes the bakeoff report.

All CLIs support `--dry-run` and `--from-cache` (re-render from the last snapshot with zero browser calls), following `../sfdc/pipeline-inspect.mjs`.

Everything under `data/ mocks/ sims/ reports/` is regenerable. `research/` holds durable findings: `dom-contract.md`, `verification-log.md`, `scoring-calibration.md`.

## Unattended-run contract

May run alone: join a **public 12-team mock** (opted into by the league
manager, reversing an earlier preference), harvest or draft, run sims,
regenerate rankings and reports.

Etiquette: human pace, participate properly, **never abandon a room
mid-draft**. Note Yahoo does **not** support bot managers in private leagues, so
a "private bot league" is not available.

Must ask the manager first: anything touching the **real** league, creating or
deleting leagues, or anything costing money (Instant Mock Drafts need Fantasy
Plus — declined for this project).

## Evidence rule

**Sims select the strategy; live mocks calibrate the opponent model.** (Refined
2026-08-21: mocks proved unable to supply strategy-selection power — one slot,
~1 draft per 40 min. Use `harvest.mjs` + `calibrate.mjs`, not head-to-head runs.)

**Sims choose, live mocks veto.** Draft slot dominates outcome variance and swamps strategy differences, so paired offline sims (same slots, same opponent seeds) are the statistical engine; ~8 paired reps reach the power that 50+ unpaired live mocks would need.

A strategy is selected if it ranks top-2 by composite across the paired sweep **and** across ≥3 live mocks produced no operational failure and no roster failing a sanity check (illegal lineup, ≤1 RB, K/DEF too early, >4 starters sharing a bye).

**Never pool sim and live results into one average.** If their rankings disagree by more than one position, the opponent model is wrong — fix the model, don't split the difference.

## Draft night

The manager clicks; I advise. The deliverable is a fast, readable recommendation each turn (top 3 + one line of reasoning each), backed by the precomputed playbook. Draft order is randomized shortly before start, so **the playbook must carry all 12 slots.**

## Precedents

- `../helper/amc/check_imax70.py` — CLI-daemon subprocess wrapper, ```json fence parsing, retry, page canary, sharded in-page `fetch`, `monitor_state.json`. Ported to `lib/cdp.mjs`.
- `../sfdc/pipeline-inspect.mjs`, `../sfdc/lib/score.mjs` — `parseArgs`, `--dry-run`/`--from-cache`, `assertValidWeights`, `degradedFields`, component scoring, `reports/<date>-*` naming.
- `../sfdc/lib/mdToHtml.mjs` — copied for the self-contained playbook.
