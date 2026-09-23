"""Does opponent defence BY POSITION beat a single overall defensive rating?

Today the model scales a projection by how many points the opponent concedes overall.
But clubs are not uniformly leaky: Real Madrid gave up 0.79x the league average to
centres while conceding normally to guards. If a club's positional weakness persists
year to year -- it does, r=+0.59 for guards -- then a centre facing Madrid and a guard
facing Madrid should not get the same adjustment.

Ratings are always built from PRIOR seasons only.
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

pg = pd.read_parquet(config.DATA / "player_game.parquet")
e = pg[(pg.competition == "E") & pg.position.notna()].copy()
e["year"] = e.season.str[1:].astype(int)


def ratings_before(year):
    """Positional concede ratio and overall points allowed, from seasons before `year`."""
    past = e[e.year < year]
    if past.empty:
        return None, None
    conc = past.groupby(["season", "gamecode", "opp_code", "position"]).pir.sum().reset_index()
    per = conc.groupby(["opp_code", "position"]).pir.mean().unstack()
    pos_ratio = (per / per.mean()).stack().rename("pos_ratio")
    tot = past.groupby(["season", "gamecode", "opp_code"]).pir.sum().reset_index()
    overall = tot.groupby("opp_code").pir.mean()
    overall_ratio = (overall / overall.mean()).rename("overall_ratio")
    return pos_ratio, overall_ratio


rows = []
for year in (2022, 2023, 2024, 2025):
    pos_ratio, overall_ratio = ratings_before(year)
    if pos_ratio is None:
        continue
    cur = e[e.year == year].copy()
    own = cur.groupby(["season", "player_id"]).pir.transform("mean")
    cur = cur[own > 3]
    cur["rel"] = cur.pir - own[own > 3]
    cur["pos_r"] = pd.MultiIndex.from_arrays(
        [cur.opp_code, cur.position]).map(pos_ratio)
    cur["ovr_r"] = cur.opp_code.map(overall_ratio)
    # positional weakness RELATIVE to the club's own overall defence
    cur["pos_resid"] = cur.pos_r / cur.ovr_r
    cur["own"] = own[own > 3]
    rows.append(cur.dropna(subset=["pos_r", "ovr_r"]))

d = pd.concat(rows)
print(f"{len(d):,} player-games scored against prior-season ratings\n")

for label, col in (("overall defence (what we use)", "ovr_r"),
                   ("positional defence (raw)", "pos_r"),
                   ("positional RESIDUAL vs own defence", "pos_resid")):
    q = pd.qcut(d[col], 5, labels=["stingiest", "2", "3", "4", "leakiest"])
    g = d.groupby(q, observed=True).rel.mean()
    print(f"  {label:<36} spread stingiest->leakiest: {g.iloc[-1] - g.iloc[0]:+.3f} PIR")

# Does positional add anything ON TOP of overall?
import numpy.linalg as la
X = np.column_stack([np.ones(len(d)), d.ovr_r.values, d.pos_resid.values])
beta, *_ = la.lstsq(X, d.rel.values, rcond=None)
print(f"\n  joint fit (overall + residual):  overall coefficient {beta[1]:+.3f} | positional coefficient {beta[2]:+.3f}")
X1 = np.column_stack([np.ones(len(d)), d.ovr_r.values])
b1, *_ = la.lstsq(X1, d.rel.values, rcond=None)
r2_1 = 1 - ((d.rel.values - X1 @ b1) ** 2).sum() / ((d.rel.values - d.rel.mean()) ** 2).sum()
r2_2 = 1 - ((d.rel.values - X @ beta) ** 2).sum() / ((d.rel.values - d.rel.mean()) ** 2).sum()
print(f"  variance explained: overall alone {r2_1*100:.3f}%  ->  with positional {r2_2*100:.3f}%")
print(f"\n  scaled to a 15-PIR player, the positional term is worth "
      f"{beta[2] * (d.pos_resid.quantile(.9) - d.pos_resid.quantile(.1)):+.2f} PIR "
      f"between a soft and a hard matchup")
