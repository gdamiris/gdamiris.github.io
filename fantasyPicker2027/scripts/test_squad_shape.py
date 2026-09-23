"""Is a barbell squad (five premium starters, five minimum-price bench) actually right?

The optimiser produces one because bench players score 50%, so the cheapest legal
bench maximises credits available for the starters. But that objective assumes the
lineup is fixed for the round. It is not: between Turn 1 and Turn 2 you may promote a
bench player who has not yet tipped off, which gives a good Turn 2 bench real option
value the objective never prices.

So: build squads under a minimum-price floor, then simulate the round properly --
including the swap -- and see which shape actually wins.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.optimize import optimise_squad

RNG = np.random.default_rng(7)
N = 40_000
SD_SLOPE, SD_INT = 0.342, 3.71   # fitted on 2023-25: game-to-game SD of PIR

proj = pd.read_csv(config.DATA / "projections" / "round01.csv")
proj["name"] = (proj.first_name.fillna("") + " " + proj.last_name.fillna("")).str.strip()
proj["fixture"] = proj.apply(lambda r: "-".join(sorted([str(r.team_abbr), str(r.opponent_abbr)])), axis=1)

sched = json.loads((config.DATA / "schedule.json").read_text())
md = next(m for m in sched["matchdays"] if m["number"] == 1)
turn = {}
for r in md["rounds"]:
    for m in r["matches"]:
        for s in ("home_team", "away_team"):
            turn[m[s]["abbreviation"]] = r["number"]
proj["turn"] = proj.team_abbr.map(turn)

players = proj[proj.position != "Head Coach"]
coaches = proj[proj.position == "Head Coach"]


def simulate(squad, coach, use_swap):
    """One round, N draws. Returns realised totals."""
    p = squad.reset_index(drop=True)
    mu = p.proj.values
    sd = np.maximum(1.5, SD_SLOPE * np.abs(mu) + SD_INT)
    draws = RNG.normal(mu[None, :], sd[None, :], size=(N, len(p)))

    start = p.starter.values.copy()
    capt = p.captain.values
    t = p.turn.values
    pos = p.position.values

    field = np.repeat(start[None, :], N, axis=0)

    if use_swap:
        # After Turn 1 you know what your T1 starters scored, and may promote a bench
        # player who has not played. Swapping a starter to the bench halves his score,
        # so the rule is: promote if the bench player's expectation beats the
        # starter's ACTUAL. Same position keeps the formation legal.
        for position in ("Guard", "Forward", "Center"):
            s_idx = np.where(start & (t == 1) & (pos == position))[0]
            b_idx = np.where(~start & (t == 2) & (pos == position))[0]
            if len(s_idx) == 0 or len(b_idx) == 0:
                continue
            b_sorted = b_idx[np.argsort(-mu[b_idx])]
            for b in b_sorted:
                # weakest eligible starter this draw
                acts = np.where(field[:, s_idx], draws[:, s_idx], np.inf)
                worst = np.argmin(acts, axis=1)
                worst_i = s_idx[worst]
                worst_val = acts[np.arange(N), worst]
                do = (mu[b] > worst_val) & ~field[:, b]
                field[do, b] = True
                field[do, worst_i[do]] = False

    weight = np.where(field, 1.0, 0.5) + np.where(capt[None, :] & field, 1.0, 0.0)
    return (draws * weight).sum(axis=1) + coach.proj


rows = []
for floor in (4.0, 5.0, 6.0, 7.0, 8.0, 9.0):
    pool = players[players.price >= floor]
    try:
        res = optimise_squad(pool, coaches)
    except Exception as e:
        print(f"  floor {floor}: infeasible ({e})")
        continue
    sq, coach = res["players"], res["coach"]
    sq = sq.assign(turn=sq.team_abbr.map(turn))
    base = simulate(sq, coach, use_swap=False)
    swap = simulate(sq, coach, use_swap=True)
    bench = sq[~sq.starter]
    rows.append({
        "min_price": floor,
        "bench_spend": round(bench.price.sum(), 1),
        "starter_spend": round(sq[sq.starter].price.sum(), 1),
        "static_ev": round(base.mean(), 1),
        "with_swap": round(swap.mean(), 1),
        "swap_gain": round(swap.mean() - base.mean(), 2),
        "p10": round(np.percentile(swap, 10), 1),
        "p90": round(np.percentile(swap, 90), 1),
        "sd": round(swap.std(), 1),
        "bench_t2": int(((~sq.starter) & (sq.turn == 2)).sum()),
    })

r = pd.DataFrame(rows)
print("Each row is the best squad buildable with no player under `min_price`.\n")
print(r.to_string(index=False))
print("\nstatic_ev = what the optimiser maximises (lineup fixed)")
print("with_swap = the same squad played properly, promoting bench off Turn 1 results")
best_static = r.loc[r.static_ev.idxmax()]
best_swap = r.loc[r.with_swap.idxmax()]
print(f"\nbest by the optimiser's own objective: floor {best_static.min_price} ({best_static.static_ev})")
print(f"best once the Turn swap is played:     floor {best_swap.min_price} ({best_swap.with_swap})")

# ---------------------------------------------------------------------------
# Two objections to the barbell, tested.
print("\n" + "=" * 78)
print("OBJECTION 1: the cheap bench is wasted because it is all in Turn 1.")
print("Force every sub-6cr pick to be a Turn 2 club, so the bench is swappable.\n")
variants = {
    "barbell, as optimised": players[players.price >= 4.0],
    "barbell, cheap picks must be T2": players[(players.price >= 6.0) | (players.turn == 2)],
    "balanced (nothing under 7cr)": players[players.price >= 7.0],
}
keep = {}
for label, pool in variants.items():
    res = optimise_squad(pool, coaches)
    sq = res["players"].assign(turn=lambda d: d.team_abbr.map(turn))
    keep[label] = (sq, res["coach"])
    base, swap = simulate(sq, res["coach"], False), simulate(sq, res["coach"], True)
    bt2 = int(((~sq.starter) & (sq.turn == 2)).sum())
    print(f"  {label:<34} static {base.mean():6.1f} | swap {swap.mean():6.1f} "
          f"(+{swap.mean()-base.mean():.2f}) | bench in T2: {bt2}/5")

print("\n" + "=" * 78)
print("OBJECTION 2: if a starter is ruled out late, a 4cr bench cannot cover him.")
print("Knock out the top starter (scores 0) and replay the round.\n")
for label, (sq, coach) in keep.items():
    p = sq.reset_index(drop=True)
    hurt = p.proj.idxmax()
    p2 = p.copy()
    p2.loc[hurt, "proj"] = 0.0
    # the manager reacts: promote the best bench player of that position
    same = p2[(~p2.starter) & (p2.position == p2.loc[hurt, "position"])]
    if len(same):
        promote = same.proj.idxmax()
        p2.loc[promote, "starter"] = True
        p2.loc[hurt, "starter"] = False
        if p2.loc[hurt, "captain"]:
            p2.loc[hurt, "captain"] = False
            p2.loc[p2[p2.starter].proj.idxmax(), "captain"] = True
    out = simulate(p2, coach, True)
    full = simulate(p, coach, True)
    print(f"  {label:<34} full {full.mean():6.1f} -> without top starter {out.mean():6.1f} "
          f"({out.mean()-full.mean():+.1f}, {(out.mean()-full.mean())/full.mean():+.1%})")
