"""Squad selection as an integer linear program.

Picks 11 (4G/4F/2C + coach) under the 100-credit cap and the 6-per-club limit,
and simultaneously chooses a legal starting five, the captain, and the formation --
because those interact: a player is only worth his full projection if he starts,
half if benched, double if captained. Optimising the squad without the lineup
would systematically overvalue bench depth.
"""
from __future__ import annotations

import pandas as pd
import pulp

from .scoring import (BENCH_MULTIPLIER, BUDGET, CAPTAIN_MULTIPLIER, FORMATIONS,
                      MAX_PER_CLUB, SIXTH_MAN, SQUAD)

MAX_PER_FIXTURE = 3  # players drawn from any single game

# A benched player whose game is in a later Turn is worth more than his 50%: you get
# to see the earlier Turn's results and promote him. Simulated at ~0.3 points per
# late-Turn bench slot, and it costs nothing in expected points to prefer them.
LATE_TURN_BENCH_BONUS = 0.3

# The captaincy can be moved between Turns to anyone who has not yet tipped off, so a
# Turn 1 captain is an option: if he flops you move the armband to a Turn 2 player.
# Simulated on real outcome distributions that is worth +1.2 to +5.7 points a round,
# and it dominates so completely that captaining a Turn 1 player beats captaining a
# HIGHER-projected Turn 2 player (16 vs 18 projected: 21.5 against 18.0). Captaining
# in the last Turn forfeits the option entirely, so we forbid it whenever a later
# Turn exists to switch into.
CAPTAIN_EARLY_TURN = True

# Ownership leverage. In a large general league your rank moves on the DIFFERENCE
# between your score and the field's, so a player owned by 60% of managers carries
# most of his points for everyone and wins you little ground. A positive weight
# discounts the crowd's picks; a negative one hugs them, which is what you want when
# protecting a lead. Ownership reads zero for every player until the game opens, so
# this is inert pre-season and switches itself on when the feed populates.
OWNERSHIP_WEIGHT = 0.0

# The bench is NOT all minimum-price. Simulating against real outcome distributions,
# an all-cheap bench averages 110.6 a round; carrying exactly one genuinely good
# player who plays in the final Turn averages 112.6, and improves the downside too
# (10th percentile 69.4 against 67.7). The mechanism is the Turn swap: you only
# promote a bench player if he beats what your starter actually scored, so the option
# is worthless unless that player is good AND has not yet tipped off.
# One is the right number -- forcing two drops it to 108.4, and a uniformly
# mid-priced bench is worst of all at 106.8, because bench credits only return 50%.
# Forcing a quality player onto the bench helped when the model wrongly had only five
# slots scoring in full. With the sixth man modelled correctly he already IS the
# quality swing player, and a second one is redundant: all-cheap now has the better
# mean (115.9 vs 115.1). It does run hotter -- p10 70.6 against 75.2 -- but over a
# 38-round season the mean is what accumulates.
MIN_QUALITY_BENCH = 0
QUALITY_BENCH_PROJ = 8.0   # keyed on projected points, not price: the swap option
                           # needs a player who is actually good, and an expensive
                           # newcomer with no record is a guess, not a good player.


def _is_late(P, i) -> bool:
    """True when this player's game falls in the round's final Turn."""
    if "turn" not in P.columns:
        return False
    t = P.turn[i]
    return bool(pd.notna(t) and t == P.turn.max())


def optimise_squad(
    players: pd.DataFrame,
    coaches: pd.DataFrame,
    budget: float = BUDGET,
    max_per_club: int = MAX_PER_CLUB,
    max_per_fixture: int = MAX_PER_FIXTURE,
    late_turn_bonus: float = LATE_TURN_BENCH_BONUS,
    min_quality_bench: int = MIN_QUALITY_BENCH,
    quality_proj: float = QUALITY_BENCH_PROJ,
    min_bench_proj: float = 0.0,
    require_late_bench: bool = True,
    captain_early_turn: bool = CAPTAIN_EARLY_TURN,
    ownership_weight: float = OWNERSHIP_WEIGHT,
    coach_counts_to_club_limit: bool = False,
    locked: set | None = None,
    banned: set | None = None,
    current_squad: set | None = None,
    max_transfers: int | None = None,
) -> dict:
    """players/coaches need columns: player_id, position, price, team_abbr, proj.

    `proj` is expected points for the round being optimised. If a `proj_hold` column
    is present it values simply OWNING the player -- his projection averaged over the
    planning horizon, weighted by the chance you still hold him. Squad membership is
    then a multi-round decision while the lineup stays a decision about this round,
    which is what they actually are: you get four trades a round, so who you buy
    commits you well past Round 1, but who you start does not.

    `max_per_fixture` caps how many players may come from one game. Without it the
    solver stacks whichever club it likes best and the whole round rides on a single
    result -- expected points look fine, but the variance is enormous. Both clubs in
    a game count toward the same cap, since one blowout suppresses both sides.

    Returns the chosen squad, starting five, captain and formation.
    """
    locked, banned = locked or set(), banned or set()
    P = players[~players.player_id.isin(banned)].reset_index(drop=True)
    C = coaches[~coaches.player_id.isin(banned)].reset_index(drop=True)

    m = pulp.LpProblem("squad", pulp.LpMaximize)
    pick = {i: pulp.LpVariable(f"pick_{i}", cat="Binary") for i in P.index}
    start = {i: pulp.LpVariable(f"start_{i}", cat="Binary") for i in P.index}
    capt = {i: pulp.LpVariable(f"capt_{i}", cat="Binary") for i in P.index}
    sixth = {i: pulp.LpVariable(f"sixth_{i}", cat="Binary") for i in P.index}
    cpick = {j: pulp.LpVariable(f"coach_{j}", cat="Binary") for j in C.index}
    form = {f: pulp.LpVariable(f"form_{f}", cat="Binary") for f in range(len(FORMATIONS))}

    # --- objective ------------------------------------------------------------
    # Six players score in full -- the starting five plus the sixth man -- and only
    # the other four are halved. Every picked player gets 0.5; starters and the sixth
    # man get the other 0.5 on top; the captain gets one further copy.
    hold = P.proj_hold if "proj_hold" in P.columns else P.proj
    if ownership_weight and "popularity" in P.columns:
        own = P.popularity.fillna(0).astype(float)
        own = own / 100.0 if own.max() > 1.5 else own
        hold = hold * (1.0 - ownership_weight * own)
    m += (
        pulp.lpSum(hold[i] * BENCH_MULTIPLIER * pick[i]
                   + P.proj[i] * (1 - BENCH_MULTIPLIER) * (start[i] + sixth[i])
                   for i in P.index)
        + pulp.lpSum(P.proj[i] * (CAPTAIN_MULTIPLIER - 1) * capt[i] for i in P.index)
        # The coach is valued on THIS round only, deliberately. Unlike a player he has
        # no lineup role to protect and the field of 20 turns over constantly -- the best
        # coach changed in 4 of 5 round transitions, and the within-round spread is 11 to
        # 21 points. Holding one coach across six rounds scores 42.5 where picking the
        # best each round scores 69.3. So pick the best for now and let the transfer
        # planner decide each round whether the switch is worth one of the four trades.
        + pulp.lpSum(C.proj[j] * cpick[j] for j in C.index)
        # option value: a benched player in the last Turn can be promoted on
        # the strength of Turn 1 results, so he is worth more than a flat 50%
        + (pulp.lpSum(late_turn_bonus * (pick[i] - start[i] - sixth[i])
                      for i in P.index if _is_late(P, i)) if late_turn_bonus else 0)
    )

    # --- squad composition ---
    for pos, n in SQUAD.items():
        m += pulp.lpSum(pick[i] for i in P.index if P.position[i] == pos) == n
    m += pulp.lpSum(cpick.values()) == 1

    # --- budget ---
    m += (pulp.lpSum(P.price[i] * pick[i] for i in P.index)
          + pulp.lpSum(C.price[j] * cpick[j] for j in C.index)) <= budget

    # --- at most 6 from one club ---
    for club in set(P.team_abbr) | set(C.team_abbr):
        terms = [pick[i] for i in P.index if P.team_abbr[i] == club]
        if coach_counts_to_club_limit:
            terms += [cpick[j] for j in C.index if C.team_abbr[j] == club]
        if terms:
            m += pulp.lpSum(terms) <= max_per_club

    # --- a floor on total bench quality (winners' bench averaged 5.7 PIR) ---
    if min_bench_proj > 0:
        m += pulp.lpSum(P.proj[i] * (pick[i] - start[i] - sixth[i])
                        for i in P.index) >= min_bench_proj * 4

    # --- at most N players out of any single game ---
    if max_per_fixture and "fixture" in P.columns:
        for fx in P.fixture.dropna().unique():
            terms = [pick[i] for i in P.index if P.fixture[i] == fx]
            if len(terms) > max_per_fixture:
                m += pulp.lpSum(terms) <= max_per_fixture

    # --- optionally demand a real player on the bench, not only minimum-price ones ---
    if min_quality_bench:
        elig = [i for i in P.index if P.proj[i] >= quality_proj
                and (not require_late_bench or _is_late(P, i))]
        if elig:
            m += pulp.lpSum(pick[i] - start[i] - sixth[i]
                            for i in elig) >= min_quality_bench

    # --- lineup: exactly one formation, five starters, starters must be picked ---
    m += pulp.lpSum(form.values()) == 1
    for i in P.index:
        m += start[i] <= pick[i]
        m += sixth[i] <= pick[i] - start[i]      # the sixth man is not a starter
        m += capt[i] <= start[i]                 # captain must come from the five
    m += pulp.lpSum(start.values()) == 5
    m += pulp.lpSum(sixth.values()) == SIXTH_MAN
    m += pulp.lpSum(capt.values()) == 1

    # Captain must play in an early Turn, so the armband can still be moved later.
    if captain_early_turn and "turn" in P.columns and P.turn.notna().any():
        last = P.turn.max()
        if (P.turn < last).any():
            for i in P.index:
                if pd.notna(P.turn[i]) and P.turn[i] >= last:
                    m += capt[i] == 0
    for k, pos in enumerate(("Guard", "Forward", "Center")):
        m += (pulp.lpSum(start[i] for i in P.index if P.position[i] == pos)
              == pulp.lpSum(FORMATIONS[f][k] * form[f] for f in form))

    # --- transfer budget: at most N of the squad you already hold may be sold -------
    # Selling the coach counts toward the same four, per the rules.
    if current_squad and max_transfers is not None:
        held_p = [i for i in P.index if P.player_id[i] in current_squad]
        held_c = [j for j in C.index if C.player_id[j] in current_squad]
        m += (pulp.lpSum(1 - pick[i] for i in held_p)
              + pulp.lpSum(1 - cpick[j] for j in held_c)) <= max_transfers

    for pid in locked:
        for i in P.index[P.player_id == pid]:
            m += pick[i] == 1
        for j in C.index[C.player_id == pid]:
            m += cpick[j] == 1

    m.solve(pulp.PULP_CBC_CMD(msg=0))
    if pulp.LpStatus[m.status] != "Optimal":
        raise RuntimeError(f"solver status: {pulp.LpStatus[m.status]}")

    chosen = P.loc[[i for i in P.index if pick[i].value() > 0.5]].copy()
    chosen["starter"] = [start[i].value() > 0.5 for i in chosen.index]
    chosen["sixth"] = [sixth[i].value() > 0.5 for i in chosen.index]
    chosen["captain"] = [capt[i].value() > 0.5 for i in chosen.index]
    coach = C.loc[[j for j in C.index if cpick[j].value() > 0.5]].iloc[0]
    fidx = next(f for f in form if form[f].value() > 0.5)

    return {
        "players": chosen.sort_values(["starter", "sixth", "proj"], ascending=False),
        "coach": coach,
        "formation": FORMATIONS[fidx],
        "cost": float(chosen.price.sum() + coach.price),
        "expected": float(pulp.value(m.objective)),
    }
