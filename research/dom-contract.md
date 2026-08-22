# DOM contract — Yahoo draft client

Validated live in mock room 9367264 on 2026-08-21 (12-team, slot 9).
URL shape: `https://football.fantasysports.yahoo.com/draftclient/f1/<mockLeagueId>/<slot>?auth=`

## Structure

Player rows are a real table. Identity element sits **inside** the row:

```
TABLE._ys_… > TBODY > TR > TD > DIV.W(150px) > DIV.ys-player[data-id]
```

So `el.closest('tr')` is the correct row accessor. `data-id` on `.ys-player` is the
global player key — **identical** to `data-ys-playerid` on the server-rendered
`/players` page and to the headshot URL filename. Verified: `40059` Gibbs,
`32671` Burrow, `32696` J. Love, `33500` St. Brown. Team defenses use `1000xx`.

## Columns — read by header name, never by index

`thead th` gives: `Queue | Player | XRank | ADP | Bye | Proj Pts | GP | Pass Yds |
Pass TD | Int | Rush Att | Rush Yds | Rush TD | Targets | Rec | Rec Yds | Rec TD |
Ret TD | 2-PT | Fum Lost`

**Real ADP is here** (`ADP` column, e.g. Gibbs 1.5) — better than the preseason-rank
proxy used offline.

> **The column set shifts when a position filter is applied.** Reading fixed cell
> indices under `pos=QB` returned `adp: null` and bye weeks in the proj column.
> Always locate columns by matching header text in the same call.

## The two mutually exclusive column states

This is the single most important behavioural fact:

| When | First column shows | Implication |
|---|---|---|
| **On the clock** | `button "Draft"` per row | Draft is possible; **stars are gone** |
| **Off the clock** | `svg[data-icon="star-unfilled"]` in a button | Queue is possible; **no Draft buttons exist** |

Consequences:
- Queue work must happen **between** turns. Trying to star while on the clock returns
  "no star button" for every row.
- Searching for a Draft button while off the clock finds **zero** and looks
  identical to a broken selector. Check turn state before concluding anything.

## Turn state — scope the regex to the header

`document.body.innerText` (NOT `textContent`, which includes injected `<style>` text).

```
"… Double Reverse - H2H  00:29  Nate's Pick • You're up in 3 Picks • Round 4, Pick 43  Last: J. WADDLE (WR · DEN) …"
"… 00:21  YOUR TURN • ROUND 3, PICK 33  Last: J. JACOBS (RB · GB) …"
```

- `onClock` must match **`/YOUR TURN\s*[•·]/` against the first ~200 chars only.**
  A naive `/YOUR TURN/` over the whole body false-positives on the player list's
  own `YOUR TURN - 40TH PICK` divider rows.
- clock `\b(\d{1,2}):(\d{2})\b`, `ROUND (\d+), PICK (\d+)`, `up in (\d+) Pick`,
  `YOUR TEAM \((\d+)\/(\d+)\)`, `Draft Complete`.

## Trusted vs synthetic events — the trap that cost a pick

| Action | JS `.click()` | CDP click (MCP `click`) |
|---|--:|--:|
| Draft a player | **works** | works |
| Star / queue a player | **works** | works |
| Close a modal | fails | **works** |
| Toggle off autopick mode | fails | **works** |

**Yahoo put us into autopick "due to inactivity" before our first pick**, because
`evaluate_script` produces untrusted events that do not reset the idle timer. The
Draft column therefore never rendered, the click path found nothing, the clock
expired, and Yahoo autodrafted from an empty queue.

Recovery required real CDP clicks: close the Settings modal (`uid` of the focused
`button` in the modal), then dismiss the autopick dialog. After that the banner
cleared and live drafting resumed.

**Mitigations for unattended runs:** emit a periodic trusted interaction (MCP
`click`/`hover` on a harmless element) to keep the session "active", and treat
`/put into autopick/i` in the body as a hard alarm that must be cleared before
the next pick.

## Getting a uid without overflowing context

`take_snapshot` on this page returns ~118k chars inline. Use
`take_snapshot --filePath <inside workspace>` then `grep` it. Note the a11y tree
is **trapped by an open modal** — while a dialog is up the snapshot is ~4 lines,
which is actually convenient for finding modal buttons.
`/tmp` is rejected; the path must be within a workspace root.

## Selects available in the draft room

| name | values |
|---|---|
| `position-filter` | `pos_type=All`, `pos_type=O`, `pos=QB\|WR\|RB\|TE\|W/R/T\|K\|DEF` |
| `stat-mode-filter` | `projected`, `season`, `advancedstats`, `projectedvendor_*` |
| `adp-filter` | `average-pick`, `average-diamond-pick`(+), `last7days-…`(+) |
| `expert-rank-filter` | `o_rank`, `expert_ranks:*`(+) |

Board renders ~100 rows at a time (paginates on scroll). The top 100 covers the
entire relevant pool through roughly round 8.

## Mock lobby

- `/f1/<league>/mock_lobby?lobby=standard` — public rooms, free, real humans, new
  rooms every ~2 min. POST `mock_join` with `quick_start_teams` = `any|8|10|12|14`.
- Instant Mock Drafts (bots, exact league config, selectable slot 1–12) exist but
  require **Fantasy Plus**; free tier is capped at 3 rounds.
- Waiting room `mock_waiting?mlid=<id>` shows the slot assignment and roster
  positions before the draft opens — a good place to run reconnaissance.
