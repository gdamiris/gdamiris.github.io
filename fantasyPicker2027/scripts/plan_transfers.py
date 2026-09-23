"""Which players should you sell, and for whom?

You get four trades a Round and the coach counts as one, so this is not "rebuild the
best squad" -- it is "find the four changes that buy the most points". The optimiser is
the same one that builds a squad from scratch, with two extra constraints: at most N of
your current players may be sold, and the budget is what your squad is actually worth
plus whatever is in the bank.

Players are valued over the planning horizon, not just the next round, because a trade
commits you for several rounds.
"""
import argparse
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.optimize import optimise_squad

ap = argparse.ArgumentParser()
ap.add_argument("--round", type=int, default=1)
ap.add_argument("--transfers", type=int, default=4, help="trades available (unlimited windows: use 11)")
ap.add_argument("--bank", type=float, default=None,
                help="unspent credits; inferred from a 100cr cap if omitted")
ap.add_argument("--target", default=None,
                help="surname of a player you want to buy — shows what affording him costs")
args = ap.parse_args()

roster = pd.read_csv(config.DATA / f"roster_round{args.round:02d}.csv")
# Your spending power is what the squad is worth plus what is unspent. The API exposes
# no bank figure, so at a 100-credit cap it is whatever the squad does not use.
BANK = args.bank if args.bank is not None else max(0.0, 100.0 - float(roster.price.sum()))
hz = config.DATA / "projections" / f"round{args.round:02d}_horizon.csv"
proj = pd.read_csv(hz if hz.exists() else config.DATA / "projections" / f"round{args.round:02d}.csv")
proj["name"] = (proj.first_name.fillna("") + " " + proj.last_name.fillna("")).str.strip()
if "proj_horizon" in proj.columns:
    proj["proj_hold"] = proj.proj_horizon.fillna(proj.proj)
proj["fixture"] = proj.apply(lambda r: "-".join(sorted([str(r.team_abbr), str(r.opponent_abbr)])), axis=1)

import json
sched = json.loads((config.DATA / "schedule.json").read_text())
md = next(m for m in sched["matchdays"] if m["number"] == args.round)
turn = {}
for rnd in md["rounds"]:
    for mt in rnd["matches"]:
        for side in ("home_team", "away_team"):
            turn[mt[side]["abbreviation"]] = rnd["number"]
proj["turn"] = proj.team_abbr.map(turn)

held = set(roster.player_id)
budget = float(roster.price.sum()) + BANK
players = proj[proj.position != "Head Coach"].copy()
coaches = proj[proj.position == "Head Coach"].copy()


def score(ids):
    """Value a held squad using the model's own lineup choice."""
    sub = proj[proj.player_id.isin(ids)]
    p, c = sub[sub.position != "Head Coach"], sub[sub.position == "Head Coach"]
    if len(p) != 10 or len(c) != 1:
        return None
    # No fixture cap when valuing what you already own -- the point is to price the
    # squad as it stands, not to reject it.
    return optimise_squad(p, c, budget=budget, min_quality_bench=0, max_per_fixture=0)


before = score(held)
loose = optimise_squad(players, coaches, budget=budget, current_squad=held,
                       max_transfers=args.transfers, max_per_fixture=0)
try:
    after = optimise_squad(players, coaches, budget=budget,
                           current_squad=held, max_transfers=args.transfers)
    capped = True
except RuntimeError:
    # Not enough trades to unwind the concentration you already hold. The cap is our
    # own risk rule, not a rule of the game, so fall back and say so.
    after, capped = loose, False

print(f"squad value {roster.price.sum():.1f}cr + bank {BANK:.1f}cr = {budget:.1f}cr of spending power")
print(f"trades available: {args.transfers}\n")
# how concentrated is the squad you hold?
conc = proj[proj.player_id.isin(held)].groupby("fixture").size().sort_values(ascending=False)
if conc.iloc[0] > 3:
    print(f"WARNING: {conc.iloc[0]} of your players are in one game ({conc.index[0]}). "
          f"One bad night takes the round with it.\n")

print(f"current squad, best lineup   : {before['expected']:.1f} pts")
if capped:
    print(f"after up to {args.transfers} trades          : {after['expected']:.1f} pts"
          f"   ({after['expected'] - before['expected']:+.1f})   [max 3 per game]")
    if abs(loose["expected"] - after["expected"]) > 0.05:
        print(f"  ignoring the game cap      : {loose['expected']:.1f} pts"
              f"   ({loose['expected'] - before['expected']:+.1f})   [more concentrated]")
else:
    print(f"after up to {args.transfers} trades          : {after['expected']:.1f} pts"
          f"   ({after['expected'] - before['expected']:+.1f})")
    print(f"  NOTE: {args.transfers} trades cannot unwind the concentration you hold, so the"
          f" 3-per-game rule is relaxed here.")
print()

new_ids = set(after["players"].player_id) | {after["coach"].player_id}
sold = held - new_ids
bought = new_ids - held
if not sold:
    print("No trade improves the squad. Keep your four and save them for an injury.")
else:
    look = proj.set_index("player_id")
    # Pair each sale with a purchase at the same position -- that is what a trade is.
    out_by_pos, in_by_pos = {}, {}
    for i in sold:
        out_by_pos.setdefault(look.loc[i, "position"], []).append(i)
    for i in bought:
        in_by_pos.setdefault(look.loc[i, "position"], []).append(i)
    print(f"  {'SELL':<24}{'':8}{'BUY':<24}")
    for pos in sorted(out_by_pos):
        outs = sorted(out_by_pos[pos], key=lambda i: -look.loc[i, "proj"])
        ins = sorted(in_by_pos.get(pos, []), key=lambda i: -look.loc[i, "proj"])
        for s_id, b_id in zip(outs, ins):
            s, b = look.loc[s_id], look.loc[b_id]
            print(f"  {s['name']:<20} {s.price:>4.1f} ({s.proj:>4.1f})  ->  "
                  f"{b['name']:<20} {b.price:>4.1f} ({b.proj:>4.1f})   {pos}")
    # Every trade is funded by another. Show the running balance so an upgrade at one
    # position is visibly paid for by a downgrade somewhere else.
    print(f"\n  {'':<20} {'out':>6} {'in':>6} {'net':>7} {'running':>8}")
    running = BANK
    pairs = []
    for pos in sorted(out_by_pos):
        outs = sorted(out_by_pos[pos], key=lambda i: -look.loc[i, "proj"])
        ins = sorted(in_by_pos.get(pos, []), key=lambda i: -look.loc[i, "proj"])
        pairs += list(zip(outs, ins))
    for s_id, b_id in pairs:
        sp, bp = float(look.loc[s_id, "price"]), float(look.loc[b_id, "price"])
        running += sp - bp
        print(f"  {look.loc[s_id,'name'][:19]:<20} {sp:>6.1f} {bp:>6.1f} {sp-bp:>+7.1f} {running:>8.1f}")
    print(f"  {'':<20} {'':>6} {'':>6} {'':>7} {'':>8}")
    print(f"  {len(sold)} of {args.transfers} trades used | new squad {after['cost']:.1f}cr | "
          f"{budget - after['cost']:.1f}cr left in the bank")

# --- the coach is a weekly decision, not a season-long one -----------------------
# The within-round spread across the 20 coaches is 11 to 21 points and the best one
# changes almost every round, so he must be re-checked every time. But switching costs
# one of the four trades, so the bar is what that trade would otherwise buy.
held_coach = roster[roster.position == "Head Coach"]
if len(held_coach):
    hc_name = held_coach.iloc[0]["name"]
    cs = coaches.copy()
    mine = cs[cs.player_id.isin(held)]
    best = cs.nlargest(1, "proj").iloc[0]
    print(f"\n=== coach check ===")
    if len(mine):
        cur = mine.iloc[0]
        gain = float(best.proj - cur.proj)
        print(f"  holding  {cur['name']:<22} {cur.price:>4.1f}cr   projects {cur.proj:>5.1f}")
        print(f"  best now {best['name']:<22} {best.price:>4.1f}cr   projects {best.proj:>5.1f}")
        bar = 3.5
        if best.player_id == cur.player_id:
            print(f"  -> you already hold the best coach for this round. No trade needed.")
        elif gain > bar:
            print(f"  -> SWITCH: +{gain:.1f} pts, clears the ~{bar:.1f} a marginal player trade buys.")
        else:
            print(f"  -> hold: +{gain:.1f} pts does not clear the ~{bar:.1f} a player trade buys."
                  f" Spend the trade on a player instead.")
    # Coach scoring is a step function, so show the shape, not just the mean. The
    # +10 band is near-constant across coaches -- what separates them is blowout odds.
    from flp.projections import coach_band_probabilities
    print(f"\n  {'coach':<15}{'cr':>5}{'exp':>6} |{'+25':>6}{'+20':>6}{'+10':>6}"
          f"{'-5':>6}{'-10':>6}{'-20':>6} |{'20pt win':>9}")
    for _, r in cs.nlargest(6, "proj").iterrows():
        b = coach_band_probabilities(r.exp_margin)
        big = b["win 21+"] + b["win 11-20"]
        mark = "  <- held" if r.player_id in held else ""
        print(f"  {r['name'].split()[-1][:14]:<15}{r.price:>5.1f}{r.proj:>6.1f} |"
              + "".join(f"{b[k]*100:>5.0f}%" for k in
                        ["win 21+","win 11-20","win 1-10","loss 1-10","loss 11-20","loss 21+"])
              + f" |{big*100:>8.0f}%{mark}")

# --- what does a specific signing actually cost you? ----------------------------
if args.target:
    hit = proj[proj.last_name.str.contains(args.target, case=False, na=False)]
    if hit.empty:
        print(f"\nno player matching '{args.target}'")
    else:
        want = hit.nlargest(1, "proj").iloc[0]
        print(f"\n=== affording {want['name']} ({want.price:.1f}cr, projects {want.proj:.1f}) ===")
        forced = optimise_squad(players, coaches, budget=budget, current_squad=held,
                                max_transfers=args.transfers, max_per_fixture=0,
                                locked={want.player_id})
        f_ids = set(forced["players"].player_id) | {forced["coach"].player_id}
        f_sold, f_bought = held - f_ids, f_ids - held
        look2 = proj.set_index("player_id")
        print(f"  best squad containing him : {forced['expected']:.1f} pts "
              f"({forced['expected'] - after['expected']:+.1f} vs the free plan)")
        print(f"  it costs you these sales  : "
              + ", ".join(f"{look2.loc[i,'name']} ({look2.loc[i,'price']:.1f})" for i in sorted(f_sold)))
        downgrades = [i for i in f_bought if i != want.player_id]
        if downgrades:
            print(f"  and these replacements    : "
                  + ", ".join(f"{look2.loc[i,'name']} ({look2.loc[i,'price']:.1f})" for i in sorted(downgrades)))

sq = after["players"]
capt = sq[sq.captain].iloc[0]
print(f"\ncaptain: {capt['name']} (Turn {int(capt.turn)}) — keep the armband on a Turn 1 player"
      f" so it can still be moved.")
