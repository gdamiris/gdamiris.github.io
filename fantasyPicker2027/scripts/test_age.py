"""Does age add signal beyond minutes and rate? Test before shipping it."""
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

def run(age_adjust):
    maes, sps = [], []
    for target in TARGETS:
        year = int(target[1:])
        past = pg[pg.season.str[1:].astype(int) < year]
        fut = pg[pg.season == target]
        tg = fut.groupby("team_code").gamecode.nunique()
        actual = fut.groupby("player_id").agg(
            pir=("pir","sum"), team=("team_code", lambda s: s.mode().iat[0])).reset_index()
        actual["y"] = actual.pir / actual.team.map(tg)
        agg = P.weighted_history(past, year).set_index("player_id")
        df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])
        prior_min = (df.w_min/df.w_games).groupby(df.position).transform("mean")
        raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)
        mins = P.taper_fringe_minutes(raw, df.team)
        rc = P.fit_rate_by_minutes(past[past.competition=="E"])
        rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(mins), index=df.index), P.K_MINUTES)
        model = mins * rate
        if age_adjust is not None:
            bd = dim.birth_date.reindex(df.player_id).values
            age = (pd.Timestamp(f"{year}-10-01") - pd.to_datetime(bd)).days / 365.25
            age = pd.Series(age, index=df.index).fillna(27.0)
            if isinstance(age_adjust, tuple):
                peak, slope_old, slope_young = age_adjust
                delta = np.where(age > peak, slope_old * (age - peak),
                                 slope_young * (age - peak))
                model = model * np.clip(1 + delta, 0.35, 1.6)
            else:
                model = model * np.clip(1 + age_adjust * (age - 27.0), 0.35, 1.6)
        prev = pg[pg.season==f"E{year-1}"].groupby("player_id").agg(g=("player_id","size"), p=("pir","sum"))
        last = (prev.p/prev.g).reindex(df.player_id).values
        pred = np.where(pd.notna(last), P.BLEND_MODEL*model + (1-P.BLEND_MODEL)*np.nan_to_num(last), model)
        maes.append(np.abs(pred-df.y).mean()); sps.append(spearmanr(pred, df.y).statistic)
    return float(np.mean(maes)), float(np.mean(sps))

print("=== linear: fractional change per year away from 27 ===")
for a in [None, -0.030, -0.040, -0.050, -0.060, -0.075]:
    mae, sp = run(a)
    print(f"  {'no age term' if a is None else f'slope {a:+.3f}':<16} MAE={mae:.4f}  spearman={sp:.4f}")

print("\n=== piecewise: (peak age, slope above peak, slope below peak) ===")
best = None
for peak in (25, 27, 29):
    for so in (-0.03, -0.05, -0.07):
        for sy in (0.0, -0.02, -0.05):
            mae, sp = run((peak, so, sy))
            if best is None or mae < best[0]:
                best = (mae, sp, peak, so, sy)
            print(f"  peak {peak}  above {so:+.2f}  below {sy:+.2f}   MAE={mae:.4f}  spearman={sp:.4f}")
print(f"\nbest: peak {best[2]}, above {best[3]:+.2f}, below {best[4]:+.2f} -> MAE {best[0]:.4f}, spearman {best[1]:.4f}")
