"""Who actually has a big role this season, and where is opportunity opening up?

Three things decide whether last season's output repeats:

  1. Was his role big to begin with? Minutes are the carrier of fantasy points.
  2. Who is he now competing with? Production follows opportunity, and a club that
     signed two players at his position has quietly cut his ceiling.
  3. Did the coach change? Eleven of twenty clubs changed coach, and a new coach makes
     last season's rotation a much weaker guide.

A tempting fourth idea does NOT survive testing: that a THIN roster lifts its star by
concentrating usage on him. Measured across eight seasons it is the opposite -- lead
players on the deepest rosters score 16.8 PIR a game against 13.5 on the thinnest, and
every correlation points the same way (+0.44 on PIR/game). The mechanism is specific to
this scoring system: a lead man on a weak team does take marginally more shots (0.377
against 0.368 per minute) but misses more of them (0.222 against 0.210, 49.4% against
50.6%), and PIR charges -1 for every miss. Volume brings its own penalty with it.

So competition at HIS position is what matters, not the quality of the roster around him.

Writes data/role_analysis.csv and prints the tier boards.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.projections import normalise_name

pool = pd.read_csv(config.DATA / "projections" / "round01_horizon.csv")
pool["name_key"] = (pool.last_name.fillna("") + " " + pool.first_name.fillna("")).map(normalise_name)
pool["name"] = (pool.first_name.fillna("") + " " + pool.last_name.fillna("")).str.strip()
players = pool[pool.position != "Head Coach"].copy()
coaches = pool[pool.position == "Head Coach"].copy()

abbr2code = json.loads((config.DATA / "club_code_map.json").read_text())
code2abbr = {v: k for k, v in abbr2code.items()}

pg = pd.read_parquet(config.DATA / "player_game.parquet")
e = pg[(pg.competition == "E") & (pg.season == "E2025")].copy()
e["name_key"] = e.player.map(normalise_name)
tg = e.groupby("team_code").gamecode.nunique()

last = e.groupby(["team_code", "name_key", "position"]).agg(
    mins=("minutes", "sum"), pir=("pir", "sum"), games=("pir", "size")).reset_index()
last["mpg"] = last.mins / last.team_code.map(tg)
last["pir_pg"] = last.pir / last.team_code.map(tg)
last["abbr"] = last.team_code.map(code2abbr)

# ---------------------------------------------------------------- coach continuity
cg = pd.read_parquet(config.DATA / "coach_game.parquet")
prev_coach = cg[(cg.competition == "E") & (cg.season == "E2025")].groupby("team_code").coach.agg(
    lambda s: s.mode().iat[0])
same_coach = {}
for r in coaches.itertuples():
    prev = prev_coach.get(abbr2code.get(r.team_abbr))
    same_coach[r.team_abbr] = (normalise_name(r.last_name) in normalise_name(prev)) if prev else False

# ---------------------------------------------------------------- per-player history
# A player who moved mid-season appears twice; keep the club he played most for.
hist = (last.sort_values("mins", ascending=False)
            .drop_duplicates("name_key").set_index("name_key"))
players["ls_mpg"] = players.name_key.map(hist.mpg)
players["ls_pir"] = players.name_key.map(hist.pir_pg)
players["ls_club"] = players.name_key.map(hist.abbr)
players["moved"] = players.ls_club.notna() & (players.ls_club != players.team_abbr)
players["same_coach"] = players.team_abbr.map(same_coach)

# ------------------------------------------------- competition and vacated minutes
club_now = players.set_index("name_key").team_abbr.to_dict()
last["club_now"] = last.name_key.map(club_now)
last["gone"] = last.club_now.isna() | (last.club_now != last.abbr)
vac = last[last.gone].groupby(["abbr", "position"]).mpg.sum()

comp, rank_pos, share = [], [], []
for r in players.itertuples():
    same = players[(players.team_abbr == r.team_abbr) & (players.position == r.position)]
    rivals = same[same.player_id != r.player_id]
    comp.append(float(rivals.raw_minutes.sum()))
    rank_pos.append(int((same.raw_minutes > r.raw_minutes).sum()) + 1)
    share.append(float(r.raw_minutes / same.raw_minutes.sum()) if same.raw_minutes.sum() else 0.0)
players["competition"] = comp
players["pos_rank"] = rank_pos
players["minutes_share"] = share
players["vacated"] = [vac.get((r.team_abbr, r.position), 0.0) for r in players.itertuples()]

# --------------------------------------------------------------- club-level context
club = players.groupby("team_abbr").apply(
    lambda g: pd.Series({
        "top3_proj": g.nlargest(3, "proj").proj.sum(),
        "n_over_10": int((g.proj >= 10).sum()),
        "depth_spread": float(g.nlargest(8, "proj").proj.std()),
    }), include_groups=False)
club["star_power"] = club.top3_proj
# Thin = few credible options, so usage concentrates on whoever is there.
club["thin"] = (club.n_over_10 <= club.n_over_10.median()).map({True: "thin", False: "deep"})
players = players.join(club[["star_power", "n_over_10", "thin"]], on="team_abbr")

# ---------------------------------------------------------------- the indicators
def z(s):
    s = s.astype(float)
    return (s - s.mean()) / (s.std() if s.std() else 1)


def zp(col):
    """Standardise WITHIN position. Centres face two rivals where guards face five, so
    a raw cross-position score just ranks centres first every time."""
    return players.groupby("position")[col].transform(
        lambda g: (g - g.mean()) / (g.std() if g.std() else 1))

# ROLE: is he the man at his position, with minutes to match?
players["role_score"] = (
    0.45 * zp("raw_minutes")
    + 0.25 * zp("minutes_share")
    - 0.20 * zp("competition")
    + 0.10 * zp("ls_pir")
).round(2)

# OPPORTUNITY: minutes freed at his position and few direct rivals for them.
# Deliberately NOT rewarding thin rosters -- see the docstring; that effect runs the
# other way once the miss penalty is accounted for.
players["opportunity"] = (
    0.50 * zp("vacated")
    - 0.40 * zp("competition")
    + 0.10 * zp("raw_minutes")
).round(2)

# Confidence in last season as a guide: same club, same coach, real sample
# BREAKOUT: opportunity is worthless unless he is good enough to take the minutes.
# Require both -- vacated minutes AND a real per-minute rate.
players["breakout"] = (
    0.5 * players.opportunity + 0.5 * zp("pir_per_min")
).round(2)

players["continuity"] = (
    players.same_coach.fillna(False).astype(int)
    + (~players.moved.fillna(True)).astype(int)
    + (players.ls_mpg.fillna(0) >= 15).astype(int)
)

players["own"] = players.popularity.fillna(0)
players.to_csv(config.DATA / "role_analysis.csv", index=False)

TIERS = [("PREMIUM  13.0-17.0cr", 13.0, 99), ("MID      10.0-12.9cr", 10.0, 13.0),
         ("VALUE     9.0-9.9cr", 9.0, 10.0), ("BUDGET   under 9.0cr", 0, 9.0)]
cols = ["name", "position", "team_abbr", "price", "proj", "value", "ls_mpg", "ls_pir",
        "pos_rank", "competition", "vacated", "role_score", "opportunity", "breakout",
        "continuity", "own"]

for label, lo, hi in TIERS:
    seg = players[(players.price >= lo) & (players.price < hi)]
    print(f"\n{'='*100}\n{label}   ({len(seg)} players)\n{'='*100}")
    top = seg.nlargest(10, "proj")[cols]
    print(top.rename(columns={"team_abbr": "club", "ls_mpg": "min", "ls_pir": "PIR",
                              "pos_rank": "#pos", "competition": "rivals",
                              "role_score": "role", "opportunity": "opp", "breakout": "brk",
                              "continuity": "cont"}).round(2).to_string(index=False))
print(f"\n\n{'='*100}\nCLUB CONTEXT — thin rosters concentrate usage\n{'='*100}")
cc = club.copy()
cc["coach_kept"] = pd.Series(same_coach)
cc["vacated_min"] = players.groupby("team_abbr").vacated.first()
print(cc.sort_values("n_over_10").round(1).to_string())
