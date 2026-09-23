"""Extract a player dimension table (birth date, height, position) from raw stats.

Age is a real predictor in EuroLeague -- production falls away past the early
thirties -- and it is sitting unused in every stats payload we already downloaded.
"""
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

rows = {}
for path in sorted((config.RAW / "stats").glob("*.json")):
    d = json.loads(path.read_text())
    for side in ("local", "road"):
        for entry in (d.get(side) or {}).get("players") or []:
            per = entry.get("player") or {}
            person = per.get("person") or {}
            code = (person.get("code") or "").strip()
            if not code or code in rows:
                continue
            rows[code] = {
                "player_id": code,
                "player": person.get("name"),
                "birth_date": person.get("birthDate"),
                "height": person.get("height"),
                "country": (person.get("country") or {}).get("code"),
                "position_name": per.get("positionName"),
            }

df = pd.DataFrame(rows.values())
df["birth_date"] = pd.to_datetime(df.birth_date, errors="coerce")
df.to_parquet(config.DATA / "players_dim.parquet", index=False)
print(f"{len(df):,} players | birth dates on {df.birth_date.notna().mean():.0%} | "
      f"heights on {df.height.notna().mean():.0%}")
print(df.head(3).to_string(index=False))
