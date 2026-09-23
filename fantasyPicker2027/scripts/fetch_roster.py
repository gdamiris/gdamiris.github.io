"""Save the squad currently held on the fantasy site."""
import argparse, json, sys
from pathlib import Path
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.dunkest import Dunkest

ap = argparse.ArgumentParser()
ap.add_argument("--round", type=int, default=1)
args = ap.parse_args()
matchday = 1527 + args.round

d = Dunkest()
raw = d.roster(config.TEAM_ID, str(matchday))["data"]
rows = []
for p in raw.get("players") or []:
    rows.append({
        "player_id": p["id"],
        "name": f"{p.get('first_name','')} {p.get('last_name','')}".strip(),
        "position": (p.get("position") or {}).get("name"),
        "team_abbr": (p.get("team") or {}).get("abbreviation"),
        "price": p.get("quotation"),
        "court_position": p.get("court_position"),
        "is_captain": bool(p.get("is_captain")),
        "is_injured": bool(p.get("is_injured")),
        "active": bool(p.get("active")),
    })
df = pd.DataFrame(rows)
out = config.DATA / f"roster_round{args.round:02d}.csv"
df.to_csv(out, index=False)
print(f"{len(df)} players held, {df.price.sum():.1f}cr committed -> {out}\n")
print(df[["name","position","team_abbr","price","court_position","is_captain","is_injured"]].to_string(index=False))
