"""Project every player across a horizon of rounds, not just the next one.

You get four trades a round out of eleven slots, so a squad is a commitment well
beyond Round 1: a player with a soft opener and a brutal following month is worth
less than his Round 1 projection says. The natural horizon is the first
unlimited-trade window after Round 6, where the squad can be rebuilt for free.

Each round is weighted by the chance you still hold the player when it arrives.
With 4 of 11 slots turning over per round that is (7/11)^(r-1) -- Round 1 counts
fully, Round 2 about 64%, Round 6 about 7%.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.projections import MARGIN_SD, expected_coach_points, home_factor, opponent_factor

RETENTION = 7.0 / 11.0   # slots kept per round, given 4 trades

ap = argparse.ArgumentParser()
ap.add_argument("--from-round", type=int, default=1)
ap.add_argument("--horizon", type=int, default=6, help="rounds to plan over (R6 = free reset)")
args = ap.parse_args()

base = pd.read_csv(config.DATA / "projections" / f"round{args.from_round:02d}.csv")
ratings = json.loads((config.DATA / "club_ratings.json").read_text())
strength, pa = ratings["strength"], ratings["points_allowed"]
league_pa, home_adv = ratings["league_pa"], ratings["home_adv"]

sched = json.loads((config.DATA / "schedule.json").read_text())
mds = {m["number"]: m for m in sched["matchdays"]}

fixtures = {}
for n, md in mds.items():
    for rnd in md.get("rounds") or []:
        for m in rnd.get("matches") or []:
            h, a = m["home_team"]["abbreviation"], m["away_team"]["abbreviation"]
            fixtures[(n, h)] = {"opp": a, "home": True, "turn": rnd["number"]}
            fixtures[(n, a)] = {"opp": h, "home": False, "turn": rnd["number"]}

rounds = list(range(args.from_round, args.from_round + args.horizon))
rows = []
for r in rounds:
    d = base.copy()
    fx = d.team_abbr.map(lambda t: fixtures.get((r, t)))
    d["round"] = r
    d["plays"] = fx.notna()
    d["opponent_abbr"] = fx.map(lambda f: f["opp"] if f else None)
    d["home_away"] = fx.map(lambda f: ("home" if f["home"] else "away") if f else None)
    d["turn"] = fx.map(lambda f: f["turn"] if f else None)

    # The player-intrinsic part (minutes, rate, age, blend) is unchanged; only the
    # matchup moves. Undo Round 1's matchup and apply this round's.
    intrinsic = d.proj_pir / (d.opp_factor * d.home_factor).replace(0, np.nan)
    d["opp_pa"] = d.opponent_abbr.map(lambda a: pa.get(a, league_pa))
    d["opp_factor"] = opponent_factor(d.opp_pa, league_pa)
    d["home_factor"] = home_factor(d.home_away.eq("home"))
    d["exp_margin"] = (d.team_abbr.map(lambda t: strength.get(t, 0.0))
                       - d.opponent_abbr.map(lambda a: strength.get(a, 0.0))
                       + np.where(d.home_away.eq("home"), home_adv, -home_adv))
    d["p_win"] = norm.cdf(d.exp_margin / MARGIN_SD)
    d["proj_pir_r"] = intrinsic * d.opp_factor * d.home_factor
    d["proj_r"] = (d.proj_pir_r * (1 + 0.10 * d.p_win)).where(d.plays, 0.0)
    # Coaches score on margin alone, so their round value is the margin integral, not a
    # matchup-scaled PIR. They belong in the horizon too: swapping a coach costs one of
    # your four trades, so he is as much a multi-round commitment as any player.
    is_coach = d.position.eq("Head Coach")
    if is_coach.any():
        d.loc[is_coach, "proj_r"] = [
            expected_coach_points(m) if pl else 0.0
            for m, pl in zip(d.loc[is_coach, "exp_margin"], d.loc[is_coach, "plays"])]
    rows.append(d[["player_id", "first_name", "last_name", "position", "team_abbr", "price",
                   "round", "plays", "opponent_abbr", "home_away", "turn",
                   "opp_factor", "p_win", "proj_r"]])

h = pd.concat(rows, ignore_index=True)
h["weight"] = RETENTION ** (h["round"] - args.from_round)
wsum = h.groupby("player_id").apply(
    lambda g: np.average(g.proj_r, weights=g.weight), include_groups=False).rename("proj_horizon")
h.to_csv(config.DATA / "projections" / f"horizon_from{args.from_round:02d}.csv", index=False)

out = base.merge(wsum, left_on="player_id", right_index=True, how="left")
out["proj_round1"] = out.proj
out["schedule_swing"] = out.proj_horizon - out.proj
out.to_csv(config.DATA / "projections" / f"round{args.from_round:02d}_horizon.csv", index=False)

print(f"horizon: rounds {rounds[0]}-{rounds[-1]}, weights "
      f"{[round(RETENTION**i, 2) for i in range(len(rounds))]}\n")
pl = out[out.position != "Head Coach"]
print("biggest schedule TAILWINDS (horizon projection above Round 1):")
print(pl.nlargest(6, "schedule_swing")[["last_name","team_abbr","price","proj_round1",
      "proj_horizon","schedule_swing"]].round(2).to_string(index=False))
print("\nbiggest schedule HEADWINDS:")
print(pl.nsmallest(6, "schedule_swing")[["last_name","team_abbr","price","proj_round1",
      "proj_horizon","schedule_swing"]].round(2).to_string(index=False))

print("\n=== club schedule strength over the horizon (avg opponent factor) ===")
cs = h[h.plays].groupby("team_abbr").agg(opp_factor=("opp_factor","mean"),
                                          p_win=("p_win","mean"), games=("plays","sum"))
print(cs.sort_values("opp_factor", ascending=False).round(3).to_string())
