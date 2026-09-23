"""Pick the optimal squad for a round from data/projections/roundNN.csv."""
import argparse
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.optimize import optimise_squad

ap = argparse.ArgumentParser()
ap.add_argument("--round", type=int, default=1)
ap.add_argument("--budget", type=float, default=100.0)
ap.add_argument("--leverage", type=float, default=0.0,
                help="0 = ignore ownership; 0.3 = favour differentials; negative = hug the field")
ap.add_argument("--min-confidence", type=float, default=0.0,
                help="drop players whose history support is below this")
args = ap.parse_args()

hz = config.DATA / "projections" / f"round{args.round:02d}_horizon.csv"
proj = pd.read_csv(hz if hz.exists() else
                   config.DATA / "projections" / f"round{args.round:02d}.csv")
if "proj_horizon" in proj.columns:
    proj["proj_hold"] = proj.proj_horizon.fillna(proj.proj)
    print(f"planning over the horizon: squad valued on rounds "
          f"{args.round}-{args.round + 5}, lineup on round {args.round}")
proj["name"] = proj.last_name.fillna("") + ", " + proj.first_name.fillna("")
import json as _json
_sched = _json.loads((config.DATA / "schedule.json").read_text())
_md = next(m for m in _sched["matchdays"] if m["number"] == args.round)
_turn = {}
for _r in _md["rounds"]:
    for _m in _r["matches"]:
        for _s in ("home_team", "away_team"):
            _turn[_m[_s]["abbreviation"]] = _r["number"]
proj["turn"] = proj.team_abbr.map(_turn)

proj["fixture"] = proj.apply(
    lambda r: "-".join(sorted([str(r.team_abbr), str(r.opponent_abbr)])), axis=1)
players = proj[proj.position != "Head Coach"].copy()
coaches = proj[proj.position == "Head Coach"].copy()

if args.min_confidence > 0:
    keep = players.confidence.fillna(0) >= args.min_confidence
    print(f"confidence filter >= {args.min_confidence}: {keep.sum()}/{len(players)} players kept")
    players = players[keep]

res = optimise_squad(players, coaches, budget=args.budget, ownership_weight=args.leverage)
sq, coach = res["players"], res["coach"]

print(f"\n=== ROUND {args.round} SQUAD  |  cost {res['cost']:.1f}/{args.budget:.0f} cr"
      f"  |  expected {res['expected']:.1f} pts ===")
print(f"formation (G-F-C): {'-'.join(map(str, res['formation']))}\n")

show = ["name", "position", "team_abbr", "opponent", "turn", "price",
        "last_pir_pg", "confidence", "p_win", "proj", "proj_hold"]
for label, sel in (("STARTING FIVE (100%)", sq.starter),
                   ("SIXTH MAN (100%)", sq.sixth),
                   ("BENCH (50% scoring)", ~sq.starter & ~sq.sixth)):
    blk = sq[sel].copy()
    blk["name"] = blk.apply(lambda r: r["name"] + ("  (C)" if r.captain else ""), axis=1)
    print(f"--- {label} ---")
    print(blk[show].round(2).to_string(index=False))
    print()
print("--- HEAD COACH ---")  # noqa: shown with horizon value
print(coach[["name", "team_abbr", "opponent", "price", "exp_margin", "proj"]].to_frame().T.round(2).to_string(index=False))

starters = sq[sq.starter].proj.sum()
sixth = sq[sq.sixth].proj.sum()
bench = sq[~sq.starter & ~sq.sixth].proj.sum()
cap = sq[sq.captain].proj.sum()
total = starters + sixth + cap + bench * 0.5 + coach.proj
print(f"\nbreakdown: starters {starters:.1f} + sixth man {sixth:.1f} + captain bonus {cap:.1f} "
      f"+ bench {bench:.1f}x0.5 = {bench*0.5:.1f} + coach {coach.proj:.1f}  =>  {total:.1f}")
print(f"club counts:   {dict(sq.team_abbr.value_counts())}")
print(f"fixture counts: {dict(sq.fixture.value_counts())}  (cap 3 per game)")
