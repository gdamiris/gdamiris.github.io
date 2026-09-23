"""Does folding in translated EuroCup history actually improve projections?

Held out the same way as everything else: train on prior seasons only, score against
PIR per team game in the target EuroLeague season.
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


def run(weight):
    old = P.EUROCUP_EVIDENCE_WEIGHT
    P.EUROCUP_EVIDENCE_WEIGHT = weight
    maes, sps, ns = [], [], []
    for target in TARGETS:
        year = int(target[1:])
        past = pg[pg.season.str[1:].astype(int) < year] if weight > 0 else \
               pg[(pg.season.str[1:].astype(int) < year) & (pg.competition == "E")]
        fut = pg[pg.season == target]
        tg = fut.groupby("team_code").gamecode.nunique()
        actual = fut.groupby("player_id").agg(
            pir=("pir", "sum"), team=("team_code", lambda s: s.mode().iat[0])).reset_index()
        actual["y"] = actual.pir / actual.team.map(tg)
        agg = P.weighted_history(past, year).set_index("player_id")
        df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])
        prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
        raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)
        mins = P.taper_fringe_minutes(raw, df.team)
        rc = P.fit_rate_by_minutes(past[past.competition == "E"])
        rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(mins), index=df.index), P.K_MINUTES)
        model = mins * rate
        prev = pg[pg.season == f"E{year-1}"].groupby("player_id").agg(g=("player_id","size"), p=("pir","sum"))
        last = (prev.p / prev.g).reindex(df.player_id).values
        pred = np.where(pd.notna(last), P.BLEND_MODEL*model + (1-P.BLEND_MODEL)*np.nan_to_num(last), model)
        maes.append(np.abs(pred - df.y).mean()); sps.append(spearmanr(pred, df.y).statistic)
        ns.append(len(df))
    P.EUROCUP_EVIDENCE_WEIGHT = old
    return float(np.mean(maes)), float(np.mean(sps)), int(np.mean(ns))


print("EuroCup evidence weight (0 = EuroLeague only, today's model)\n")
rows = []
for w in [0.0, 0.3, 0.45, 0.6, 0.8, 1.0]:
    mae, sp, n = run(w)
    rows.append({"weight": w, "MAE": mae, "spearman": sp, "players_scored": n})
r = pd.DataFrame(rows)
print(r.round(4).to_string(index=False))
best = r.loc[r.MAE.idxmin()]
print(f"\nbest weight {best.weight} -> MAE {best.MAE:.4f} "
      f"(EuroLeague-only {r.iloc[0].MAE:.4f}), covering {int(best.players_scored)} players "
      f"vs {int(r.iloc[0].players_scored)}")
