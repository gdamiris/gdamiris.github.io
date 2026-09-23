"""Snapshot the fantasy player pool (prices, ownership, injury flags) for a Round.

Prices move every Round, so snapshots are kept per-matchday under data/players/
to build our own price history — the API exposes no historical prices.
"""
import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.dunkest import Dunkest

ap = argparse.ArgumentParser()
ap.add_argument("--round", type=int, default=1)
args = ap.parse_args()

FIRST_MATCHDAY = 1528
matchday = FIRST_MATCHDAY + args.round - 1

d = Dunkest()
raw = d.players(config.PLAYERS_LIST_ID, str(matchday))["data"]

rows = []
for p in raw:
    pos = (p.get("position") or {}).get("name")
    team = p.get("team") or {}
    opp = p.get("opponent") or {}
    rows.append({
        "player_id": p["id"],
        "first_name": p.get("first_name"), "last_name": p.get("last_name"),
        "position": pos,
        "price": p.get("quotation"),
        "team": team.get("name"), "team_abbr": team.get("abbreviation"),
        "team_id": team.get("id"), "home_away": team.get("position"),
        "opponent": opp.get("name"), "opponent_abbr": opp.get("abbreviation"),
        "avg_pts": p.get("avg_pts"),
        "popularity": p.get("popularity"),
        "is_injured": p.get("is_injured"),
        "prob_playing": p.get("probability_of_playing"),
        "round": (p.get("round") or {}).get("number"),
    })

df = pd.DataFrame(rows)
out_dir = config.DATA / "players"
out_dir.mkdir(parents=True, exist_ok=True)
csv = out_dir / f"round{args.round:02d}.csv"
df.to_csv(csv, index=False)
(out_dir / f"round{args.round:02d}.json").write_text(json.dumps(raw))

print(f"Round {args.round} (matchday {matchday}) -> {csv}")
print(f"{len(df)} entries: " + ", ".join(f"{k}={v}" for k, v in df.position.value_counts().items()))
print(f"price range {df.price.min()}-{df.price.max()}  |  injured: {int(df.is_injured.sum())}")
