"""How much is the between-Turns captain switch worth, and who should wear it?

The rules let you move the captaincy to any player who has not yet tipped off. So a
Turn 1 captain is really an option: if he flops you move the armband to a Turn 2
player. That means captaining a Turn 1 player with a strong Turn 2 team-mate behind
him beats captaining the same player with nobody behind him -- and can beat
captaining the higher-projected Turn 2 player outright.

Value of the switch = E[max(captain's ACTUAL, best Turn 2 alternative's expected)]
                      - E[captain's actual]
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config

RNG = np.random.default_rng(3)
N = 60_000

pg = pd.read_parquet(config.DATA / "player_game.parquet")
e = pg[(pg.competition == "E") & pg.season.isin(["E2023", "E2024", "E2025"])].copy()
role = e.groupby(["season", "player_id"]).agg(mpg=("minutes", "mean"), n=("pir", "size")).reset_index()
e = e.merge(role[role.n >= 15][["season", "player_id", "mpg"]], on=["season", "player_id"])
EDGES = [0, 6, 10, 14, 18, 22, 99]
e["b"] = pd.cut(e.mpg, EDGES, labels=False)
POOLS = {int(b): g.pir.values.astype(float) for b, g in e.groupby("b")}
MEANS = {b: v.mean() for b, v in POOLS.items()}


def draw(minutes, mean):
    b = int(np.clip(np.digitize(minutes, EDGES) - 1, 0, len(EDGES) - 2))
    scale = mean / MEANS[b] if MEANS[b] > 0.25 else 1.0
    return RNG.choice(POOLS[b], size=N, replace=True) * scale


print("Captain options, simulated on real outcome distributions.\n")
print(f"{'T1 captain':>10} {'T2 alt':>8}   {'no switch':>10} {'with switch':>12} {'gain':>7}")
for t1 in (12.0, 16.0, 20.0):
    for t2 in (0.0, 8.0, 12.0, 16.0):
        x = draw(24, t1)
        no_switch = x.mean()
        # switch if the Turn 2 alternative's expectation beats what the captain actually did
        with_switch = np.maximum(x, t2).mean() if t2 > 0 else no_switch
        print(f"{t1:>10.0f} {t2:>8.0f}   {no_switch:>10.2f} {with_switch:>12.2f} "
              f"{with_switch - no_switch:>+7.2f}")

print("\n=== so: is it better to captain the Turn 1 man or the Turn 2 man? ===")
print("captaining the T2 player forfeits the option entirely -- you learn nothing before he plays.\n")
for t1, t2 in ((16.0, 18.0), (16.0, 16.0), (18.0, 16.0), (20.0, 14.0)):
    cap_t1 = np.maximum(draw(24, t1), t2).mean()
    cap_t2 = draw(24, t2).mean()
    better = "captain T1" if cap_t1 > cap_t2 else "captain T2"
    print(f"  T1 man {t1:.0f} / T2 man {t2:.0f}:  captain-T1 {cap_t1:5.2f} vs captain-T2 {cap_t2:5.2f}"
          f"  -> {better}")
