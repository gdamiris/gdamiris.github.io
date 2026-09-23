---
name: euroleague-model
description: Change or extend the EuroLeague fantasy projection model — minutes, PIR rate, age curve, rotation taper, club strength, matchup factors, or the squad optimiser. Use when tuning constants, adding a feature, investigating why a player is projected high or low, or validating a modelling idea. Not needed for the routine weekly pick, which is euroleague-round.
---

# Working on the projection model

## Where things live

| File | Holds |
|---|---|
| `src/flp/projections.py` | every model constant and transform, each with the measurement that justifies it |
| `src/flp/scoring.py` | the game's scoring rules as code |
| `src/flp/optimize.py` | the ILP: squad, lineup, sixth man, captain, constraints |
| `scripts/project.py` | orchestrates a round's projections |
| `scripts/backtest.py` | the honest scoreboard — mirrors production exactly |
| `data/player_game.parquet` | 94,764 player-games, EuroLeague + EuroCup, 2018–2025 |

## The rule for any change

**Measure it on held-out seasons before shipping it, and mirror the change into
`scripts/backtest.py` so the headline number stays honest.** Several changes in this
model's history looked obviously right and made things worse; several looked marginal
and were the largest gains. The record is in `../euroleague-round/references/findings.md`
— read the rejected list first, it will save you rebuilding something already disproven.

Current held-out performance: **MAE 2.754**, against **2.978** for a last-season baseline.

## How to validate properly

```bash
.venv/bin/python scripts/backtest.py           # the scoreboard
.venv/bin/python scripts/sweep.py              # blend / decay / shrinkage
.venv/bin/python scripts/sweep_position.py     # rotation allocation
.venv/bin/python scripts/sweep_eurocup.py      # EuroCup weighting
.venv/bin/python scripts/test_age_by_role.py   # age curve
```

Target is **PIR per team game, with a DNP counting as zero** — that is what a player is
worth to own. Scoring only games he played flatters everything and hides availability risk.

### Two failure modes to guard against
1. **Survivorship.** The backtest scores players with EuroLeague history and enough games.
   Anything about who *fails* — fringe players, minute distribution across a 21-man pool —
   is invisible to it. Check those against the live pool.
2. **Selection bias in the benchmark.** If the model picks its top six in advance, compare
   against a top six chosen in advance. Comparing against the best six after the fact once
   sent this model on three rounds of chasing a phantom 30% error that was really 9%.

## Data sources

- **Stats, no auth:** `feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/{E|U}/seasons/{code}/games/{n}/stats` — `E` EuroLeague, `U` EuroCup. Use this host.
- **Fixtures/results:** `api-live.euroleague.net/v1/results?seasoncode=E2026` — rate-limited, cache it.
- **Fantasy API:** `fantaking-api.dunkest.com`, two-legged auth in `src/flp/dunkest.py`.
  Credentials in the gitignored `.env`. Prices, ownership, injuries, rosters.
- `euroleague.net` hosts throttle hard and will Cloudflare-block. Prefer incrowdsports.

## Things still open
- 77 players have no record in either competition; 15 cost 10cr+. Only preseason or real
  games fix this — there is no data source to add.
- Price movement is unmodelled. `scripts/track_prices.py` measures it live from Round 2.
- The optimiser plans Rounds R..R+5 but does not plan *transfers* — it cannot decide which
  four players to sell. That is the largest remaining piece of work.
