"""What did the squads that actually won each round look like?

Reads the lineups harvested by fetch_winning_lineups.py and reduces them to the
handful of patterns worth copying. This is the only evidence in the project about
what WINNING looks like rather than what scores well in a backtest.
"""
import collections
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

rows = json.loads((config.RAW / "winning_lineups_2526.json").read_text())
ok = [r for r in rows if r["starters"] and r["bench"] and r["coach"]]
pg = pd.read_parquet(config.DATA / "player_game.parquet")
e = pg[(pg.competition == "E") & (pg.season == "E2025")]
tg = e.groupby("team_code").gamecode.nunique()
ppg = (e.groupby("player").pir.sum()
       / e.groupby("player").team_code.agg(lambda s: tg[s.mode().iat[0]]))

full, bench, caps, coaches, clubs = [], [], [], [], []
for r in ok:
    f = r["starters"] + ([r["sixth"]] if r["sixth"] else [])
    full += [p["player"] for p in f]
    bench += [p["player"] for p in r["bench"]]
    if r["captain"]:
        caps.append(r["captain"])
    coaches.append(r["coach"])
    clubs.append(collections.Counter(
        p["team"] for p in r["starters"] + r["bench"] + ([r["sixth"]] if r["sixth"] else [])))

fs, bs = ppg.reindex(full).dropna(), ppg.reindex(bench).dropna()
cp = ppg.reindex([c["player"] for c in caps]).dropna()
scores = [r["score"] for r in ok if r["score"]]

summary = {
    "n_lineups": len(ok),
    "round_win_score": {"mean": round(float(np.mean(scores)), 1),
                        "min": round(float(min(scores)), 1),
                        "max": round(float(max(scores)), 1)},
    "full_slots_pir": round(float(fs.mean()), 1),
    "bench_slots_pir": round(float(bs.mean()), 1),
    "bench_ratio": round(float(bs.mean() / fs.mean()), 2),
    "bench_under_5": round(float((bs < 5).mean()), 2),
    "captain_pir": round(float(cp.mean()), 1),
    "captain_positions": dict(collections.Counter(c["position"] for c in caps)),
    "clubs_per_squad": round(float(np.mean([len(c) for c in clubs])), 1),
    "max_from_one_club": int(max(max(c.values()) for c in clubs)),
    "mean_max_from_one_club": round(float(np.mean([max(c.values()) for c in clubs])), 1),
    "top_players": [{"player": p, "n": n, "pir": round(float(ppg.get(p, np.nan)), 1)}
                    for p, n in collections.Counter(full).most_common(8)],
    "top_bench": [{"player": p, "n": n, "pir": round(float(ppg.get(p, np.nan)), 1)}
                  for p, n in collections.Counter(bench).most_common(6)],
    "top_coaches": [{"coach": c, "n": n} for c, n in collections.Counter(coaches).most_common(5)],
}
(config.DATA / "winner_patterns.json").write_text(json.dumps(summary, indent=1))

print(f"{summary['n_lineups']} winning lineups, 2025-26 (2x captain)\n")
print(f"  a round-winning score: {summary['round_win_score']['mean']} on average "
      f"({summary['round_win_score']['min']}-{summary['round_win_score']['max']})")
print(f"  full-scoring six averaged {summary['full_slots_pir']} PIR/g; the bench four "
      f"{summary['bench_slots_pir']} ({summary['bench_ratio']:.0%})")
print(f"  {summary['bench_under_5']:.0%} of bench picks scored under 5 PIR a game")
print(f"  captains averaged {summary['captain_pir']} PIR/g; positions {summary['captain_positions']}")
print(f"  {summary['clubs_per_squad']} clubs per squad, never more than "
      f"{summary['max_from_one_club']} from one club")
print("\n  most-picked in full-scoring slots:")
for p in summary["top_players"]:
    print(f"    {p['n']:>2}x  {p['player']:<28}{p['pir']:.1f}")
print("  most-picked bench filler:")
for p in summary["top_bench"]:
    print(f"    {p['n']:>2}x  {p['player']:<28}{p['pir']:.1f}")
