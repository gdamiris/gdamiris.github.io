# Scoring & constraints spec (2026-27)

Derived from `docs/rules/` (fetched from the official GitBook via `scripts/fetch_rules.py`)
and verified against live API payloads. This is the contract the optimizer is built against.

## Squad
- Budget **100 credits**; **11 slots**: 4 Guards, 4 Forwards, 2 Centers, 1 Head Coach.
- Max **6 players from the same EuroLeague club**.
- Up to 3 fantasy teams per account.
- Observed price range at open: **4.0 – 17.0 cr** (345 entries = 325 players + 20 coaches).

## Lineup
- **5 players on court**, formation (G-F-C) one of `2-2-1, 1-2-2, 2-1-2, 1-3-1, 3-1-1`.
- **A nominated sixth man also scores 100%.** Only the remaining **4** are halved.
  (Stated on the Classic Mode overview page, not on the Initial Team page.)
- The coach always scores.
- `Round score = Σ(starters) + sixth_man + captain_pts + 0.5 × Σ(other 4) + coach`
- **Captain scores ×2**, and must be chosen **from the starting five** — so the sixth man cannot be captain.
- Captain may be changed between Turns, for a player who has not yet played.

## Player score
Sum of: `+1` point, `+1` rebound, `+1` assist, `+1` steal, `+1` block made,
`+1` foul drawn; `-1` turnover, `-1` block received, `-1` foul committed,
`-1` missed FG, `-1` missed FT.

This is **exactly EuroLeague PIR** (the `Valuation` field in the public boxscore feed),
so historical fantasy scores are reconstructable from open data.

Then: **Team Win Bonus = +10% of that round's fantasy score** if the player's team won.

    player_pts = PIR × (1.10 if team_won else 1.00)

Note this couples player value to team win probability — worth modelling explicitly.

## Coach score
| Result | Pts |
|---|---|
| Win by 1-10, or OT | +10 |
| Win by 11-20 | +20 |
| Win by 20+ | +25 |
| Loss by 1-10, or OT | -5 |
| Loss by 11-20 | -10 |
| Loss by 20+ | -20 |

Scores even if dismissed/absent/suspended. Depends only on **team margin**, so the coach
pick is a pure bet on a team's win-and-cover profile.

## Game Turns (the in-round option)
Each Round splits into Turns by calendar day (T1 = day 1, T2 = day 2). Verified:
R1 = 7 games Sep 24 + 3 games Sep 25; R2 = 8 + 2; R3 = 4 + 6.

Between turns you may swap field↔bench, change the Captain, and change formation —
**but only for players who have not yet played**. This is a free intra-round option:
observe T1 results, then decide. Optimizing it is a sequential decision problem,
not a one-shot lineup choice.

## Trades
- **Max 4 per Round** between rounds; trading the coach counts toward the 4.
- **Unlimited-trade windows** after R6 (Oct 16-21), R13 (Nov 21-24), R18 (Dec 19-22),
  R23 (Jan 16-21), R28 (Feb 13 - Mar 4), R34 (Mar 27-31).
- Unlimited in Play-in / Playoffs / F4.

## Prices
Each player's value moves after every Round based on (a) score obtained and
(b) starting value — for equal scores, a cheaper player gains more. Squad value
changes your purchasing power, so **capital gains are a second objective**
alongside weekly points.

## Season shape
- 20 teams, **38 Rounds**, every team plays exactly **once per Round** — there are
  **no double-gameweeks and no byes** in the regular season.
- Matchdays 39-40 exist but are empty (Play-in / Playoffs / F4).
- RS + Play-in + Playoffs + F4 are a **single unified competition** this season.
- `matchday_id = 1527 + round_number` (R1 = 1528 ... R38 = 1565).
- **Round 1 tips off 2026-09-24.**
