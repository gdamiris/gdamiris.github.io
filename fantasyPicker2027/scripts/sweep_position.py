"""Does allocating minutes per club-and-position beat allocating per club?"""
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

MODES = {
    "club": lambda raw, df: P.taper_fringe_minutes(raw, df.team),
    "position": lambda raw, df: P.taper_by_position(raw, df.team, df.position),
    "pos-rank/club-cap": lambda raw, df: P.taper_by_position(raw, df.team, df.position, cap="club"),
    "centres only": lambda raw, df: P.taper_by_position(
        P.taper_fringe_minutes(raw, df.team), df.team, df.position,
        cap="position", scarce_only=True),
}


def run(mode):
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
        mins = MODES[mode](raw, df)
        rc = P.fit_rate_by_minutes(past[past.competition=="E"])
        rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(mins), index=df.index), P.K_MINUTES)
        model = mins * rate
        age = ((pd.Timestamp(f"{year}-10-01") - pd.to_datetime(
            dim.birth_date.reindex(df.player_id).values)).days / 365.25)
        model = model * P.age_multiplier(pd.Series(age, index=df.index))
        prev = pg[pg.season==f"E{year-1}"].groupby("player_id").agg(g=("player_id","size"), p=("pir","sum"))
        last = pd.Series((prev.p/prev.g).reindex(df.player_id).values, index=df.index)
        pred = np.where(last.notna(), P.BLEND_MODEL*model + (1-P.BLEND_MODEL)*last.fillna(0), model)
        maes.append(np.abs(pred-df.y).mean()); sps.append(spearmanr(pred, df.y).statistic)
    return float(np.mean(maes)), float(np.mean(sps))

for mode in MODES:
    mae, sp = run(mode)
    print(f"  {mode:<20} MAE={mae:.4f}  spearman={sp:.4f}")

# by position, where does it help most?
print("\nper-position error, club-level vs position-level:")
for mode in MODES:
    per = {}
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
        mins = MODES[mode](raw, df)
        rc = P.fit_rate_by_minutes(past[past.competition=="E"])
        rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(mins), index=df.index), P.K_MINUTES)
        model = mins*rate
        age = ((pd.Timestamp(f"{year}-10-01") - pd.to_datetime(
            dim.birth_date.reindex(df.player_id).values)).days/365.25)
        model = model*P.age_multiplier(pd.Series(age, index=df.index))
        prev = pg[pg.season==f"E{year-1}"].groupby("player_id").agg(g=("player_id","size"), p=("pir","sum"))
        last = pd.Series((prev.p/prev.g).reindex(df.player_id).values, index=df.index)
        pred = pd.Series(np.where(last.notna(), P.BLEND_MODEL*model+(1-P.BLEND_MODEL)*last.fillna(0), model), index=df.index)
        for pos, g in df.groupby("position"):
            per.setdefault(pos, []).append(np.abs(pred[g.index]-g.y).mean())
    print(f"  {mode:<9}", {k: round(float(np.mean(v)),3) for k,v in sorted(per.items())})
