"""One-off reconnaissance: authenticate, then map out which endpoints exist
and what shape they return. Dumps raw JSON to data/raw/ for inspection."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from flp import config
from flp.dunkest import Dunkest


def shape(obj, depth=0):
    pad = "  " * depth
    if isinstance(obj, dict):
        keys = list(obj)
        out = [f"{pad}dict({len(keys)} keys): {keys[:14]}"]
        if depth < 1:
            for k in keys[:6]:
                out.append(shape(obj[k], depth + 1))
        return "\n".join(out)
    if isinstance(obj, list):
        out = [f"{pad}list[{len(obj)}]"]
        if obj and depth < 2:
            out.append(shape(obj[0], depth + 1))
        return "\n".join(out)
    s = str(obj)
    return f"{pad}{type(obj).__name__}: {s[:70]}"


def try_get(d, label, path, **params):
    try:
        data = d.get(path, **params)
    except Exception as e:
        print(f"\n### {label}  [{path}]\n  FAIL: {str(e)[:150]}")
        return None
    out = config.RAW / f"{label}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=1)[:8_000_000])
    print(f"\n### {label}  [{path}]  -> {out.name}")
    print(shape(data))
    return data


d = Dunkest()
print("authenticating...")
print("token acquired:", d.token[:18] + "..." + f" (len {len(d.token)})")

pl = config.PLAYERS_LIST_ID
md = config.SAMPLE_MATCHDAY

try_get(d, "games", f"/games")
try_get(d, "game_7", f"/games/{config.GAME_ID}")
try_get(d, "players_list_49", f"/players-lists/{pl}")
try_get(d, "matchdays_49", f"/players-lists/{pl}/matchdays")
try_get(d, "schedule_md", f"/schedules/{pl}/matchdays/{md}", lang="en")
try_get(d, "roster", f"/fantasy-teams/{config.TEAM_ID}/matchdays/{md}/roster")
try_get(d, "players", f"/players-lists/{pl}/matchdays/{md}/players",
        per_page=-1, page=1, sort_by="quotation", sort_order="desc")
