# NFL Draft Copilot

A draft-prep and live-draft-advisor toolkit for a Yahoo fantasy football snake
draft. It exists because Yahoo's own draft grade mostly rewards "did you follow
the crowd's rankings" rather than actual projected team strength — this
optimizes for the latter.

Built with [Claude Code](https://claude.com/claude-code) driving a real
browser via the [chrome-devtools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
server, for a real 2026 draft. `STATUS.md` and `research/verification-log.md`
are the actual working notes from that process, kept as-is because they're a
more honest record than a cleaned-up writeup would be.

## What it does

- **Exact league scoring** (`lib/scoring.mjs`) — computed from box-score
  components and cross-checked against Yahoo's own scored numbers, not
  approximated.
- **VORP / VONA valuation** (`lib/vorp.mjs`) — values a player against
  replacement level and against what's likely to survive to your next pick,
  not just raw projected points.
- **A calibrated opponent simulator** (`simulate.mjs`) — runs thousands of
  paired mock drafts across every draft slot to compare strategies head to
  head, with the opponents' behavior (how far they stray from ADP, how hard
  they chase positional runs) fit from real harvested draft data rather than
  guessed.
- **A live-mock harness** (`mock.mjs`, `harvest.mjs`) — drives an actual Yahoo
  mock draft in a real logged-in browser tab: clicks picks, manages the
  queue as a safety net against a dying clock, clears Yahoo's autopick
  lockout, and records the full pick order for calibration.
- **A draft-night advisor** (`advise.mjs`) — given the current board and your
  roster, prints ranked candidates with reasoning, in the one-shot,
  no-reasoning-on-the-clock shape a live draft actually needs.

See `CLAUDE.md` for the full operating rules this was built under (identity
handling, determinism, unattended-run boundaries) and `STATUS.md` for the
current state of a real in-progress draft prep.

## The strategy, briefly

The leading strategy (`vona-starter`) picks by: (1) how much a player is worth
over the best one likely to survive to your *next* pick — not just raw value
now, (2) how much a player actually improves your *starting* lineup, not your
bench, and (3) avoiding stacking too many starters on the same bye week. It
was selected by running it against 9 other strategies (best-value, tiered,
zero-RB, hero-RB, ADP-only, etc.) across 1,800+ simulated paired drafts and 3
live mock drafts, on the rule "best projected starting lineup, with zero
illegal/degenerate rosters."

## Setup

Requires:
- Node.js 20+ (zero npm dependencies — everything is plain ESM)
- A Yahoo Fantasy account and an already-logged-in Chrome profile
- The [chrome-devtools MCP CLI](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  on your `PATH` (or set `CHROME_DEVTOOLS_BIN` to its absolute path) — this is
  what drives the browser for scraping and live drafting

Then:
1. `cp config.example.json config.json`, then fill in your own league's `id`,
   `name`, and URLs under `league`, and verify the `scoring`/`roster` blocks
   against your league's Yahoo settings export. `config.json` is gitignored —
   it holds your real league ID, so it's never committed.
2. `node scrape-board.mjs` — scrapes the full player pool for your league into
   `data/players-<date>.json`.
3. `node rank.mjs` — scores and ranks it into `data/rankings-<date>.json` and
   a cheat-sheet report.

## Workflow

| Command | Writes |
|---|---|
| `node scrape-board.mjs` | `data/players-<date>.json` |
| `node rank.mjs` | `data/rankings-<date>.json`, `reports/<date>-cheatsheet.{md,html}` |
| `node rank.mjs --calibrate` | `research/scoring-calibration.md` |
| `node simulate.mjs --seeds 15` | `sims/<date>-bakeoff.json`, `reports/<date>-bakeoff.md` |
| `node harvest.mjs --run-id <id>` | `data/harvest/<id>.json` — real draft order, observation only |
| `node calibrate.mjs --write` | fits the sim's opponent model into `config.json` |
| `node mock.mjs --strategy <s> --run-id <id>` | `mocks/<id>-<s>/report.md` — drives a live mock draft |
| `node advise.mjs --avail … --roster … --pick N --next M` | prints ranked draft-night candidates |

All commands accept `--dry-run` / `--from-cache` where applicable.

## Tests

```
node --test lib/*.test.mjs
```

## License

MIT — see `LICENSE`.
