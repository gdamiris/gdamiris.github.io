"""Re-test reallocation against the target that actually matters for fantasy.

The first sweep scored only players with >=10 appearances, which is survivorship
biased: it excludes exactly the fringe players that reallocation is meant to
demote, so it can only ever see reallocation's cost and never its benefit.

Here the target is expected PIR *per team game* -- a DNP counts as zero, which is
what it costs you in fantasy. Every player with EuroLeague history who was on a
target-season roster is scored, whether he played or not.
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


def run(mode, weight=0.5, depth=10):
    maes, sps, ns = [], [], []
    for target in TARGETS:
        year = int(target[1:])
        past, fut = pg[pg.season.astype(str) < target], pg[pg.season == target]

        team_games = fut.groupby("team_code").gamecode.nunique()
        actual = fut.groupby("player_id").agg(
            pir=("pir", "sum"), team=("team_code", lambda s: s.mode().iat[0])).reset_index()
        actual["y"] = actual.pir / actual.team.map(team_games)

        agg = P.weighted_history(past, year).set_index("player_id")
        df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])
        if len(df) < 40:
            continue

        prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
        raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)
        curve = P.minutes_by_rank(past)

        if mode == "none":
            minutes = raw
        elif mode == "taper":
            # Leave the rotation core alone; fade only players ranked past `depth`.
            minutes = raw.copy()
            rank = raw.groupby(df.team).rank(ascending=False, method="first")
            factor = np.clip(1.0 - (rank - depth) / 4.0, 0.0, 1.0)
            minutes = raw * factor

        rate_curve = P.fit_rate_by_minutes(past)
        rate = P.shrink(df.w_pir, df.w_min,
                        pd.Series(rate_curve(minutes), index=df.index), P.K_MINUTES)
        model = minutes * rate

        prev = pg[pg.season == f"E{year - 1}"].groupby("player_id").agg(
            g=("player_id", "size"), p=("pir", "sum"))
        last = (prev.p / prev.g).reindex(df.player_id).values
        pred = np.where(pd.notna(last),
                        P.BLEND_MODEL * model + (1 - P.BLEND_MODEL) * np.nan_to_num(last), model)

        maes.append(np.abs(pred - df.y).mean())
        sps.append(spearmanr(pred, df.y).statistic)
        ns.append(len(df))
    return float(np.mean(maes)), float(np.mean(sps)), int(np.mean(ns))


print("target = PIR per TEAM GAME (DNP counts as 0); all players with history\n")
rows = [("no reallocation", *run("none"))]
for d in [8, 10, 12]:
    rows.append((f"taper past rank {d}", *run("taper", depth=d)))

r = pd.DataFrame(rows, columns=["method", "MAE", "spearman", "n"]).sort_values("MAE")
print(r.round(4).to_string(index=False))
print(f"\nbest: {r.iloc[0].method}")

# --- follow-up: taper the fringe FIRST, then normalise the remaining core to 200.
# The earlier normalisation test was confounded because phantom fringe minutes were
# still in the sum being normalised.
def run_combo(depth=8, cap=200.0):
    maes, sps = [], []
    for target in TARGETS:
        year = int(target[1:])
        past, fut = pg[pg.season.astype(str) < target], pg[pg.season == target]
        team_games = fut.groupby("team_code").gamecode.nunique()
        actual = fut.groupby("player_id").agg(
            pir=("pir", "sum"), team=("team_code", lambda s: s.mode().iat[0])).reset_index()
        actual["y"] = actual.pir / actual.team.map(team_games)
        agg = P.weighted_history(past, year).set_index("player_id")
        df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])
        if len(df) < 40:
            continue
        prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
        raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)

        rank = raw.groupby(df.team).rank(ascending=False, method="first")
        minutes = raw * np.clip(1.0 - (rank - depth) / 4.0, 0.0, 1.0)
        tot = minutes.groupby(df.team).transform("sum")
        minutes = minutes * np.minimum(1.0, cap / tot.replace(0, np.nan)).fillna(1.0)

        rate_curve = P.fit_rate_by_minutes(past)
        rate = P.shrink(df.w_pir, df.w_min,
                        pd.Series(rate_curve(minutes), index=df.index), P.K_MINUTES)
        model = minutes * rate
        prev = pg[pg.season == f"E{year-1}"].groupby("player_id").agg(g=("player_id","size"), p=("pir","sum"))
        last = (prev.p / prev.g).reindex(df.player_id).values
        pred = np.where(pd.notna(last), P.BLEND_MODEL*model + (1-P.BLEND_MODEL)*np.nan_to_num(last), model)
        maes.append(np.abs(pred - df.y).mean())
        sps.append(spearmanr(pred, df.y).statistic)
    return float(np.mean(maes)), float(np.mean(sps))

print("\n=== taper-then-normalise (the confound removed) ===")
for cap in [200, 220, 240, 1e9]:
    mae, sp = run_combo(8, cap)
    label = "no cap" if cap > 1e8 else f"cap {cap}"
    print(f"  taper8 + {label:<9} MAE={mae:.4f}  spearman={sp:.4f}")
