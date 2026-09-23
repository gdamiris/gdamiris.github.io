# What was measured — and what was tried and rejected

Everything here was validated on held-out seasons. Re-run any of it with the named script.
**Read the rejected list before adding features**; several obvious ideas do nothing.

## The projection, in order
`minutes × PIR-per-minute`, then age, then blended with last season, then matchup.

| Step | Detail | Why |
|---|---|---|
| Minutes | own record shrunk toward a **price**-implied prior (k=20 games) | price is the club's own role estimate, stated for rookies and veterans alike |
| Rotation taper | fade past 8th **at his position**, floor 0.35, then cap club at 200 | ranking is positional, budget is not — see rejected |
| PIR/min | shrunk toward a **role-conditional** prior (k=400 min) | rate is not role-independent: 0.21/min at 3 mpg vs 0.57 at 30 |
| Age | −3%/yr past 25 in a real role, −5%/yr for fringe, on the model term only | one global slope buries elite veterans |
| Blend | **40% model / 60% last season's PIR per team game** | model alone is well-ordered but compressed |
| Matchup | opponent points-allowed and home/away, proportionally | ±1.1 PIR and ±0.65 PIR respectively |
| Injuries | an absent player's minutes pass to team-mates **at his position** | the 200 minutes still get played |

Held out over 2022–25: **MAE 2.754 against 2.978** for a last-season baseline, on 984
player-seasons against the baseline's 773.

## Strategy, measured
- **Captain switch is worth +1.2 to +5.7 a round.** Captaining a Turn 1 player beats
  captaining a higher-projected Turn 2 player (16 vs 18 projected → 21.5 vs 18.0), because
  captaining in the last Turn forfeits the option. `scripts/test_captain_switch.py`
- **Turn swap rule:** promote the bench player iff his expected beats the starter's *actual*.
  Keep = `s + 0.5b`; swap = `0.5s + b`; swap wins iff `b > s`. Worth ~+2.4 a round.
- **Bench shape:** three or four minimum-price slots is right. With the sixth man modelled,
  forcing a second quality bench player costs points (115.9 → 115.1), and a uniformly
  mid-priced bench is worst (108.0). `scripts/test_bench_shape.py`
### The coach slot, validated
- **Structurally positive**: the bands are asymmetric, so the average coach-game pays
  **+3.21**. By club quality: weakest quartile −2.14, strongest **+8.27**. Never an afterthought.
- **`MARGIN_SD` is 11.9, not 13.2.** What matters is not how much margins vary but how much
  they vary *around our forecast*. Club strength predicts a single game only loosely
  (correlation ~0.40, residual SD 11.9 over four held-out seasons). Using the raw 13.2
  over-disperses and flattens the spread — understating good coaches and overstating bad
  ones, exactly backwards for choosing between them.
- **The normal approximation is fine**: within 0.7 points of an empirical resample across
  the whole range of expected margins.
- **Overtime can be ignored, provably.** An OT win pays +10, the same as any 1–10 win; an
  OT loss −5, the same as any 1–10 loss. OT never moves a result across a band boundary.
- **The coach is a WEEKLY decision.** Within one round the 20 coaches span 11 to 21
  points, and the best one changed in 4 of 5 round transitions. Holding a single coach
  across six rounds scores 42.5 where picking the best each round scores 69.3. So he is
  valued on the current round only, not blended over the horizon.
- **But do not switch every round — switch when it pays.** Holding last round's pick and
  only switching when worthwhile: the gains are lumpy, +9.0 and +12.2 on two rounds and
  under +0.6 on the other three. Only 2 of 5 switches cleared **+3.5**, which is what a
  marginal player trade buys. `plan_transfers.py` prints this check every round.
- The big gains come when your held coach draws a hard fixture, not when a better coach
  appears — Itoudis fell to 3.0 and then 1.7 on Hapoel's tough rounds.
- **You are buying blowout odds, not win odds.** Coach scoring is a step function: a
  2-point win and a 10-point win both pay exactly +10. Across the whole field the +10 band
  sits at a near-constant ~32%, so it separates nobody. What differs is the top two bands —
  Itoudis carries a 46% chance of a 20-point outcome against Penarroya's 26%. Judge a coach
  on `coach_band_probabilities()`, not on his expected value alone.
- The bands are **+10 / +20 / +25** for wins and **-5 / -10 / -20** for losses. A narrow win
  pays double a narrow loss; that asymmetry is the whole reason the slot is worth having.

## Rejected — do not rebuild these
- **Points conceded per position.** Real and persistent (guards r=+0.586) but entirely
  subsumed by overall defence. Positional *residual* spread is +0.048 PIR against +1.063
  for overall. Variance explained 0.299% → 0.299%. `scripts/test_positional_defence.py`
- **Points scored per position.** Club profiles persist but are endogenous — the profile
  is a consequence of the roster, not a force on new arrivals. For 242 same-position club
  moves, correlation with output change is **−0.045**.
- **Rest / days between games.** Moves PIR by under 0.15. Nothing there.
- **Scaling every club's minutes to 200 proportionally.** Worse than doing nothing
  (3.128 vs 3.139) — it robs real rotation players to pay for phantom fringe minutes.
  Taper first, then cap.
- **A power transform to fix projection scale.** Monotonic, so ranking survives, but it
  cannot fix flatness without exploding the tail (Vezenkov to 43.9 PIR).
- **Confidence-weighted rotation ranking.** Fixes unknowns displacing veterans, but buries
  every new signing regardless of calibre. Rank on price instead.

## What actual winning squads look like — and how to read them
`scripts/fetch_winning_lineups.py` harvests the official round-winner articles, which
publish the FULL lineup. 23 squads from 2025-26, the only season under the 2x captain.

- A round-winning score averages **244** (228-266). That is the best of the whole field.
- Their full-scoring six averaged **13.4** PIR/game, the bench four **5.7** (42%), and
  **51%** of bench picks scored under 5. The most-picked bench filler averaged **2.4**.
- Captains averaged **14.9** PIR, and **12 of 22 were guards**.
- Squads spread across **8.1 clubs**, never more than **3** from one.
- Most-picked: Vezenkov 7x, Oturu 6x, Milutinov 6x, Baldwin 5x, Francisco 5x.

**Read this for shape, not for rules.** A round winner is SELECTED for having scored 244
— everything went right, the bench included — so their bench looking respectable is what
that selection produces, not evidence it wins. Tested directly: forcing a bench that good
costs the mean (125.4 -> 124.0) AND the round-winning upside (p90 173.2 -> 169.8).
Likewise the 8.1-club spread: capping clubs directly costs points for nothing
(125.4 -> 124.7), because the correlation that hurts is shared GAMES, not shared badges,
and the fixture cap already handles that.

## Traps that cost real time
- **Benchmark selection bias.** Comparing a *pre-selected* top six against the *post-hoc*
  best six made the model look 30% cold when it is ~9% light. Same bias made a squad
  benchmark read 131 a round when the honest, lineup-fixed-in-advance figure is 110.
  Always fix the selection before the fact.
- **Backtests cannot see pool-level problems.** They score only players with EuroLeague
  history — far fewer per club than the 21 the fantasy pool lists. Anything about minute
  *distribution* must be checked against the live pool separately.
- **Copying winners without asking what selected them.** The single most tempting error
  in this project. Any "winner profile" is conditioned on having won, so every component
  looks good in hindsight. Always ask whether the trait CAUSED the win or was produced by
  selecting on it, and test it against the mean and the tail before adopting it.
- **The rate limit on euroleague.net is brutal.** Use `feeds.incrowdsports.com`; it is a
  different CDN, richer, and not throttled. The other host will Cloudflare-block the IP.

## Scoring context
A round you actively manage: >200 excellent, 160–200 very good, 130–160 fine, <130 poor.
A perfect-hindsight 100cr squad with the lineup fixed in advance scored a median of **110**;
with the lineup chosen after the fact, **131**. The gap between them is what in-round
management is worth. Projections assume none of it, so they read low by design.
