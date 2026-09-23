"""Measure how player values actually move between rounds.

The rules say a player's credit value rises or falls after each Round based on his
score and his starting value, with cheaper players gaining more for the same score.
That mechanism is the basis for building budget early and cashing it at a free
transfer window -- but no historical price data exists anywhere, so it cannot be
backtested. It can only be measured live.

This compares consecutive round snapshots (written by scripts/fetch_players.py) and
fits the actual relationship, so the capital-gains strategy stops being a theory
after two or three rounds.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

snaps = sorted((config.DATA / "players").glob("round*.csv"))
if len(snaps) < 2:
    print(f"{len(snaps)} price snapshot(s) on disk — need at least 2.")
    print("Run  scripts/fetch_players.py --round N  after each round; the comparison")
    print("runs itself once Round 2 prices are published.")
    raise SystemExit(0)

frames = []
for f in snaps:
    d = pd.read_csv(f)
    d["round"] = int(f.stem.replace("round", ""))
    frames.append(d[["player_id", "last_name", "team_abbr", "price", "avg_pts", "round"]])
h = pd.concat(frames)

moves = []
rounds = sorted(h["round"].unique())
for a, b in zip(rounds, rounds[1:]):
    x = h[h["round"] == a].set_index("player_id")
    y = h[h["round"] == b].set_index("player_id")
    j = x.join(y[["price", "avg_pts"]], rsuffix="_next", how="inner")
    j["delta"] = j.price_next - j.price
    j["scored"] = j.avg_pts_next
    j["from_round"] = a
    moves.append(j.reset_index())
m = pd.concat(moves)

print(f"{len(m)} player-round price moves across rounds {rounds[0]}-{rounds[-1]}\n")
print(f"  mean move {m.delta.mean():+.3f}cr | sd {m.delta.std():.3f} | "
      f"rose {(m.delta > 0).mean():.0%} | fell {(m.delta < 0).mean():.0%}")

if m.delta.abs().sum() > 0:
    print("\n=== does a cheap player really gain more for the same score? ===")
    m["band"] = pd.cut(m.price, [0, 6, 9, 12, 20], labels=["4-6cr", "6-9", "9-12", "12+"])
    print(m.groupby("band", observed=True).agg(
        n=("delta", "size"), scored=("scored", "mean"), move=("delta", "mean")).round(3).to_string())
    ok = m.scored.notna() & m.price.notna()
    if ok.sum() > 30:
        c = np.polyfit(m.loc[ok, "scored"], m.loc[ok, "delta"], 1)
        print(f"\n  fitted: price move = {c[0]:+.4f} x points scored {c[1]:+.4f}")
        print(f"  break-even score (value holds steady): {-c[1]/c[0]:.1f} points")
