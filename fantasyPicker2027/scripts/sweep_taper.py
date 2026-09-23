"""Test two fixes to the rotation taper:
  1. rank players by a CONFIDENCE-WEIGHTED minutes estimate, so a player with no
     EuroLeague record cannot displace a proven one on a price guess alone;
  2. give the taper a floor, so a mis-ranked player is damped rather than annihilated.
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


def run(depth=8, floor=0.0, conf_rank=False, cap=200.0):
    maes, sps = [], []
    for target in TARGETS:
        year = int(target[1:])
        past, fut = pg[pg.season.astype(str) < target], pg[pg.season == target]
        tg = fut.groupby("team_code").gamecode.nunique()
        actual = fut.groupby("player_id").agg(
            pir=("pir", "sum"), team=("team_code", lambda s: s.mode().iat[0])).reset_index()
        actual["y"] = actual.pir / actual.team.map(tg)
        agg = P.weighted_history(past, year).set_index("player_id")
        df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])
        if len(df) < 40:
            continue

        prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
        raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)
        conf = df.w_min / (df.w_min + P.K_MINUTES)

        key = raw * (0.55 + 0.45 * conf) if conf_rank else raw
        rank = key.groupby(df.team).rank(ascending=False, method="first")
        factor = np.clip(1.0 - (rank - depth) / P.TAPER_WIDTH, floor, 1.0)
        minutes = raw * factor
        tot = minutes.groupby(df.team).transform("sum")
        minutes = minutes * np.minimum(1.0, cap / tot.replace(0, np.nan)).fillna(1.0)

        rc = P.fit_rate_by_minutes(past)
        rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(minutes), index=df.index), P.K_MINUTES)
        model = minutes * rate
        prev = pg[pg.season == f"E{year-1}"].groupby("player_id").agg(g=("player_id","size"), p=("pir","sum"))
        last = (prev.p / prev.g).reindex(df.player_id).values
        pred = np.where(pd.notna(last), P.BLEND_MODEL*model + (1-P.BLEND_MODEL)*np.nan_to_num(last), model)
        maes.append(np.abs(pred - df.y).mean())
        sps.append(spearmanr(pred, df.y).statistic)
    return float(np.mean(maes)), float(np.mean(sps))


rows = []
for conf_rank in (False, True):
    for floor in (0.0, 0.15, 0.25, 0.35):
        mae, sp = run(floor=floor, conf_rank=conf_rank)
        rows.append({"conf_weighted_rank": conf_rank, "floor": floor, "MAE": mae, "spearman": sp})
r = pd.DataFrame(rows).sort_values("MAE")
print(r.round(4).to_string(index=False))
print(f"\nbest: conf_rank={r.iloc[0].conf_weighted_rank}, floor={r.iloc[0].floor}")
