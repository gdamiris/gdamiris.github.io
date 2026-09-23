"""Validate the team-minutes reallocation and pick ROTATION_WEIGHT honestly.

Reallocation is meant to fix minutes estimates that reflect a player's *previous*
role. Roster turnover happens every season, so held-out seasons are a fair test:
we know each player's club for the target season, and project using only prior data.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
import flp.projections as P

pg = pd.read_parquet(config.DATA / "player_game.parquet")
TARGETS = ["E2022", "E2023", "E2024", "E2025"]


def run(rot_weight):
    maes, sps = [], []
    for target in TARGETS:
        year = int(target[1:])
        past, fut = pg[pg.season.astype(str) < target], pg[pg.season == target]

        actual = fut.groupby("player_id").agg(
            games=("player_id", "size"), pir=("pir", "sum"),
            team=("team_code", lambda s: s.mode().iat[0])).reset_index()
        actual = actual[actual.games >= 10]
        actual["y"] = actual.pir / actual.games

        agg = P.weighted_history(past, year).set_index("player_id")
        df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])
        if len(df) < 40:
            continue

        prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
        raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)

        old = P.ROTATION_WEIGHT
        P.ROTATION_WEIGHT = rot_weight
        curve = P.minutes_by_rank(past)
        minutes = (raw if rot_weight is None
                   else P.allocate_team_minutes(raw, df.team, curve))
        P.ROTATION_WEIGHT = old

        rate_curve = P.fit_rate_by_minutes(past)
        rate = P.shrink(df.w_pir, df.w_min,
                        pd.Series(rate_curve(minutes), index=df.index), P.K_MINUTES)
        model = minutes * rate

        prev = pg[pg.season == f"E{year - 1}"].groupby("player_id").agg(
            g=("player_id", "size"), p=("pir", "sum"))
        last = (prev.p / prev.g).reindex(df.player_id).values
        pred = np.where(pd.notna(last), P.BLEND_MODEL * model + (1 - P.BLEND_MODEL) * np.nan_to_num(last), model)

        maes.append(np.abs(pred - df.y).mean())
        sps.append(spearmanr(pred, df.y).statistic)
    return float(np.mean(maes)), float(np.mean(sps))


print("ROTATION_WEIGHT sweep (None = no reallocation at all)\n")
mae, sp = run(None)
print(f"  no reallocation   MAE={mae:.4f}  spearman={sp:.4f}")
best = (mae, None)
for w in [0.0, 0.25, 0.5, 0.75, 1.0]:
    mae, sp = run(w)
    flag = ""
    if mae < best[0]:
        best = (mae, w)
        flag = "  <-- best so far"
    print(f"  weight={w:.2f}         MAE={mae:.4f}  spearman={sp:.4f}{flag}")
print(f"\nbest: ROTATION_WEIGHT={best[1]} (MAE {best[0]:.4f})")
