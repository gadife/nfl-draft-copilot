# Scoring calibration — 2026-08-21

Our recomputed points vs Yahoo's league-scored "Fan Pts", 443 players with >20 pts.

- mean delta **0.007**
- |delta| > 5: **0 (0.0%)** — gate is 5%, so this **PASSES**
- DEF points-allowed dispersion fitted across 32 defenses on 2025 ACTUALS: **paSd = 10.7**, RMSE 3.678
- DEF projections excluded from this gate: Yahoo's projected "Pts vs." column is not a season total
  (~187 over 17 games = 11 PA/g, vs 286-334 actual), so DEF proj points come from Yahoo Fan Pts directly.

Residuals are dominated by Yahoo rounding its displayed component stats
(e.g. receptions shown as 69.2), plus off-position stats absent from a
position's column set — Brandon Aubrey's 0.60 gap was 6 rushing yards on a fake FG.

| Player | Pos | Yahoo | Ours | Delta |
|---|---|--:|--:|--:|
| Jonah Coleman | RB | 63.0 | 62.3 | -0.69 |
| Chimere Dike | WR | 56.9 | 57.5 | 0.60 |
| Bijan Robinson | RB | 296.1 | 295.5 | -0.59 |
| Brashard Smith | RB | 30.9 | 31.5 | 0.58 |
| Mike Washington Jr. | RB | 59.9 | 59.4 | -0.56 |
| Andrei Iosivas | WR | 66.1 | 65.6 | -0.54 |
| Najee Harris | RB | 32.8 | 33.4 | 0.53 |
| Zachariah Branch | WR | 69.0 | 69.5 | 0.52 |
| Justin Herbert | QB | 275.0 | 274.5 | -0.51 |
| Xavier Hutchinson | WR | 38.8 | 38.3 | -0.51 |
| Christian Watson | WR | 168.9 | 169.4 | 0.50 |
| D'Andre Swift | RB | 180.8 | 181.3 | 0.47 |
| KC Concepcion | WR | 122.7 | 123.2 | 0.47 |
| Tucker Kraft | TE | 147.3 | 146.8 | -0.46 |
| Tre Tucker | WR | 90.4 | 90.9 | 0.46 |