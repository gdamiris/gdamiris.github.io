# EuroLeague Fantasy Picker — 2026-27

Picks the squad for the official EuroLeague Fantasy Challenge each Round.
Round 1 tips off **2026-09-24**. The game runs on Dunkest's backend.

## Start here
Two skills carry everything learned. Invoke them rather than re-deriving:

- **`euroleague-round`** — the weekly job: refresh prices/ownership/injuries, reproject,
  optimise the eleven, publish the team sheet. Its `references/` hold the exact game rules
  and every validated finding.
- **`euroleague-model`** — for changing the model itself. Read the rejected-ideas list
  before adding a feature; several obvious ones were measured and do nothing.

## Layout
```
src/flp/      projections.py (model + constants)  scoring.py (rules as code)
              optimize.py (the ILP)  dunkest.py (fantasy API client)
scripts/      fetch_* (data in)  project* (projections)  build_squad  export_view
              backtest / sweep_* / test_* (validation)
data/         player_game.parquet (94,764 rows)  projections/  players/ (price snapshots)
docs/         rules/ (pulled rulebook)  SCORING-MODEL.md (the spec)
```

## Conventions
- `.venv/bin/python` for everything; deps in `requirements.txt`.
- Credentials live in `.env` (gitignored). Never inline them.
- Stats come from `feeds.incrowdsports.com`; the `euroleague.net` hosts rate-limit hard
  and will Cloudflare-block the IP.
- Model constants carry the measurement that justifies them in a comment. Keep that up —
  it is what stops the next session re-running a settled experiment.
- Any model change must be measured on held-out seasons **and** mirrored into
  `scripts/backtest.py`, or the headline number silently becomes a lie.

## The team sheet
Published as an Artifact and updated in place each round — pass the existing `url` rather
than creating a new artifact.
