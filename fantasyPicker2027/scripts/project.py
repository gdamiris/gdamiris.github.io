"""Project fantasy points for a round -> data/projections/roundNN.csv."""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from flp import config
from flp.projections import (BLEND_MODEL, K_GAMES, K_MINUTES, MARGIN_SD,
                             expected_coach_points, fit_price_curve, fit_rate_by_minutes,
                             age_multiplier, defensive_ratings, home_factor, minutes_by_rank, normalise_name,
                             redistribute_injured_minutes,
                             opponent_factor, shrink, taper_by_position,
                             team_strength, weighted_history)

ap = argparse.ArgumentParser()
ap.add_argument("--round", type=int, default=1)
ap.add_argument("--target-year", type=int, default=2026)
ap.add_argument("--quiet", action="store_true")
args = ap.parse_args()

pg = pd.read_parquet(config.DATA / "player_game.parquet")
cg = pd.read_parquet(config.DATA / "coach_game.parquet")
pool = pd.read_csv(config.DATA / "players" / f"round{args.round:02d}.csv")
pool["name_key"] = (pool.last_name.fillna("") + " " + pool.first_name.fillna("")).map(normalise_name)

players = pool[pool.position != "Head Coach"].copy()
coaches = pool[pool.position == "Head Coach"].copy()

# ------------------------------------------------------------------ history join
agg = weighted_history(pg, args.target_year)
hist = agg.drop_duplicates("name_key").set_index("name_key")
players = players.join(hist[["w_min", "w_pir", "w_games", "w_played", "w_starts", "appearances"]],
                       on="name_key")
matched = players.w_min.notna()

# ------------------------------------------------------------------ rate & minutes
# Order matters: estimate the role (minutes) first, because the PIR-per-minute prior
# depends on role size -- bench players are far less productive per minute.
obs_min = (players.w_min / players.w_games).where(players.w_games >= 12)
minutes_curve = fit_price_curve(players.price, obs_min, deg=2, lo=3.0, hi=32.0)
players["prior_minutes"] = minutes_curve(players.price)
players["raw_minutes"] = shrink(players.w_min, players.w_games, players.prior_minutes, K_GAMES)

# Estimates reflect each player's PREVIOUS role, so clubs project ~1.4x the 200
# minutes available. Fade the fringe rather than taxing the whole roster (see
# taper_fringe_minutes -- proportional scaling measurably hurts).
avail = ~players.is_injured.fillna(False) & players.prob_playing.fillna(1).gt(0)
# An injured player's minutes do not vanish -- they go to his team-mates at that position.
players["avail_minutes"] = redistribute_injured_minutes(
    players.raw_minutes, players.team_abbr, players.position, avail)
players["minutes_pg"] = taper_by_position(
    players.avail_minutes, players.team_abbr, players.position,
    price_minutes=players.prior_minutes.where(avail, 0.0),
    rank_curve=minutes_by_rank(pg[pg.competition == "E"], ["E2023", "E2024", "E2025"]))

rate_curve = fit_rate_by_minutes(pg)
players["prior_rate"] = rate_curve(players.minutes_pg)
players["pir_per_min"] = shrink(players.w_pir, players.w_min, players.prior_rate, K_MINUTES)

players["start_rate"] = shrink(players.w_starts, players.w_games, 0.35, K_GAMES)
players["confidence"] = players.w_min.fillna(0) / (players.w_min.fillna(0) + K_MINUTES)
players["model_pir"] = players.minutes_pg * players.pir_per_min

# Blend with the stubborn baseline: last season's PIR per game. Backtesting says the
# pair beats either alone. Players with no last season fall back on the model.
# Last season's output per TEAM game, not per game he was listed for -- a player who
# missed half the season is worth half as much to own, and that must show.
prev_season = f"E{args.target_year - 1}"
prev = pg[pg.season == prev_season]
prev_tg = prev.groupby("team_code").gamecode.nunique()
prev_agg = prev.groupby("player_id").agg(
    p=("pir", "sum"), team=("team_code", lambda s: s.mode().iat[0]),
    games=("pir", "size"))
prev_pir_pg = (prev_agg.p / prev_agg.team.map(prev_tg)).rename("last_pir_pg")
prev_games = prev_agg.games.rename("last_games")
key_to_id = agg.drop_duplicates("name_key").set_index("name_key").player_id
players["last_pir_pg"] = players.name_key.map(key_to_id).map(prev_pir_pg)
players["last_games"] = players.name_key.map(key_to_id).map(prev_games)
# what he actually banked per round last season, win bonus included
players["last_fpts"] = players.last_pir_pg * 1.05
# Age applies to the MODEL term only. That term pools many seasons, so a 34-year-old's
# weighted record still carries games he can no longer repeat. The last-season term
# needs no such correction -- it already shows what he does at his current age, and
# discounting it again would penalise veterans twice.
dim = pd.read_parquet(config.DATA / "players_dim.parquet").set_index("player_id")
players["birth_date"] = players.name_key.map(key_to_id).map(dim.birth_date)
players["age"] = ((pd.Timestamp(f"{args.target_year}-10-01") - players.birth_date).dt.days / 365.25)
players["age_factor"] = age_multiplier(players.age, players.raw_minutes)
players["model_pir"] = players.model_pir * players.age_factor

players["proj_pir"] = np.where(
    players.last_pir_pg.notna(),
    BLEND_MODEL * players.model_pir + (1 - BLEND_MODEL) * players.last_pir_pg,
    players.model_pir)

# ------------------------------------------------------------------ team strength
res = pd.read_json(config.RAW / "results.json")
code_names = pd.concat([
    res[["home_code", "home_name"]].rename(columns={"home_code": "code", "home_name": "name"}),
    res[["away_code", "away_name"]].rename(columns={"away_code": "code", "away_name": "name"}),
]).drop_duplicates("code")
code_names["key"] = code_names.name.map(normalise_name)
hist_strength = team_strength(cg, args.target_year)
home_adv = cg.loc[cg.is_home, "margin"].mean()


def match_club(fantasy_name: str):
    """Fantasy club names carry sponsors the stats feed may not; match on tokens."""
    toks = set(normalise_name(fantasy_name).split())
    best, best_score = None, 0
    for _, row in code_names.iterrows():
        sc = len(toks & set(row.key.split()))
        if sc > best_score:
            best, best_score = row.code, sc
    return best


clubs = pd.unique(pd.concat([players.team, players.opponent]).dropna())
club_map = {c: match_club(c) for c in clubs}

# Club rating blends past results with who is actually on the roster now. History
# alone is blind to a club that lost its three best players; roster quality alone is
# noisier than history. Validated on four held-out seasons against actual club
# margin: blend 0.689 correlation, history alone 0.659, roster alone 0.530.
roster_quality = players.groupby("team_abbr").proj_pir.sum()
name_of_abbr = dict(zip(players.team_abbr, players.team))
name_of_abbr.update(dict(zip(players.opponent_abbr, players.opponent)))
hist_by_abbr = pd.Series({
    a: hist_strength.get(club_map.get(name_of_abbr.get(a)), np.nan)
    for a in players.team_abbr.unique()}).astype(float)
hz = (hist_by_abbr - hist_by_abbr.mean()) / hist_by_abbr.std()
qz = (roster_quality - roster_quality.mean()) / roster_quality.std()
blend = (0.5 * hz.fillna(0) + 0.5 * qz.reindex(hz.index).fillna(0))
strength_abbr = blend * hist_by_abbr.std() + hist_by_abbr.mean()

abbr_of = dict(zip(players.team, players.team_abbr))
abbr_of.update(dict(zip(players.opponent, players.opponent_abbr)))
sfn = lambda club: float(strength_abbr.get(abbr_of.get(club), 0.0) or 0.0)

for df in (players, coaches):
    df["exp_margin"] = (df.team.map(sfn) - df.opponent.map(sfn)
                        + np.where(df.home_away == "home", home_adv, -home_adv))

# Matchup: who he is playing, and where. Both move his own output, separately from
# the club's win probability.
pa, league_pa = defensive_ratings(cg, args.target_year)
players["opp_pa"] = players.opponent_abbr.map(
    lambda a: pa.get(club_map.get(name_of_abbr.get(a)) or a, np.nan))
players["opp_factor"] = opponent_factor(players.opp_pa, league_pa)
players["home_factor"] = home_factor(players.home_away.eq("home"))
players["proj_pir"] = players.proj_pir * players.opp_factor * players.home_factor

# Availability: 1.0 for everyone pre-season, but the feed populates it in-season.
players["prob_playing"] = players.prob_playing.fillna(1.0).clip(0, 1)
players["proj_pir"] = players.proj_pir * players.prob_playing

players["p_win"] = norm.cdf(players.exp_margin / MARGIN_SD)
players["proj"] = players.proj_pir * (1 + 0.10 * players.p_win)
players.loc[players.is_injured.fillna(False), "proj"] = 0.0
players["value"] = players.proj / players.price

coaches["proj"] = [expected_coach_points(m) for m in coaches.exp_margin]
coaches["proj_pir"] = coaches.proj
coaches["value"] = coaches.proj / coaches.price

cols = ["player_id", "first_name", "last_name", "position", "team", "team_abbr", "opponent",
        "opponent_abbr", "home_away", "price", "popularity", "is_injured", "appearances", "confidence",
        "prior_minutes", "raw_minutes", "avail_minutes", "minutes_pg", "prior_rate", "pir_per_min", "start_rate", "opp_pa", "opp_factor", "home_factor", "prob_playing", "exp_margin", "p_win",
        "model_pir", "last_pir_pg", "last_games", "last_fpts", "age", "age_factor", "proj_pir", "proj", "value"]
# Club-level tables the horizon projector needs, so it does not have to refit them.
(config.DATA / "club_ratings.json").write_text(json.dumps({
    "strength": {k: float(v) for k, v in strength_abbr.items()},
    "points_allowed": {a: float(pa.get(club_map.get(name_of_abbr.get(a)) or a, league_pa))
                       for a in set(players.team_abbr) | set(players.opponent_abbr.dropna())},
    "league_pa": float(league_pa), "home_adv": float(home_adv),
}, indent=1))

out_dir = config.DATA / "projections"
out_dir.mkdir(parents=True, exist_ok=True)
pd.concat([players.reindex(columns=cols), coaches.reindex(columns=cols)]).to_csv(
    out_dir / f"round{args.round:02d}.csv", index=False)

if not args.quiet:
    print(f"history matched: {matched.sum()}/{len(players)} ({matched.mean():.0%}); "
          f"{(players.confidence > 0.5).sum()} with a solid sample")
    print(f"home advantage {home_adv:+.2f} | blended club strength "
          f"{strength_abbr.min():+.1f}..{strength_abbr.max():+.1f}")
    print("strongest:", ", ".join(f"{k} {v:+.1f}" for k, v in strength_abbr.nlargest(5).items()))
    print("weakest:  ", ", ".join(f"{k} {v:+.1f}" for k, v in strength_abbr.nsmallest(5).items()))
    print("\nprice -> prior minutes -> prior PIR/min -> implied PIR:")
    for p in (4, 6, 8, 10, 12, 14, 17):
        mn = float(minutes_curve(p)); rt = float(rate_curve(mn))
        print(f"   {p:>2}cr -> {mn:5.1f} min -> {rt:.3f}/min -> {mn*rt:5.2f} PIR")
    print(f"\n=== top 12 projected ===")
    print(players.nlargest(12, "proj")[["last_name", "position", "team_abbr", "price",
          "minutes_pg", "pir_per_min", "confidence", "p_win", "proj", "value"]]
          .round(2).to_string(index=False))
    sq = players.groupby("team_abbr").minutes_pg.sum().round(0)
    print(f"\nteam projected minutes after taper: {sq.min():.0f}-{sq.max():.0f} (budget 200)")
    moved = (players.minutes_pg - players.raw_minutes)
    print("biggest minutes CUTS (crowded rosters):")
    print(players.assign(delta=moved).nsmallest(6, "delta")[
        ["last_name", "team_abbr", "price", "raw_minutes", "minutes_pg", "proj"]].round(1).to_string(index=False))
    print("biggest minutes GAINS (thin rosters):")
    print(players.assign(delta=moved).nlargest(6, "delta")[
        ["last_name", "team_abbr", "price", "raw_minutes", "minutes_pg", "proj"]].round(1).to_string(index=False))
    print(f"\n=== cheap end: 4.0-5.0cr, what do we now project? ===")
    cheap = players[players.price <= 5].nlargest(8, "proj")
    print(cheap[["last_name", "team_abbr", "price", "appearances", "minutes_pg",
                 "confidence", "proj"]].round(2).to_string(index=False))
    print(f"\nwrote {out_dir / f'round{args.round:02d}.csv'}")
