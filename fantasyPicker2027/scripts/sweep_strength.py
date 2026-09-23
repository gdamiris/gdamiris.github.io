"""Should club strength come from past results, or from who is actually on the roster?

Historical margin ignores that a club may have lost its three best players. Rating a
club by the summed projected output of its current squad should handle turnover -- but
that is a claim to test, not assume. For each held-out season we build both ratings
from pre-season data only, and score them against the club's actual margin that season.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import pearsonr

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
import flp.projections as P

pg = pd.read_parquet(config.DATA / "player_game.parquet")
cg = pd.read_parquet(config.DATA / "coach_game.parquet")
TARGETS = ["E2022", "E2023", "E2024", "E2025"]

rows = []
for target in TARGETS:
    year = int(target[1:])
    past_p = pg[pg.season.astype(str) < target]
    past_c = cg[cg.season.astype(str) < target]
    fut_p, fut_c = pg[pg.season == target], cg[cg.season == target]

    actual = fut_c.groupby("team_code").margin.mean()

    # (a) historical margin strength -- what we ship today
    hist = P.team_strength(past_c, year)

    # (b) roster quality: project each player from pre-season data, sum by his
    #     actual club that season
    agg = P.weighted_history(past_p, year).set_index("player_id")
    roster = fut_p.groupby("player_id").team_code.agg(lambda s: s.mode().iat[0])
    df = pd.DataFrame({"team": roster}).join(agg, how="inner").dropna(subset=["w_min"])
    prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
    mins = P.shrink(df.w_min, df.w_games, prior_min, P.K_GAMES)
    mins = P.taper_fringe_minutes(mins, df.team)
    rc = P.fit_rate_by_minutes(past_p)
    rate = P.shrink(df.w_pir, df.w_min, pd.Series(rc(mins), index=df.index), P.K_MINUTES)
    quality = (mins * rate).groupby(df.team).sum()

    teams = sorted(set(actual.index) & set(hist.index) & set(quality.index))
    a = actual.reindex(teams)
    h = hist.reindex(teams)
    q = quality.reindex(teams)
    qz = (q - q.mean()) / q.std()
    hz = (h - h.mean()) / h.std()

    rows.append({"season": target, "n": len(teams),
                 "hist_margin": pearsonr(h, a).statistic,
                 "roster_quality": pearsonr(q, a).statistic,
                 "blend_50": pearsonr(0.5 * hz + 0.5 * qz, a).statistic,
                 "blend_65_roster": pearsonr(0.35 * hz + 0.65 * qz, a).statistic})

r = pd.DataFrame(rows)
print(r.round(3).to_string(index=False))
print("\nmean correlation with actual club margin:")
print(r[["hist_margin", "roster_quality", "blend_50", "blend_65_roster"]].mean().round(3).sort_values(ascending=False).to_string())
