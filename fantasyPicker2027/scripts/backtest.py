"""Does the shipped model beat simple baselines?

Mirrors the production path in scripts/project.py: EuroCup history translated onto
the EuroLeague scale, minutes shrunk then tapered past the rotation, a role-conditional
PIR-per-minute prior, an age decline curve on the model term, then a blend with last
season's actual output.

One thing production has that this cannot: prices. Historical fantasy prices do not
exist anywhere, so here the minutes prior is a positional mean rather than the
price-implied role. That makes this a conservative estimate of the live model.

Target is PIR per *team game* -- a DNP counts as zero, which is what it costs you.
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
dim = pd.read_parquet(config.DATA / "players_dim.parquet").set_index("player_id")
TARGETS = ["E2022", "E2023", "E2024", "E2025"]
rows = []

for target in TARGETS:
    year = int(target[1:])
    past = pg[pg.season.str[1:].astype(int) < year]
    past_el = past[past.competition == "E"]
    fut = pg[pg.season == target]

    team_games = fut.groupby("team_code").gamecode.nunique()
    actual = fut.groupby("player_id").agg(
        pir=("pir", "sum"), team=("team_code", lambda s: s.mode().iat[0])).reset_index()
    actual["y"] = actual.pir / actual.team.map(team_games)

    agg = P.weighted_history(past, year).set_index("player_id")
    df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])

    prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
    raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)
    minutes = P.taper_by_position(raw, df.team, df.position,
                                  rank_curve=P.minutes_by_rank(past_el))
    rate_curve = P.fit_rate_by_minutes(past_el)
    rate = P.shrink(df.w_pir, df.w_min,
                    pd.Series(rate_curve(minutes), index=df.index), P.K_MINUTES)
    model = minutes * rate

    age = ((pd.Timestamp(f"{year}-10-01")
            - pd.to_datetime(dim.birth_date.reindex(df.player_id).values)).days / 365.25)
    model = model * P.age_multiplier(pd.Series(age, index=df.index), raw)

    prev = pg[pg.season == f"E{year-1}"]
    ptg = prev.groupby("team_code").gamecode.nunique()
    pa = prev.groupby("player_id").agg(p=("pir", "sum"),
                                       team=("team_code", lambda s: s.mode().iat[0]))
    last_pg = (pa.p / pa.team.map(ptg)).reindex(df.player_id)
    last = pd.Series(last_pg.values, index=df.index)

    df["A_last_season"] = last
    df["B_weighted_avg"] = df.w_pir / df.w_games
    df["C_model_only"] = model
    df["D_shipped"] = np.where(last.notna(),
                               P.BLEND_MODEL * model + (1 - P.BLEND_MODEL) * last.fillna(0), model)

    for name in ["A_last_season", "B_weighted_avg", "C_model_only", "D_shipped"]:
        ok = df[name].notna()
        err = df.loc[ok, name] - df.loc[ok, "y"]
        rows.append({"target": target, "method": name, "n": int(ok.sum()),
                     "MAE": err.abs().mean(), "RMSE": np.sqrt((err ** 2).mean()),
                     "bias": err.mean(),
                     "spearman": spearmanr(df.loc[ok, name], df.loc[ok, "y"]).statistic})

r = pd.DataFrame(rows)
print("=== MAE per held-out season ===")
print(r.pivot_table(index="method", columns="target", values="MAE").round(3).to_string())

# Like-for-like: score every method on the players the baseline can also score.
print("\n=== pooled, all players each method can score ===")
s = r.groupby("method").agg(n=("n", "sum"), MAE=("MAE", "mean"), RMSE=("RMSE", "mean"),
                            bias=("bias", "mean"), spearman=("spearman", "mean"))
print(s.round(3).sort_values("MAE").to_string())
base, ship = s.loc["A_last_season", "MAE"], s.loc["D_shipped", "MAE"]
print(f"\nshipped model vs last-season baseline: {(base - ship) / base:+.1%} MAE"
      f"  ({base:.3f} -> {ship:.3f})")
print(f"coverage: baseline scores {int(s.loc['A_last_season','n'])} player-seasons, "
      f"shipped scores {int(s.loc['D_shipped','n'])}")
