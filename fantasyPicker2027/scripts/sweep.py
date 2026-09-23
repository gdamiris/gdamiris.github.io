"""Hyperparameter sweep + ensemble search for the projection model.

The plain decomposed model loses to 'last season's PIR per game', so before
shipping anything we search decay/shrinkage settings and test whether blending
the two helps. Train strictly on seasons before the target.
"""
import itertools
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
import flp.projections as P

pg = pd.read_parquet(config.DATA / "player_game.parquet")
TARGETS = ["E2022", "E2023", "E2024", "E2025"]


def evaluate(decay, k_games, k_minutes, blend):
    """blend = weight on the decomposed model vs the last-season baseline."""
    maes, sps = [], []
    for target in TARGETS:
        year = int(target[1:])
        past, fut = pg[pg.season.astype(str) < target], pg[pg.season == target]
        actual = fut.groupby("player_id").agg(games=("player_id", "size"), pir=("pir", "sum"))
        actual = actual[actual.games >= 10]
        actual["y"] = actual.pir / actual.games

        old_decay = P.SEASON_DECAY
        P.SEASON_DECAY = decay
        agg = P.weighted_history(past, year).set_index("player_id")
        P.SEASON_DECAY = old_decay

        df = actual.join(agg, how="inner").dropna(subset=["w_min"])
        prior_min = (df.w_min / df.w_games).groupby(df.position).transform("mean")
        minutes = P.shrink(df.w_min, df.w_games, prior_min, k_games)
        rate_curve = P.fit_rate_by_minutes(past)
        rate = P.shrink(df.w_pir, df.w_min,
                        pd.Series(rate_curve(minutes), index=df.index), k_minutes)
        model = minutes * rate

        prev = pg[pg.season == f"E{year - 1}"].groupby("player_id").agg(
            g=("player_id", "size"), p=("pir", "sum"))
        last = (prev.p / prev.g).reindex(df.index)
        # Players absent last season fall back entirely on the model.
        pred = np.where(last.notna(), blend * model + (1 - blend) * last.fillna(0), model)

        maes.append(np.abs(pred - df.y).mean())
        sps.append(spearmanr(pred, df.y).statistic)
    return float(np.mean(maes)), float(np.mean(sps))


print("=== blend sweep (decay=0.55, k_games=10, k_min=250) ===")
for b in [0.0, 0.25, 0.4, 0.5, 0.6, 0.75, 1.0]:
    mae, sp = evaluate(0.55, 10, 250, b)
    print(f"  blend={b:.2f}  MAE={mae:.4f}  spearman={sp:.4f}")

print("\n=== grid search ===")
best = None
results = []
for decay, kg, km, b in itertools.product([0.4, 0.55, 0.7, 0.85], [5, 10, 20],
                                          [150, 250, 400], [0.3, 0.5, 0.7]):
    mae, sp = evaluate(decay, kg, km, b)
    results.append((mae, sp, decay, kg, km, b))
    if best is None or mae < best[0]:
        best = (mae, sp, decay, kg, km, b)
res = pd.DataFrame(results, columns=["MAE", "spearman", "decay", "k_games", "k_min", "blend"])
print(res.nsmallest(10, "MAE").round(4).to_string(index=False))
print("\ntop 5 by rank correlation:")
print(res.nlargest(5, "spearman").round(4).to_string(index=False))
print(f"\nbest MAE config: decay={best[2]} k_games={best[3]} k_min={best[4]} blend={best[5]} "
      f"-> MAE {best[0]:.4f}, spearman {best[1]:.4f}")
