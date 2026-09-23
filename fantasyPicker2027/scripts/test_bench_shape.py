"""Barbell vs balanced bench, simulated against REAL outcome distributions.

The first version of this test drew every player from a normal, which quietly handed
minimum-price fringe players a symmetric spread they do not have. Reality: a player
in a sub-6-minute role sits out 44% of games and scores zero or worse in 73% of them,
with a thin tail of useful nights. Same mean, completely different shape -- and shape
is what decides the Turn-swap option and the downside.

So here each player's outcomes are bootstrapped from the actual game-by-game PIR of
historical players in the same role, rescaled to match his projection.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.optimize import optimise_squad

RNG = np.random.default_rng(11)
N = 40_000

pg = pd.read_parquet(config.DATA / "player_game.parquet")
e = pg[(pg.competition == "E") & pg.season.isin(["E2023", "E2024", "E2025"])].copy()
role = e.groupby(["season", "player_id"]).agg(mpg=("minutes", "mean"), n=("pir", "size")).reset_index()
e = e.merge(role[role.n >= 15][["season", "player_id", "mpg"]], on=["season", "player_id"])
EDGES = [0, 6, 10, 14, 18, 22, 99]
e["b"] = pd.cut(e.mpg, EDGES, labels=False)
POOLS = {int(b): g.pir.values.astype(float) for b, g in e.groupby("b")}
MEANS = {b: v.mean() for b, v in POOLS.items()}

proj = pd.read_csv(config.DATA / "projections" / "round01.csv")
proj["name"] = (proj.first_name.fillna("") + " " + proj.last_name.fillna("")).str.strip()
proj["fixture"] = proj.apply(lambda r: "-".join(sorted([str(r.team_abbr), str(r.opponent_abbr)])), axis=1)
sched = json.loads((config.DATA / "schedule.json").read_text())
md = next(m for m in sched["matchdays"] if m["number"] == 1)
turn = {}
for r_ in md["rounds"]:
    for m_ in r_["matches"]:
        for s_ in ("home_team", "away_team"):
            turn[m_[s_]["abbreviation"]] = r_["number"]
proj["turn"] = proj.team_abbr.map(turn)
players = proj[proj.position != "Head Coach"]
coaches = proj[proj.position == "Head Coach"]


def draw(minutes, target_mean):
    """Bootstrap real outcomes for a player of this role, rescaled to his projection."""
    b = int(np.clip(np.digitize(minutes, EDGES) - 1, 0, len(EDGES) - 2))
    pool = POOLS[b]
    scale = target_mean / MEANS[b] if MEANS[b] > 0.25 else 1.0
    return RNG.choice(pool, size=N, replace=True) * scale


def simulate(sq, coach, use_swap=True):
    p = sq.reset_index(drop=True)
    draws = np.column_stack([draw(r.minutes_pg, r.proj) for r in p.itertuples()])
    # Six slots score in full: the starting five plus the sixth man.
    full = (p.starter | p.sixth).values.copy()
    capt, t, pos = p.captain.values, p.turn.values, p.position.values
    field = np.repeat(full[None, :], N, axis=0)
    start = full
    mu = p.proj.values
    if use_swap:
        for position in ("Guard", "Forward", "Center"):
            s_idx = np.where(start & (t == 1) & (pos == position))[0]
            b_idx = np.where(~start & (t == 2) & (pos == position))[0]
            if not len(s_idx) or not len(b_idx):
                continue
            for b in b_idx[np.argsort(-mu[b_idx])]:
                acts = np.where(field[:, s_idx], draws[:, s_idx], np.inf)
                w = np.argmin(acts, axis=1)
                wi, wv = s_idx[w], acts[np.arange(N), w]
                do = (mu[b] > wv) & ~field[:, b]
                field[do, b] = True
                field[do, wi[do]] = False
    # The armband can also move between Turns, to anyone who has not tipped off. If the
    # Turn 1 captain flops you switch to the best full-scoring player still to play. This
    # was measured at +1.2 to +5.7 a round and was missing from the distribution.
    cap_extra = np.zeros(N)
    ci = np.where(capt)[0]
    if len(ci) and use_swap:
        c0 = ci[0]
        alt = [i for i in range(len(p))
               if field[:, i].any() and t[i] is not None and t[i] > t[c0]]
        if alt:
            best_alt = max(alt, key=lambda i: mu[i])
            keep = draws[:, c0]
            switch = mu[best_alt]
            cap_extra = np.where(switch > keep, draws[:, best_alt], keep)
        else:
            cap_extra = draws[:, c0]
    elif len(ci):
        cap_extra = draws[:, ci[0]]

    weight = np.where(field, 1.0, 0.5)
    return (draws * weight).sum(axis=1) + cap_extra + coach.proj


ALL = players[players.price >= 4.0]
shapes = [("baseline: cheap bench, 6-per-club", ALL, dict(min_quality_bench=0))]
for c in (2, 3):
    shapes.append((f"max {c} per CLUB", ALL, dict(min_quality_bench=0, max_per_club=c)))
for b in (3.0, 4.0, 5.0, 6.0):
    shapes.append((f"bench avg >= {b:.0f} proj", ALL, dict(min_quality_bench=0, min_bench_proj=b)))
shapes.append(("max 3/club + bench >=4", ALL,
               dict(min_quality_bench=0, max_per_club=3, min_bench_proj=4.0)))
_old = [
]
rows = []
for label, pool, kw in shapes:
    res = optimise_squad(pool, coaches, **kw)
    sq = res["players"].assign(turn=lambda d: d.team_abbr.map(turn))
    tot = simulate(sq, res["coach"])
    bench = sq[~sq.starter & ~sq.sixth]
    nclub = sq.team_abbr.nunique()
    rows.append({
        "shape": label, "bench_spend": round(bench.price.sum(), 1),
        "mean": round(tot.mean(), 1), "median": round(np.median(tot), 1),
        "p10": round(np.percentile(tot, 10), 1), "p25": round(np.percentile(tot, 25), 1),
        "p75": round(np.percentile(tot, 75), 1), "p90": round(np.percentile(tot, 90), 1),
        "sd": round(tot.std(), 1),
        "clubs": nclub,
        "bench_proj": round(float(bench.proj.mean()), 1),
        "bench_dead_nights": round(float(np.mean([
            (draw(r.minutes_pg, r.proj) <= 0).mean() for r in bench.itertuples()])), 2),
        "best_bench": f"{bench.nlargest(1,'proj').iloc[0]['name'].split()[-1]} {bench.proj.max():.1f}",
        "T2_bench": int((bench.turn == 2).sum()),
    })
print("Bootstrapped from real game outcomes, Turn-swap played optimally.\n")
print(pd.DataFrame(rows).to_string(index=False))
print("\nbench_dead_nights = share of games a typical bench pick scores zero or worse")


# ---------------------------------------------------------------------------
# The honest answer is a distribution, not a point estimate. A single number
# invites the question "so you predict a bad day?" when the truth is that a
# round is a wide draw and the bands are outcomes, not forecasts.
res = optimise_squad(players[players.price >= 4.0], coaches, min_quality_bench=0)
sq = res["players"].assign(turn=lambda d: d.team_abbr.map(turn))
t = pd.Series(simulate(sq, res["coach"]))
BANDS = [("Excellent 200+", 200, 1e9), ("Very good 160-200", 160, 200),
         ("OK 130-160", 130, 160), ("Bad day under 130", -1e9, 130)]
print("\n=== the squad's actual score distribution ===")
for lbl, lo, hi in BANDS:
    pr = float(((t >= lo) & (t < hi)).mean())
    print(f"  {lbl:<20}{pr*100:>5.1f}%  {'#' * int(round(pr * 50))}")
print(f"\n  mean {t.mean():.0f} | median {t.median():.0f} | sd {t.std():.0f}")
for thr in (130, 160, 200):
    print(f"  P({thr}+) = {float((t >= thr).mean())*100:.0f}%")
import json as _json
_json.dump({"bands": [{"label": l, "p": round(float(((t >= lo) & (t < hi)).mean()), 3)}
                      for l, lo, hi in BANDS],
            "mean": round(float(t.mean()), 1), "median": round(float(t.median()), 1),
            "sd": round(float(t.std()), 1),
            "p130": round(float((t >= 130).mean()), 3),
            "p160": round(float((t >= 160).mean()), 3),
            "p200": round(float((t >= 200).mean()), 3)},
           open(config.DATA / "score_distribution.json", "w"), indent=1)
