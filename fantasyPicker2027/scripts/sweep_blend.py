"""How much should the projection lean on last season's ACTUAL output?

The model term is well-ordered but compressed; last season's realised PIR per round is
correctly scaled but blind to role changes (a player moving onto a stacked roster).
Judge the blend on both: held-out accuracy, and whether the squad it produces lands
in a believable band against the 131-point hindsight benchmark.
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd
from scipy.stats import spearmanr
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
import flp.projections as P

pg = pd.read_parquet(config.DATA / "player_game.parquet")
dim = pd.read_parquet(config.DATA / "players_dim.parquet").set_index("player_id")
TARGETS = ["E2022", "E2023", "E2024", "E2025"]


def accuracy(blend):
    maes, sps, bias = [], [], []
    for target in TARGETS:
        year = int(target[1:])
        past, fut = pg[pg.season.str[1:].astype(int) < year], pg[pg.season == target]
        tg = fut.groupby("team_code").gamecode.nunique()
        actual = fut.groupby("player_id").agg(
            pir=("pir", "sum"), team=("team_code", lambda s: s.mode().iat[0])).reset_index()
        actual["y"] = actual.pir / actual.team.map(tg)
        agg = P.weighted_history(past, year).set_index("player_id")
        df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])
        prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
        raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)
        mins = P.taper_by_position(raw, df.team, df.position,
                                   rank_curve=P.minutes_by_rank(past[past.competition == "E"]))
        rc = P.fit_rate_by_minutes(past[past.competition == "E"])
        rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(mins), index=df.index), P.K_MINUTES)
        model = mins * rate
        age = pd.Series(((pd.Timestamp(f"{year}-10-01") - pd.to_datetime(
            dim.birth_date.reindex(df.player_id).values)).days / 365.25), index=df.index).fillna(27.0)
        slope = np.where(mins >= 20.0, -0.03, -0.05)
        model = model * np.clip(1 + np.where(age > 25, slope * (age - 25), 0.0), 0.35, 1.6)
        prev = pg[pg.season == f"E{year-1}"]
        ptg = prev.groupby("team_code").gamecode.nunique()
        pa = prev.groupby("player_id").agg(pir=("pir", "sum"),
                                           team=("team_code", lambda s: s.mode().iat[0]))
        last = pd.Series((pa.pir / pa.team.map(ptg)).reindex(df.player_id).values, index=df.index)
        pred = np.where(last.notna(), blend * model + (1 - blend) * last.fillna(0), model)
        maes.append(np.abs(pred - df.y).mean())
        sps.append(spearmanr(pred, df.y).statistic)
        bias.append((pred - df.y).mean())
    return float(np.mean(maes)), float(np.mean(sps)), float(np.mean(bias))


print(f"{'blend':>6} {'MAE':>8} {'spearman':>9} {'bias':>8}   (blend = weight on the model term)")
for b in (0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0):
    mae, sp, bi = accuracy(b)
    print(f"{b:>6.2f} {mae:>8.4f} {sp:>9.4f} {bi:>+8.3f}")
