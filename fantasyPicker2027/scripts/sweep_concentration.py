"""Pick CONCENTRATION on two criteria at once: held-out accuracy AND calibration.

Accuracy alone cannot see this problem -- the backtest scores only players with
EuroLeague history, far fewer per club than the fantasy pool, so it never feels the
dilution that flattens the live projections.
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd
from scipy.stats import spearmanr
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
import flp.projections as P
FLOOR = 0.35

pg = pd.read_parquet(config.DATA / "player_game.parquet")
dim = pd.read_parquet(config.DATA / "players_dim.parquet").set_index("player_id")
curve_all = P.minutes_by_rank(pg[pg.competition == "E"], ["E2023", "E2024", "E2025"])
TARGETS = ["E2022", "E2023", "E2024", "E2025"]

# live-pool calibration target
e25 = pg[(pg.competition == "E") & (pg.season == "E2025")]
ACT_MIN = e25.groupby(["gamecode", "team_code"]).apply(
    lambda g: g.nlargest(6, "minutes").minutes.mean(), include_groups=False).mean()
pool = pd.read_csv(config.DATA / "projections" / "round01.csv")
pool = pool[pool.position != "Head Coach"]


def accuracy(conc):
    maes, sps = [], []
    for target in TARGETS:
        year = int(target[1:])
        past, fut = pg[pg.season.str[1:].astype(int) < year], pg[pg.season == target]
        tg = fut.groupby("team_code").gamecode.nunique()
        actual = fut.groupby("player_id").agg(
            pir=("pir","sum"), team=("team_code", lambda s: s.mode().iat[0])).reset_index()
        actual["y"] = actual.pir / actual.team.map(tg)
        agg = P.weighted_history(past, year).set_index("player_id")
        df = actual.join(agg, on="player_id", how="inner").dropna(subset=["w_min"])
        prior_min = (df.w_min/df.w_games).groupby(df.position).transform("mean")
        raw = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)
        mins = P.taper_by_position(raw, df.team, df.position, floor=FLOOR,
                                   rank_curve=P.minutes_by_rank(past[past.competition=="E"]),
                                   concentration=conc)
        rc = P.fit_rate_by_minutes(past[past.competition=="E"])
        rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(mins), index=df.index), P.K_MINUTES)
        model = mins*rate
        age = pd.Series(((pd.Timestamp(f"{year}-10-01") - pd.to_datetime(
            dim.birth_date.reindex(df.player_id).values)).days/365.25), index=df.index).fillna(27.0)
        slope = np.where(mins >= 20.0, -0.03, -0.05)
        model = model * np.clip(1 + np.where(age > 25, slope*(age-25), 0.0), 0.35, 1.6)
        prev = pg[pg.season==f"E{year-1}"].groupby("player_id").agg(g=("player_id","size"), p=("pir","sum"))
        last = pd.Series((prev.p/prev.g).reindex(df.player_id).values, index=df.index)
        pred = np.where(last.notna(), P.BLEND_MODEL*model+(1-P.BLEND_MODEL)*last.fillna(0), model)
        maes.append(np.abs(pred-df.y).mean()); sps.append(spearmanr(pred, df.y).statistic)
    return float(np.mean(maes)), float(np.mean(sps))


def calibration(conc):
    mins = P.taper_by_position(pool.raw_minutes, pool.team_abbr, pool.position,
                               price_minutes=pool.prior_minutes, floor=FLOOR,
                               rank_curve=curve_all, concentration=conc)
    t = pd.DataFrame({"team": pool.team_abbr, "m": mins})
    return t.groupby("team").m.apply(lambda s: s.nlargest(6).mean()).mean()


print(f"target: a club's top six average {ACT_MIN:.1f} minutes in reality\n")
print(f"{'floor':>6} {'conc':>5} {'top6 min':>9} {'MAE':>8} {'spearman':>9}")
for FLOOR in (0.35, 0.20, 0.10, 0.0):
    globals()["FLOOR"] = FLOOR
    for c in (0.0, 0.3):
        mae, sp = accuracy(c)
        print(f"{FLOOR:>6.2f} {c:>5.2f} {calibration(c):>9.1f} {mae:>8.4f} {sp:>9.4f}")
