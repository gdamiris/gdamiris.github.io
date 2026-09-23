"""Is one global age slope over-penalising elite players?

A single slope has to serve two very different populations: fringe veterans who fall
out of rotations, and elite players who age gracefully on big minutes. If the fitted
slope is really tracking the first group, it is quietly taking a third off the best
players in the league -- which would show up as systematic under-projection.
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


def run(slope_big, slope_small, split=20.0, peak=25.0):
    maes, sps, biases = [], [], []
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
        mins = P.taper_by_position(raw, df.team, df.position)
        rc = P.fit_rate_by_minutes(past[past.competition=="E"])
        rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(mins), index=df.index), P.K_MINUTES)
        model = mins * rate
        age = pd.Series(((pd.Timestamp(f"{year}-10-01") - pd.to_datetime(
            dim.birth_date.reindex(df.player_id).values)).days / 365.25),
            index=df.index).fillna(27.0)
        slope = np.where(mins >= split, slope_big, slope_small)
        model = model * np.clip(1 + np.where(age > peak, slope * (age - peak), 0.0), 0.35, 1.6)
        prev = pg[pg.season==f"E{year-1}"].groupby("player_id").agg(g=("player_id","size"), p=("pir","sum"))
        last = pd.Series((prev.p/prev.g).reindex(df.player_id).values, index=df.index)
        pred = np.where(last.notna(), P.BLEND_MODEL*model + (1-P.BLEND_MODEL)*last.fillna(0), model)
        maes.append(np.abs(pred-df.y).mean()); sps.append(spearmanr(pred, df.y).statistic)
        biases.append((pred - df.y).mean())
    return float(np.mean(maes)), float(np.mean(sps)), float(np.mean(biases))

print("split at 20 min: big-role players vs everyone else")
print(f"{'big':>6} {'small':>7}   {'MAE':>7} {'spearman':>9} {'bias':>7}")
best=None
for sb in (0.0, -0.01, -0.02, -0.03, -0.05):
    for ss in (-0.03, -0.05, -0.07):
        mae, sp, bias = run(sb, ss)
        tag = ""
        if best is None or mae < best[0]:
            best = (mae, sb, ss); tag = "  <-- best"
        print(f"{sb:>6.2f} {ss:>7.2f}   {mae:7.4f} {sp:9.4f} {bias:+7.3f}{tag}")
print(f"\ncurrent single slope -0.05 for everyone:")
mae, sp, bias = run(-0.05, -0.05)
print(f"                      {mae:7.4f} {sp:9.4f} {bias:+7.3f}")
