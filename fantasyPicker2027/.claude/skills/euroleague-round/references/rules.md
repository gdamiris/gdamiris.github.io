# EuroLeague Fantasy Challenge — the rules that matter

Source: https://fantaking.gitbook.io/euroleague-fantasy-challenge-rules
Re-pull with `.venv/bin/python scripts/fetch_rules.py` (writes `docs/rules/`).

**Read `classic-mode.md`, not just the sub-pages.** The overview page carries the sixth-man
rule that appears nowhere else, and missing it invalidated the whole scoring model once.

## Squad
- 100 credits, 11 slots: **4 Guards, 4 Forwards, 2 Centers, 1 Head Coach**
- Max 6 players from one EuroLeague club
- Prices 4.0–17.0; the cheapest legal squad costs ~45cr, so ~55cr is discretionary
- Up to 3 fantasy teams per account

## Scoring — the part that is easy to get wrong
- **Six players score 100%: the starting five AND the sixth man.** Only the other four
  are halved. The coach always scores in full.
- **Captain ×2, and he must come from the starting five** — the sixth man cannot captain.
- `Round = Σ(starters) + sixth man + captain again + 0.5 × Σ(other four) + coach`
- The sixth man may be **any position** (confirmed by the user).

## Player points
Exactly EuroLeague PIR — verified against 94,764 historical rows at 100.0000% agreement.
`+1` point, rebound, assist, steal, block made, foul drawn; `-1` turnover, block received,
foul committed, missed FG, missed FT. Then **+10% if his team won**.

The `valuation` field in the stats feed *is* this number. Never recompute it.

## Coach points
Margin only, and asymmetric — which makes the slot structurally positive:

| Result | Pts | | Result | Pts |
|---|---|---|---|---|
| Win 1–10 or OT | +10 | | Loss 1–10 or OT | −5 |
| Win 11–20 | +20 | | Loss 11–20 | −10 |
| Win 21+ | +25 | | Loss 21+ | −20 |

Scores even if dismissed, absent or suspended.

## Turns
Each Round splits by calendar day (T1, T2…). Between Turns you may change formation, make
field↔bench substitutions, and **change the captain** — but only involving players who have
not yet tipped off. A player moved from field to bench keeps 50% of what he already scored.

Legal formations (G-F-C): `2-2-1, 1-2-2, 2-1-2, 1-3-1, 3-1-1`.

## Trades
Four per Round between rounds; trading the coach counts toward the four. Unlimited during
Play-in / Playoffs / F4, and in these windows: after **R6** (Oct 16–21), **R13** (Nov 21–24),
**R18** (Dec 19–22), **R23** (Jan 16–21), **R28** (Feb 13 – Mar 4), **R34** (Mar 27–31).

## Prices
Values move every Round on score and starting value — for equal scores a cheaper player
gains more. Squad value sets purchasing power, so capital gains are a second objective.
No historical price data exists anywhere; `scripts/track_prices.py` measures it live.

## Postponed games
If a game moves outside the Round window, affected players (including coaches and injured
players) receive their **average score to date**, and **the captain does not double**. For a
game cancelled mid-Round the captain does keep the doubling.

## Season
20 clubs, **38 rounds, one game per club per round — no double-gameweeks, no byes.**
Regular season, Play-in, Playoffs and F4 are one unified competition this season.
`matchday_id = 1527 + round_number`. Round 1 tips off 2026-09-24.
