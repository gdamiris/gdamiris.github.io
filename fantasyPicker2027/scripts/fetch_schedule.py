"""Pull every fantasy matchday's schedule for the season.

A fantasy 'matchday' (= a Round you pick a team for) can contain more than one
EuroLeague round, so a team may play once or twice inside a single Round. That
games-per-team count is the dominant driver of expected fantasy points, so we
materialise it here as data/schedule.json + a printed matrix.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.dunkest import Dunkest

FIRST_MATCHDAY = 1528  # Round 1 of 2026-27

d = Dunkest()
matchdays = []
mid = FIRST_MATCHDAY
while True:
    try:
        data = d.get(f"/schedules/{config.PLAYERS_LIST_ID}/matchdays/{mid}", lang="en")["data"]
    except Exception:
        break
    matchdays.append(data)
    mid += 1
    if mid > FIRST_MATCHDAY + 60:
        break

print(f"{len(matchdays)} matchdays: {matchdays[0]['number']}..{matchdays[-1]['number']}"
      f" (ids {FIRST_MATCHDAY}..{FIRST_MATCHDAY + len(matchdays) - 1})\n")

teams: dict[str, str] = {}
counts: dict[int, dict[str, int]] = {}
for md in matchdays:
    per = defaultdict(int)
    for rnd in md.get("rounds") or []:
        for m in rnd.get("matches") or []:
            for side in ("home_team", "away_team"):
                t = m[side]
                teams[t["abbreviation"]] = t["name"]
                per[t["abbreviation"]] += 1
    counts[md["number"]] = dict(per)

out = {"first_matchday_id": FIRST_MATCHDAY, "matchdays": matchdays, "games_per_team": counts}
(config.DATA / "schedule.json").write_text(json.dumps(out, indent=1))

abbrs = sorted(teams)
nums = sorted(counts)
print("games per team per Round (. = 0, 1, 2):")
print("      " + "".join(f"{n%100:>3}" for n in nums))
for a in abbrs:
    row = "".join(f"{counts[n].get(a, 0) or '.':>3}" for n in nums)
    print(f"{a:<5} {row}")

print("\nRounds with any team playing twice:")
for n in nums:
    dbl = [a for a, c in counts[n].items() if c >= 2]
    if dbl:
        print(f"  R{n:<3} ({len(dbl)} teams): {' '.join(sorted(dbl))}")
tot = defaultdict(int)
for n in nums:
    for a, c in counts[n].items():
        tot[a] += c
print("\ntotal games:", dict(sorted(tot.items(), key=lambda kv: -kv[1])))
