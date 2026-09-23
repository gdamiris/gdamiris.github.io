"""Scoring rules for the EuroLeague Fantasy Challenge. See docs/SCORING-MODEL.md."""
from __future__ import annotations

WIN_BONUS = 1.10
BENCH_MULTIPLIER = 0.5
CAPTAIN_MULTIPLIER = 2.0

# Of the 10 outfield players, SIX score in full: the starting five plus a nominated
# sixth man. Only the remaining four are halved. The captain must come from the
# starting five, so the sixth man cannot be captained.
SIXTH_MAN = 1
FULL_SCORING_SLOTS = 5 + SIXTH_MAN

BUDGET = 100.0
SQUAD = {"Guard": 4, "Forward": 4, "Center": 2}
COACH_SLOTS = 1
MAX_PER_CLUB = 6

# Legal starting fives as (guards, forwards, centers).
FORMATIONS = [(2, 2, 1), (1, 2, 2), (2, 1, 2), (1, 3, 1), (3, 1, 1)]


def player_points(pir: float, won: bool) -> float:
    """A player's fantasy score before bench/captain multipliers."""
    return pir * (WIN_BONUS if won else 1.0)


def coach_points(margin: int, overtime: bool = False) -> int:
    """Coach scores purely on his team's result margin.

    The rulebook bands 'win by 11-20' and 'win by 20+' overlap at exactly 20;
    we assign 20 to the 11-20 band and 21+ to the top band.
    """
    if margin > 0:
        if overtime or margin <= 10:
            return 10
        return 20 if margin <= 20 else 25
    if overtime or margin >= -10:
        return -5
    return -10 if margin >= -20 else -20
