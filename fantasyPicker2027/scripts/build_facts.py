"""Turn cached game stats into modelling tables.

Outputs:
  data/player_game.parquet  one row per player per game, with fantasy points
  data/coach_game.parquet   one row per team per game, with coach points

Fantasy points are reconstructed per docs/SCORING-MODEL.md:
  player_pts = PIR * (1.10 if his team won else 1.00)
We verify the feed's `valuation` really equals the rulebook formula rather than
assuming it.
"""
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.scoring import coach_points

SRC = config.RAW / "stats"


def build() -> tuple[pd.DataFrame, pd.DataFrame]:
    results = {(g["season"], g["gamecode"]): g
               for g in json.loads((config.RAW / "results.json").read_text())}
    prows, crows, skipped = [], [], 0

    for path in sorted(SRC.glob("*.json")):
        season, gc = path.stem.rsplit("_", 1)
        meta = results.get((season, int(gc)))
        if not meta:
            skipped += 1
            continue
        d = json.loads(path.read_text())

        # 'local' is the home side, 'road' the away side.
        for side, is_home in (("local", True), ("road", False)):
            blk = d.get(side) or {}
            players = blk.get("players") or []
            if not players:
                continue
            team_score = meta["home_score"] if is_home else meta["away_score"]
            opp_score = meta["away_score"] if is_home else meta["home_score"]
            team_code = meta["home_code"] if is_home else meta["away_code"]
            opp_code = meta["away_code"] if is_home else meta["home_code"]
            margin = team_score - opp_score
            won = margin > 0

            coach = (blk.get("coach") or {})
            crows.append({
                "season": season, "competition": season[0],
                "gamecode": int(gc), "gameday": meta["gameday"],
                "group": meta["group"], "date": meta["date"],
                "team_code": team_code, "opp_code": opp_code, "is_home": is_home,
                "coach_code": coach.get("code"), "coach": coach.get("name"),
                "team_score": team_score, "opp_score": opp_score,
                "margin": margin, "won": won,
                "coach_pts": coach_points(margin),
            })

            for entry in players:
                per = (entry.get("player") or {})
                person = (per.get("person") or {})
                st = (entry.get("stats") or {})
                pid = (person.get("code") or "").strip()
                if not pid:
                    continue
                val = st.get("valuation") or 0.0
                prows.append({
                    "season": season, "competition": season[0],
                    "gamecode": int(gc), "gameday": meta["gameday"],
                    "group": meta["group"], "date": meta["date"],
                    "player_id": pid, "player": person.get("name"),
                    "position": per.get("positionName"),
                    "club_code": (per.get("club") or {}).get("code"),
                    "team_code": team_code, "opp_code": opp_code, "is_home": is_home,
                    "seconds": st.get("timePlayed") or 0.0,
                    "is_starter": bool(st.get("startFive")),
                    "pts": st.get("points") or 0.0,
                    "reb": st.get("totalRebounds") or 0.0,
                    "oreb": st.get("offensiveRebounds") or 0.0,
                    "dreb": st.get("defensiveRebounds") or 0.0,
                    "ast": st.get("assistances") or 0.0,
                    "stl": st.get("steals") or 0.0,
                    "tov": st.get("turnovers") or 0.0,
                    "blk_fav": st.get("blocksFavour") or 0.0,
                    "blk_agn": st.get("blocksAgainst") or 0.0,
                    "foul_com": st.get("foulsCommited") or 0.0,
                    "foul_rec": st.get("foulsReceived") or 0.0,
                    "fg2m": st.get("fieldGoalsMade2") or 0.0,
                    "fg2a": st.get("fieldGoalsAttempted2") or 0.0,
                    "fg3m": st.get("fieldGoalsMade3") or 0.0,
                    "fg3a": st.get("fieldGoalsAttempted3") or 0.0,
                    "ftm": st.get("freeThrowsMade") or 0.0,
                    "fta": st.get("freeThrowsAttempted") or 0.0,
                    "plusminus": st.get("plusMinus") or 0.0,
                    "pir": val,
                    "won": won, "margin": margin,
                    "fantasy_pts": round(val * (1.10 if won else 1.0), 3),
                })

    return pd.DataFrame(prows), pd.DataFrame(crows), skipped


pg, cg, skipped = build()

# timePlayed units are not documented; infer from a full game's starter workload.
med_starter = pg.loc[pg.is_starter, "seconds"].median()
divisor = 60.0 if med_starter > 600 else 1.0
pg["minutes"] = pg.seconds / divisor
pg["played"] = pg.minutes > 0
print(f"timePlayed units: median starter = {med_starter:.0f} -> divisor {divisor:.0f} "
      f"=> median starter minutes {pg.loc[pg.is_starter,'minutes'].median():.1f}")

# Sanity check: does `valuation` match the rulebook scoring formula?
missed = (pg.fg2a - pg.fg2m) + (pg.fg3a - pg.fg3m) + (pg.fta - pg.ftm)
calc = (pg.pts + pg.reb + pg.ast + pg.stl + pg.blk_fav + pg.foul_rec
        - pg.tov - pg.blk_agn - pg.foul_com - missed)
agree = (calc == pg.pir).mean()
print(f"PIR formula check: {agree:.4%} of {len(pg):,} rows match `valuation` exactly")
if agree < 1:
    bad = pg[calc != pg.pir]
    print(f"  {len(bad)} mismatches; sample:")
    print(bad[["season", "player", "pir", "pts", "reb", "ast", "tov"]].head(3).to_string(index=False))

pg.to_parquet(config.DATA / "player_game.parquet", index=False)
cg.to_parquet(config.DATA / "coach_game.parquet", index=False)
print(f"\nplayer_game: {len(pg):,} rows | {pg.player_id.nunique():,} players")
print(pg.groupby("competition").agg(rows=("pir","size"), players=("player_id","nunique"),
                                    seasons=("season","nunique")).to_string())
print(f"coach_game:  {len(cg):,} rows | {cg.coach.nunique()} coaches | skipped {skipped}")
