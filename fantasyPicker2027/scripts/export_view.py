"""Export the squad, per-position alternatives and the reasoning behind each,
as a single JSON payload for the web view."""
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.optimize import optimise_squad

RND = 1
_hz = config.DATA / "projections" / f"round{RND:02d}_horizon.csv"
proj = pd.read_csv(_hz if _hz.exists() else config.DATA / "projections" / f"round{RND:02d}.csv")
if "proj_horizon" in proj.columns:
    proj["proj_hold"] = proj.proj_horizon.fillna(proj.proj)
HORIZON = pd.read_csv(config.DATA / "projections" / "horizon_from01.csv")
proj["name"] = (proj.first_name.fillna("") + " " + proj.last_name.fillna("")).str.strip()
players = proj[proj.position != "Head Coach"].copy()
coaches = proj[proj.position == "Head Coach"].copy()

res = optimise_squad(players, coaches)
squad, coach = res["players"], res["coach"]
squad_ids = set(squad.player_id) | {coach.player_id}

# --- context the reasons lean on -------------------------------------------------
crowd = (players.groupby("team_abbr").raw_minutes.sum() / 200.0).round(2)
sched = json.loads((config.DATA / "schedule.json").read_text())
md = next(m for m in sched["matchdays"] if m["number"] == RND)
turn, tipoff = {}, {}
for r in md["rounds"]:
    for m in r["matches"]:
        for side in ("home_team", "away_team"):
            turn[m[side]["abbreviation"]] = r["number"]
            tipoff[m[side]["abbreviation"]] = m["started_at"][:10]

med_value = players.value.median()


def reason(p, role=None):
    """Plain-language justification, built from the numbers actually used."""
    bits = []
    if role == "captain":
        bits.append("Captain: highest projection in the squad, and the captain scores double")
    if role == "sixth":
        bits.append("Sixth man: scores the full 100%, same as a starter, but cannot be captained")
    if p.value >= 1.25:
        bits.append(f"Elite value at {p.value:.2f} pts/credit (league median {med_value:.2f})")
    elif p.value >= 1.10:
        bits.append(f"Good value at {p.value:.2f} pts/credit vs {med_value:.2f} median")
    elif role == "bench":
        bits.append("Cheap by design — these four score 50%, so the slot buys credits for the six who score in full")

    if pd.notna(getattr(p, "last_pir_pg", None)):
        bits.append(f"Last season he banked {p.last_pir_pg:.1f} fantasy points per round "
                    f"across {int(p.last_games)} games — that record carries 60% of this projection")
    if pd.notna(p.minutes_pg) and role != "coach":
        bits.append(f"Projected {p.minutes_pg:.0f} min/game at {p.pir_per_min:.2f} PIR per minute")
    c = float(p.confidence) if pd.notna(p.confidence) else 0.0
    if c >= 0.8:
        bits.append(f"Strong record: {int(p.appearances)} EuroLeague games, {c:.0%} confidence")
    elif c >= 0.4:
        bits.append(f"Moderate sample: {int(p.appearances) if pd.notna(p.appearances) else 0} games, {c:.0%} confidence")
    else:
        bits.append("No EuroLeague history — projection leans on his price, treat as uncertain")

    o = float(getattr(p, "popularity", 0) or 0)
    if o >= 0.15:
        bits.append(f"Heavily owned ({o:.0%} of squads) — he wins you little ground on the field")
    elif 0 < o <= 0.05 and p.proj >= 9:
        bits.append(f"A differential: only {o:.1%} of squads hold him at this projection")

    cf = crowd.get(p.team_abbr)
    if cf is not None and cf >= 1.55:
        bits.append(f"Warning: {p.team_abbr} is a crowded roster ({cf:.2f}x the available minutes)")
    elif cf is not None and cf <= 1.25:
        bits.append(f"{p.team_abbr} is a thin roster ({cf:.2f}x) — minutes are easier to come by")

    bits.append(f"{p.p_win:.0%} win probability vs {p.opponent} ({'home' if p.home_away=='home' else 'away'}), "
                f"which carries the +10% team-win bonus")
    return bits


def row(p, role=None):
    return {
        "id": int(p.player_id), "name": p["name"], "position": p.position,
        "team": p.team_abbr, "team_full": p.team, "opponent": p.opponent,
        "home": p.home_away == "home", "turn": turn.get(p.team_abbr),
        "date": tipoff.get(p.team_abbr),
        "own": round(float(p.popularity), 3) if pd.notna(getattr(p, "popularity", None)) else 0.0,
        "price": round(float(p.price), 1), "proj": round(float(p.proj), 1),
        "value": round(float(p.value), 2),
        "minutes": round(float(p.minutes_pg), 1) if pd.notna(p.minutes_pg) else 0.0,
        "pir_per_min": round(float(p.pir_per_min), 2) if pd.notna(p.pir_per_min) else 0.0,
        "confidence": round(float(p.confidence), 2) if pd.notna(p.confidence) else 0.0,
        "last_pir": round(float(p.last_pir_pg), 1) if pd.notna(getattr(p, "last_pir_pg", None)) else None,
        "last_games": int(p.last_games) if pd.notna(getattr(p, "last_games", None)) else None,
        "appearances": int(p.appearances) if pd.notna(p.appearances) else 0,
        "p_win": round(float(p.p_win), 2) if pd.notna(p.p_win) else 0.0,
        "crowding": float(crowd.get(p.team_abbr, 0)),
        "horizon": round(float(p.proj_horizon), 1) if pd.notna(getattr(p, "proj_horizon", None)) else None,
        "fixtures": [
            {"round": int(x["round"]), "opp": x.opponent_abbr,
             "home": x.home_away == "home", "proj": round(float(x.proj_r), 1)}
            for _, x in HORIZON[HORIZON.player_id == p.player_id].sort_values("round").iterrows()
        ],
        "role": role, "reasons": reason(p, role),
        "in_squad": int(p.player_id) in {int(i) for i in squad_ids},
    }


out = {
    "round": RND, "tipoff": "2026-09-24",
    "cost": round(res["cost"], 1), "expected": round(res["expected"], 1),
    "formation": "-".join(map(str, res["formation"])),
    "starters": [], "sixth": [], "bench": [], "coach": None, "alternatives": {},
    "crowding": {k: float(v) for k, v in crowd.sort_values(ascending=False).items()},
    "turns": {"T1": sorted([t for t, n in turn.items() if n == 1]),
              "T2": sorted([t for t, n in turn.items() if n == 2])},
}

for _, p in squad.iterrows():
    if p.starter:
        role, bucket = ("captain" if p.captain else "starter"), "starters"
    elif p.sixth:
        role, bucket = "sixth", "sixth"
    else:
        role, bucket = "bench", "bench"
    out[bucket].append(row(p, role))
for k in ("starters", "sixth", "bench"):
    out[k].sort(key=lambda r: -r["proj"])
from flp.projections import coach_band_probabilities
out["coach"] = row(coach, "coach")
out["coach"]["bands"] = coach_band_probabilities(float(coach.exp_margin))
out["coach_board"] = []
for _, cc in coaches.nlargest(6, "proj").iterrows():
    b = coach_band_probabilities(float(cc.exp_margin))
    out["coach_board"].append({
        "name": cc["name"], "team": cc.team_abbr, "price": round(float(cc.price), 1),
        "proj": round(float(cc.proj), 1), "bands": b,
        "big_win": round(b["win 21+"] + b["win 11-20"], 3),
        "held": bool(cc.player_id == coach.player_id)})
_b = out["coach"]["bands"]
out["coach"]["reasons"] = [
    "Coach scoring is a step function, never a sliding scale: a 2-point win and a "
    "10-point win both pay exactly +10",
    f"{(_b['win 21+'] + _b['win 11-20']) * 100:.0f}% chance of a 20-point outcome "
    f"(+25 or +20) — that is where a coach's value actually sits, not in winning as such",
    "A narrow win pays +10 but a narrow loss only -5, which is why the slot is "
    "structurally positive",
    f"Expected margin {coach.exp_margin:+.1f} vs {coach.opponent} gives an expected {coach.proj:.1f} pts",
    f"At {coach.price:.0f}cr that is {coach.value:.2f} pts/credit — the bands are asymmetric, so this slot is structurally positive",
]

for pos in ["Guard", "Forward", "Center"]:
    alts = players[(players.position == pos) & (~players.player_id.isin(squad_ids))]
    picked = pd.concat([alts.nlargest(6, "proj"), alts.nlargest(6, "value")]).drop_duplicates("player_id")
    out["alternatives"][pos] = [row(p) for _, p in picked.nlargest(9, "proj").iterrows()]

alts_c = coaches[coaches.player_id != coach.player_id].nlargest(6, "proj")
out["alternatives"]["Head Coach"] = [row(p) for _, p in alts_c.iterrows()]
for c in out["alternatives"]["Head Coach"]:
    c["reasons"] = [f"Expected {c['proj']:.1f} pts at {c['price']}cr ({c['value']:.2f} per credit)"]

# ---- valuation: who beats or misses what their price implies -------------------
import numpy as np
solid = players[players.confidence >= 0.5]
curve_v = np.poly1d(np.polyfit(solid.price, solid.proj, 2))
players["implied"] = curve_v(players.price)
players["edge"] = players.proj - players.implied

rated = players[(players.confidence >= 0.5) & (players.minutes_pg >= 8)]
out["undervalued"] = [dict(row(p), implied=round(float(p.implied), 1),
                           edge=round(float(p.edge), 1)) for _, p in rated.nlargest(8, "edge").iterrows()]
out["overvalued"] = [dict(row(p), implied=round(float(p.implied), 1),
                          edge=round(float(p.edge), 1)) for _, p in rated.nsmallest(8, "edge").iterrows()]
unver = players[(players.confidence < 0.15) & (players.price >= 10)].sort_values("price", ascending=False)
out["unverifiable"] = [dict(row(p), implied=round(float(p.implied), 1),
                            edge=round(float(p.edge), 1)) for _, p in unver.head(10).iterrows()]
out["price_curve"] = [[float(pr), round(float(curve_v(pr)), 1)] for pr in range(4, 18, 2)]

# --- ownership: what the field is doing -----------------------------------------
own = players.popularity.fillna(0.0)
out["field_average"] = round(float((own * players.proj).sum()), 1)
out["ownership_live"] = bool((own > 0).any())
diff = players[(players.proj >= 9) & (own <= 0.06)]
out["differentials"] = [dict(row(p), edge=round(float(p.proj), 1))
                        for _, p in diff.nlargest(8, "proj").iterrows()]
out["crowded"] = [dict(row(p), edge=round(float(p.proj), 1))
                  for _, p in players.nlargest(8, "popularity").iterrows()]
out["ownership_note"] = (
    "Ownership is live now. It sums to 10 across the pool because every manager fills ten "
    "outfield slots, so a 40% figure means two squads in five hold him. Multiplying every "
    f"player's ownership by his projection gives what the average manager will score from "
    f"his outfield ten this round: {out['field_average']:.0f} points. Beating the field means "
    "beating that, and you only gain ground where you differ from it.")

# club schedule strength over the planning horizon
cs = HORIZON[HORIZON.plays].groupby("team_abbr").agg(
    opp=("opp_factor", "mean"), pwin=("p_win", "mean")).reset_index()
out["schedule"] = [{"team": r.team_abbr, "opp": round(float(r.opp), 3),
                    "p_win": round(float(r.pwin), 2)}
                   for r in cs.sort_values("opp", ascending=False).itertuples()]
out["horizon_note"] = ("Squad membership is valued across Rounds 1-6, the run up to the first "
                       "unlimited-transfer window. Each round is weighted by the chance you still "
                       "hold the player: with four trades a round out of eleven slots that is "
                       "(7/11) per round, so Round 1 counts fully and Round 6 about 7%.")

# --- role / opportunity boards and the season strategy --------------------------
ra_path = config.DATA / "role_analysis.csv"
if ra_path.exists():
    ra = pd.read_csv(ra_path)
    def board(df, n=8):
        return [{"name": r["name"], "pos": r.position, "team": r.team_abbr,
                 "price": round(float(r.price), 1), "proj": round(float(r.proj), 1),
                 "ls_mpg": None if pd.isna(r.ls_mpg) else round(float(r.ls_mpg), 1),
                 "ls_pir": None if pd.isna(r.ls_pir) else round(float(r.ls_pir), 1),
                 "vacated": round(float(r.vacated), 0),
                 "competition": round(float(r.competition), 0),
                 "role": round(float(r.role_score), 2),
                 "opp": round(float(r.opportunity), 2),
                 "breakout": round(float(r.breakout), 2),
                 "continuity": int(r.continuity),
                 "own": round(float(r.own), 3)}
                for _, r in df.head(n).iterrows()]

    out["tiers"] = []
    for label, lo, hi, blurb in [
        ("Premium", 13.0, 99, "13.0-17.0cr. Thirty players. You can afford two, maybe three."),
        ("Mid", 10.0, 13.0, "10.0-12.9cr. Sixty-three players — where most rounds are won or lost."),
        ("Value", 9.0, 10.0, "9.0-9.9cr. Forty-one players, the band your tiering left open."),
        ("Budget", 0, 9.0, "Under 9.0cr. Bench filler, plus the occasional real starter.")]:
        seg = ra[(ra.price >= lo) & (ra.price < hi)]
        out["tiers"].append({"label": label, "range": blurb, "n": int(len(seg)),
                             "by_proj": board(seg.nlargest(8, "proj")),
                             "by_value": board(seg.nlargest(5, "value"))})

    out["boards"] = {
        "role": board(ra.nlargest(8, "role_score")),
        "breakout": board(ra.nlargest(8, "breakout")),
    }
    cl = ra.groupby("team_abbr").agg(
        vacated=("vacated", "max"), n_over_10=("n_over_10", "first"),
        star_power=("star_power", "first")).reset_index()
    coach_kept = dict(zip(coaches.team_abbr, coaches.player_id))
    out["clubs"] = [{"team": r.team_abbr, "vacated": round(float(r.vacated), 0),
                     "n_over_10": int(r.n_over_10), "star_power": round(float(r.star_power), 1)}
                    for r in cl.sort_values("vacated", ascending=False).itertuples()]

path = config.DATA / "view_round01.json"
path.write_text(json.dumps(out, indent=1))
print(f"wrote {path}")
print(f"squad {out['cost']}cr, expected {out['expected']}, formation {out['formation']}")
print("alternatives:", {k: len(v) for k, v in out["alternatives"].items()})
