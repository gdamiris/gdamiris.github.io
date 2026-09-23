"""Projecting fantasy points for a round.

The model separates the two drivers of a fantasy score, because they have very
different stability:

    proj_PIR = E[minutes] x E[PIR per minute]

PIR-per-minute is a reasonably stable player trait, so it is shrunk toward a
positional mean. Minutes are a volatile team/role decision, so they are shrunk
toward a *price-conditional* prior: the fantasy price is the operator's own view
of a player's role, and it is the only role signal we have for the ~23% of the
pool with no EuroLeague history (NBA and college arrivals).

Getting that prior right matters more than it sounds. Fitting the minutes prior
only on established players hands every unknown 4-credit end-of-bench player an
18-minute rotation role, which an optimiser will happily exploit by filling the
bench with punts.
"""
from __future__ import annotations

import unicodedata

import numpy as np
import pandas as pd

# Tuned by scripts/sweep.py against 2022-25 held-out seasons. The decomposed model
# alone LOSES to 'last season's PIR per game' (MAE 2.81 vs 2.75); blended 50/50 with
# it, the pair beats either component (2.70). Keep BLEND_MODEL honest -- if a future
# change makes the model better standalone, re-tune rather than assuming.
K_MINUTES = 400.0    # minutes of evidence before PIR/min trusts the player over the prior
K_GAMES = 20.0       # games of evidence before minutes trusts the player over the prior
SEASON_DECAY = 0.85  # weight multiplier per season into the past
# Weight on the model term vs last season's realised output. 0.5 minimises raw error
# but under-projects (bias -0.19); 0.4 gives up almost nothing (MAE 2.739 -> 2.760,
# rank correlation unchanged) and halves the bias, which matters because the whole
# model runs cold against real scoring.
BLEND_MODEL = 0.4
# The SD that matters is not how much margins vary (13.2) but how much they vary AROUND
# OUR FORECAST. Club strength predicts a single game only loosely -- correlation ~0.40,
# residual SD 11.9 measured over four held-out seasons -- and using the raw 13.2 instead
# over-disperses, flattening the coach spread: it understates good coaches and overstates
# bad ones, precisely backwards for choosing between them.
MARGIN_SD = 11.9

# EuroCup is the same feed and covers ~30% of the players who have no EuroLeague
# record at all. Production does not carry over one-for-one: measured across 191
# players who made the jump the season after, minutes scale by 0.73 and PIR-per-minute
# by 0.72. It is also noisier evidence than EuroLeague itself (r=0.60 vs ~0.68), so
# it carries reduced weight -- tuned by scripts/sweep_eurocup.py.
EUROCUP_MINUTES_RATIO = 0.726
EUROCUP_RATE_RATIO = 0.719
EUROCUP_EVIDENCE_WEIGHT = 1.0

# Generational suffixes and middle initials appear inconsistently between the
# fantasy pool and the stats feed ('BALDWIN IV WADE' vs 'Baldwin, Wade'), which
# silently breaks the join for real players -- so drop them on both sides.
NAME_SUFFIXES = {"JR", "JNR", "SR", "SNR", "II", "III", "IV", "V", "VI"}


def normalise_name(name: str) -> str:
    """'Vezenkov, Sasha' / 'BALDWIN IV, WADE' -> 'VEZENKOV SASHA' / 'BALDWIN WADE'."""
    if not isinstance(name, str):
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.upper().replace(",", " ").replace(".", " ").replace("-", " ").replace("'", "")
    return " ".join(t for t in s.split() if t not in NAME_SUFFIXES and len(t) > 1)


def season_year(code: str) -> int:
    return int(str(code)[1:])


def weighted_history(pg: pd.DataFrame, target_year: int) -> pd.DataFrame:
    """Per-player exponentially-weighted totals across seasons.

    Note games are counted as *appearances* but a dressed-but-unused game is a
    real signal about role, so DNPs count toward games with zero minutes.
    """
    df = pg.copy()
    age = target_year - df.season.map(season_year)
    df["w"] = SEASON_DECAY ** age.clip(lower=0)

    # Translate EuroCup output onto the EuroLeague scale before it is pooled.
    if "competition" in df.columns:
        is_u = df.competition.eq("U")
        df.loc[is_u, "w"] *= EUROCUP_EVIDENCE_WEIGHT
        df["minutes"] = np.where(is_u, df.minutes * EUROCUP_MINUTES_RATIO, df.minutes)
        df["pir"] = np.where(
            is_u, df.pir * EUROCUP_MINUTES_RATIO * EUROCUP_RATE_RATIO, df.pir)

    df["w_min"] = df.w * df.minutes
    df["w_pir"] = df.w * df.pir
    df["w_games"] = df.w
    df["w_starts"] = df.w * df.is_starter.astype(float)
    df["w_played"] = df.w * df.played.astype(float)

    agg = df.groupby("player_id").agg(
        player=("player", "last"),
        position=("position", "last"),
        last_season=("season", "max"),
        appearances=("played", "sum"),
        w_games=("w_games", "sum"),
        w_played=("w_played", "sum"),
        w_min=("w_min", "sum"),
        w_pir=("w_pir", "sum"),
        w_starts=("w_starts", "sum"),
    ).reset_index()
    agg["name_key"] = agg.player.map(normalise_name)
    return agg


def positional_pir_rate(agg: pd.DataFrame) -> tuple[pd.Series, float]:
    """PIR per minute by position, from players with a meaningful sample."""
    solid = agg[agg.w_min > 300]
    by_pos = solid.groupby("position").w_pir.sum() / solid.groupby("position").w_min.sum()
    return by_pos, float(solid.w_pir.sum() / max(solid.w_min.sum(), 1))


def fit_price_curve(price: pd.Series, value: pd.Series, deg: int = 2,
                    lo: float = 0.0, hi: float = 1e9) -> callable:
    """Least-squares curve of `value` on price, clipped to a sane range.

    Used for the minutes prior: price is the market's estimate of a player's role.
    """
    ok = price.notna() & value.notna()
    if ok.sum() < 25:
        return lambda p: np.clip(np.full(len(np.atleast_1d(p)), value[ok].median()), lo, hi)
    coef = np.polyfit(price[ok].astype(float), value[ok].astype(float), deg)
    poly = np.poly1d(coef)
    return lambda p: np.clip(poly(np.asarray(p, dtype=float)), lo, hi)


def shrink(total: pd.Series, weight: pd.Series, prior, k: float) -> pd.Series:
    """Empirical-Bayes: pull a player's own rate toward a prior by k units."""
    return (total.fillna(0.0) + k * prior) / (weight.fillna(0.0) + k)


def team_strength(cg: pd.DataFrame, target_year: int) -> pd.Series:
    """Exponentially-weighted average scoring margin per club."""
    df = cg.copy()
    age = target_year - df.season.map(season_year)
    df["w"] = SEASON_DECAY ** age.clip(lower=0)
    return ((df.w * df.margin).groupby(df.team_code).sum()
            / df.w.groupby(df.team_code).sum()).rename("strength")


def expected_coach_points(margin_mu: float, sd: float = MARGIN_SD, draws: int = 40000,
                          rng: np.random.Generator | None = None) -> float:
    """Coach scoring is a step function of margin, so integrate it numerically."""
    rng = rng or np.random.default_rng(0)
    m = rng.normal(margin_mu, sd, draws)
    pts = np.where(m > 0,
                   np.where(m <= 10, 10, np.where(m <= 20, 20, 25)),
                   np.where(m >= -10, -5, np.where(m >= -20, -10, -20)))
    return float(pts.mean())


def fit_rate_by_minutes(pg: pd.DataFrame, seasons: list[str] | None = None,
                        min_games: int = 10):
    """Calibrate PIR-per-minute as a function of role size (minutes per game).

    PIR/min is emphatically *not* role-independent: measured across 2023-25 it runs
    ~0.21 for a 3-minute player against ~0.57 for a 30-minute starter. Using a flat
    positional prior therefore roughly doubles the projection for deep-bench players,
    which an optimiser will exploit by stuffing the bench with minimum-price punts.
    """
    df = pg if seasons is None else pg[pg.season.isin(seasons)]
    ps = df.groupby(["season", "player_id"]).agg(
        mins=("minutes", "sum"), pir=("pir", "sum"), games=("player_id", "size")).reset_index()
    ps = ps[(ps.games >= min_games) & (ps.mins > 0)]
    ps["mpg"] = ps.mins / ps.games
    ps["rate"] = ps.pir / ps.mins

    coef = np.polyfit(ps.mpg, ps.rate, 1, w=np.sqrt(ps.mins))
    poly = np.poly1d(coef)
    lo, hi = 0.10, 0.75
    return lambda m: np.clip(poly(np.asarray(m, dtype=float)), lo, hi)


TEAM_MINUTES = 200.0    # 5 players x 40 minutes -- a hard per-game budget
ROTATION_DEPTH = 8      # players a EuroLeague club realistically gives real minutes
TAPER_WIDTH = 4.0       # ranks over which minutes fade past that depth
TAPER_FLOOR = 0.35      # never zero a player out entirely -- ranking is too noisy for that
RANK_PRICE_MIX = 0.5    # rank ordering: half the player's record, half his price


def minutes_by_rank(pg: pd.DataFrame, seasons: list[str] | None = None) -> pd.Series:
    """Average minutes by a player's within-team-game minutes rank."""
    df = pg if seasons is None else pg[pg.season.isin(seasons)]
    d = df.copy()
    d["rank"] = d.groupby(["season", "gamecode", "team_code"]).minutes.rank(
        ascending=False, method="first")
    return d.groupby("rank").minutes.mean()


def taper_fringe_minutes(minutes: pd.Series, teams: pd.Series,
                         price_minutes: pd.Series | None = None,
                         depth: int = ROTATION_DEPTH,
                         width: float = TAPER_WIDTH,
                         floor: float = TAPER_FLOOR) -> pd.Series:
    """Fade out minutes for players ranked past their club's rotation depth.

    Per-player estimates are built from each player's *previous* role, so a club's
    projected minutes sum to far more than the 200 available -- our pool averages
    1.40x. The tempting fix, scaling every club back to 200, is WRONG and measurably
    so: it robs genuine rotation players to pay for phantom minutes assigned to
    fringe players who will never appear. Validated on held-out seasons against
    PIR-per-team-game (DNP = 0), proportional normalisation is worse than doing
    nothing (MAE 3.128 vs 3.139) while tapering the fringe clearly helps (2.993).

    So: fade only the players past the rotation, THEN cap what remains at 200. Order
    matters -- capping first was what made normalisation look harmful, because the
    phantom minutes were still in the sum.

    Two refinements matter as much as the taper itself.

    First, the taper has a floor: rank ordering is far too noisy to justify zeroing
    anyone outright (held-out MAE 2.981 -> 2.936 from the floor alone).

    Second, the ordering blends each player's own record with his PRICE. Ranking on
    the record alone lets an unknown player displace a proven one on a price guess,
    which is how a 192-game veteran ended up projected for zero minutes. But ranking
    by record discounted for uncertainty is worse still -- it buries every new
    signing regardless of calibre, which sent a 15.5cr starting centre to 3.8 points.
    Price is the club's own role estimate and it is stated for everyone, rookie or
    veteran, so it is the one signal that treats both fairly. Note this half is a
    judgement call, NOT backtested: prices do not exist for historical seasons.
    """
    key = minutes if price_minutes is None else (
        (1 - RANK_PRICE_MIX) * minutes + RANK_PRICE_MIX * price_minutes.fillna(minutes))
    rank = key.groupby(teams).rank(ascending=False, method="first")
    tapered = minutes * np.clip(1.0 - (rank - depth) / width, floor, 1.0)
    total = tapered.groupby(teams).transform("sum")
    scale = np.minimum(1.0, TEAM_MINUTES / total.replace(0, np.nan)).fillna(1.0)
    return tapered * scale


AGE_PEAK = 25.0            # production starts falling away from here
AGE_SLOPE_ROTATION = -0.03  # per year past the peak, for players in a real role
AGE_SLOPE_FRINGE = -0.05    # per year, for everyone else
AGE_ROLE_SPLIT = 20.0       # minutes per game that counts as a real role
AGE_CLIP = (0.35, 1.6)


def age_multiplier(age: pd.Series | np.ndarray,
                   minutes: pd.Series | np.ndarray | None = None,
                   peak: float = AGE_PEAK) -> np.ndarray:
    """Scale a projection for a player's age.

    Long histories are a double-edged input: a 34-year-old's weighted record still
    carries seasons he can no longer repeat.

    But one global slope has to serve two very different populations, and it ends up
    tracking the wrong one. Fringe veterans fall out of rotations fast; players still
    holding a real role decline far more gently -- Vezenkov went 17.8, 21.5, 23.7,
    22.1 through ages 27 to 31, and a flat 5% slope took 31% off him for a decline
    that is simply not happening. Splitting the slope by role size is better on every
    measure at once: MAE 2.719 -> 2.708, rank correlation 0.6755 -> 0.6759, and bias
    -0.153 -> -0.052.
    """
    # `minutes` must be the player's OWN role estimate, before the rotation taper.
    # Feeding tapered minutes back in creates a loop: the taper cuts a crowded club's
    # starter under the threshold, the harsher slope then cuts him again.
    a = pd.Series(age).astype(float).fillna(27.0).values
    if minutes is None:
        slope = np.full_like(a, AGE_SLOPE_FRINGE)
    else:
        m = pd.Series(minutes).astype(float).fillna(0.0).values
        slope = np.where(m >= AGE_ROLE_SPLIT, AGE_SLOPE_ROTATION, AGE_SLOPE_FRINGE)
    delta = np.where(a > peak, slope * (a - peak), 0.0)
    return np.clip(1.0 + delta, *AGE_CLIP)


# Minutes are allocated per position, not per club. Measured across 2023-25, a club
# spends 84.8 minutes a game on guards, 76.8 on forwards and only 39.8 on centres --
# and the depth differs just as much: 4.4 guards see the floor against 2.4 centres.
# So a club's second guard plays ~23 minutes while its second centre plays ~14, and
# its third centre falls to 8. Ranking players club-wide, ignoring position, gets all
# of that wrong.
POSITION_MINUTES = {"Guard": 84.8, "Forward": 76.8, "Center": 39.8}
POSITION_DEPTH = {"Guard": 4, "Forward": 4, "Center": 2}

# Real rotations are far more concentrated than a taper-and-cap produces. A club's
# top six average 24.3 minutes; tapering the fringe and scaling the rest to 200 gave
# 18.0, because the fantasy pool lists up to 21 players per club and the taper floor
# keeps them all faintly alive, so they soak up budget the starters should get.
# Blending toward the empirical minutes-by-rank curve restores the real shape.
# Blending toward the empirical rank curve restores the real shape. It costs a little
# held-out MAE (2.718 -> 2.737) because assigning by predicted rank is higher variance
# than hedging everyone toward the middle -- but hedging produces a club whose top six
# project 18.0 minutes against the 24.3 they actually play, which understates every
# star in the pool. 0.5 splits the difference; a full 1.0 nails the calibration but
# costs too much accuracy.
CONCENTRATION = 0.5

# Calibration targets, measured over 2024-25 club-games.
TARGET_TOP6_PIR = 14.02
TARGET_CLUB_PIR = 89.9


def taper_by_position(minutes: pd.Series, teams: pd.Series, positions: pd.Series,
                      price_minutes: pd.Series | None = None,
                      width: float = TAPER_WIDTH,
                      floor: float = TAPER_FLOOR,
                      cap: str = "club",
                      scarce_only: bool = False,
                      rank_curve: pd.Series | None = None,
                      concentration: float = CONCENTRATION) -> pd.Series:
    """Fade and cap minutes within each club-and-position group.

    Two separable mechanisms, and they want different scopes.

    RANKING is positional: a player competes with his club's other players at his
    position, not with all ten. Being third centre is far worse than being third
    guard -- rank 3 is 8.0 minutes at centre against 18.0 at guard.

    The BUDGET is not. Capping each position at its own slice measurably hurts
    (MAE 2.728 vs 2.716), because listed positions are noisy: forwards play centre,
    guards play forward, and a rigid per-position budget punishes exactly the players
    who slide between roles. Capping at the club's 200 instead keeps the constraint
    honest without trusting the label too far.

    Position ranking with a club-level cap is the best of the three: rank correlation
    0.676 against 0.669, and centre MAE 2.859 against 2.934, for no real cost overall.
    """
    out = pd.Series(0.0, index=minutes.index)
    key = minutes if price_minutes is None else (
        (1 - RANK_PRICE_MIX) * minutes + RANK_PRICE_MIX * price_minutes.fillna(minutes))

    for (team, pos), idx in minutes.groupby([teams, positions]).groups.items():
        idx = pd.Index(idx)
        if scarce_only and pos != "Center":
            out.loc[idx] = minutes.reindex(idx)
            continue
        depth = POSITION_DEPTH.get(pos, 4)
        rank = key.reindex(idx).rank(ascending=False, method="first")
        tapered = minutes.reindex(idx) * np.clip(1.0 - (rank - depth) / width, floor, 1.0)
        if cap == "position":
            budget = POSITION_MINUTES.get(pos, 70.0)
            total = tapered.sum()
            if total > budget:
                tapered = tapered * (budget / total)
        out.loc[idx] = tapered

    if cap == "club":
        for team, idx in out.groupby(teams).groups.items():
            idx = pd.Index(idx)
            vals = out.reindex(idx)
            if rank_curve is not None and concentration > 0:
                r = key.reindex(idx).rank(ascending=False, method="first")
                shape = pd.Series(rank_curve.reindex(r.values).fillna(0.0).values, index=idx)
                vals = (1 - concentration) * vals + concentration * shape
            total = vals.sum()
            if total > 0:
                vals = vals * (TEAM_MINUTES / total)
            out.loc[idx] = vals
    return out



# Opponent quality and venue move a player's own output, not just his club's odds of
# winning. Measured over eight EuroLeague seasons against each player's own average:
# facing the leakiest defence rather than the stingiest is worth +1.53 PIR to a
# 12-PIR player, and playing at home is worth +1.09. Both scale with the player, so
# they are applied proportionally. (Rest does not matter -- days between games moves
# PIR by less than 0.15, so it is deliberately not modelled.)
OPP_SLOPE = 0.0108     # fractional change per point of opponent points-allowed
OPP_CLIP = (0.90, 1.10)
HOME_EDGE = 0.045      # +4.5% at home, -4.5% away


def opponent_factor(opp_points_allowed: pd.Series, league_mean: float) -> pd.Series:
    """Scale a projection for how much the opponent concedes."""
    f = 1.0 + OPP_SLOPE * (opp_points_allowed.astype(float) - league_mean)
    return f.clip(*OPP_CLIP).fillna(1.0)


def home_factor(is_home: pd.Series) -> pd.Series:
    return pd.Series(np.where(is_home, 1.0 + HOME_EDGE, 1.0 - HOME_EDGE), index=is_home.index)


def defensive_ratings(cg: pd.DataFrame, target_year: int) -> tuple[pd.Series, float]:
    """Exponentially-weighted points allowed per club, plus the league mean."""
    df = cg[cg.competition == "E"].copy() if "competition" in cg.columns else cg.copy()
    age = target_year - df.season.map(season_year)
    df["w"] = SEASON_DECAY ** age.clip(lower=0)
    num = (df.w * df.opp_score).groupby(df.team_code).sum()
    den = df.w.groupby(df.team_code).sum()
    pa = (num / den).rename("pa")
    return pa, float((df.w * df.opp_score).sum() / df.w.sum())


def redistribute_injured_minutes(minutes: pd.Series, teams: pd.Series,
                                 positions: pd.Series, available: pd.Series) -> pd.Series:
    """Hand an unavailable player's minutes to his team-mates at the same position.

    Zeroing an injured player is only half the story: the 200 minutes still get played.
    When Panathinaikos lose two rotation players, the minutes do not vanish, they go to
    whoever is left in that position group -- which is exactly when a mid-priced
    team-mate becomes a bargain, and the model should see it before the price does.

    Redistribution is proportional to each survivor's existing share, and capped so no
    one is handed more than a realistic starter's load.
    """
    out = minutes.copy()
    out[~available] = 0.0
    for (team, pos), idx in minutes.groupby([teams, positions]).groups.items():
        idx = pd.Index(idx)
        live = idx[available.reindex(idx).fillna(True).astype(bool)]
        lost = float(minutes.reindex(idx).sum() - minutes.reindex(live).sum())
        if lost <= 0 or len(live) == 0:
            continue
        share = out.reindex(live)
        total = share.sum()
        if total <= 0:
            continue
        out.loc[live] = (share + lost * share / total).clip(upper=34.0)
    return out


COACH_BANDS = [("win 21+", 25), ("win 11-20", 20), ("win 1-10", 10),
               ("loss 1-10", -5), ("loss 11-20", -10), ("loss 21+", -20)]


def coach_band_probabilities(margin_mu: float, sd: float = MARGIN_SD,
                             draws: int = 60000,
                             rng: np.random.Generator | None = None) -> dict:
    """Chance of landing in each coach scoring band.

    Coach scoring is a step function, never a sliding scale: a two-point win and a
    ten-point win both pay exactly +10. So the expected value alone is misleading --
    two coaches on the same average can have very different shapes, and the one with
    real blowout upside is worth more than the one grinding out narrow wins. This
    returns the distribution so the choice can be made on shape, not just mean.
    """
    rng = rng or np.random.default_rng(0)
    m = rng.normal(margin_mu, sd, draws)
    return {
        "win 21+": float((m > 20).mean()),
        "win 11-20": float(((m > 10) & (m <= 20)).mean()),
        "win 1-10": float(((m > 0) & (m <= 10)).mean()),
        "loss 1-10": float(((m <= 0) & (m >= -10)).mean()),
        "loss 11-20": float(((m < -10) & (m >= -20)).mean()),
        "loss 21+": float((m < -20).mean()),
    }
