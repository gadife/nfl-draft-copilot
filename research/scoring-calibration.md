# Scoring calibration — 2026-09-02

Our recomputed points vs Yahoo's league-scored "Fan Pts", 435 players with >20 pts.

- mean delta **-0.005**
- |delta| > 5: **0 (0.0%)** — gate is 5%, so this **PASSES**
- DEF points-allowed dispersion fitted across 32 defenses on 2025 ACTUALS: **paSd = 10.7**, RMSE 3.279
- DEF projections excluded from this gate: Yahoo's projected "Pts vs." column is not a season total
  (~187 over 17 games = 11 PA/g, vs 286-334 actual), so DEF proj points come from Yahoo Fan Pts directly.

Residuals are dominated by Yahoo rounding its displayed component stats
(e.g. receptions shown as 69.2), plus off-position stats absent from a
position's column set — Brandon Aubrey's 0.60 gap was 6 rushing yards on a fake FG.

| Player | Pos | Yahoo | Ours | Delta |
|---|---|--:|--:|--:|
| Jaylin Noel | WR | 92.7 | 93.4 | 0.68 |
| Jordan Mason | RB | 151.5 | 152.2 | 0.66 |
| Rachaad White | RB | 151.9 | 152.5 | 0.63 |
| Mark Andrews | TE | 158.5 | 157.8 | -0.62 |
| Quentin Johnston | WR | 159.9 | 159.3 | -0.62 |
| Kyle Monangai | RB | 148.0 | 148.6 | 0.60 |
| Chase Brown | RB | 259.8 | 259.2 | -0.59 |
| Stefon Diggs | WR | 168.4 | 169.0 | 0.59 |
| Wan'Dale Robinson | WR | 167.0 | 167.6 | 0.59 |
| Mike Washington Jr. | RB | 85.0 | 85.6 | 0.58 |
| Ray Davis | RB | 77.2 | 76.6 | -0.55 |
| Brashard Smith | RB | 33.5 | 34.1 | 0.55 |
| Carson Beck | QB | 50.9 | 51.5 | 0.55 |
| C.J. Stroud | QB | 317.6 | 318.1 | 0.53 |
| Tucker Kraft | TE | 189.2 | 188.7 | -0.52 |