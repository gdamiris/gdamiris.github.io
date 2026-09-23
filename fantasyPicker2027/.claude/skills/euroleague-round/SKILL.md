---
name: euroleague-round
description: Pick the EuroLeague Fantasy Challenge squad for a round — refresh prices, ownership and injuries, reproject, optimise the eleven, and publish the team sheet. Use at the start of each Round, when the user asks who to pick, who to transfer, who to captain, or asks to update the team sheet. Also use after a round finishes to record prices and score the previous projection.
---

# Picking a EuroLeague Fantasy round

Run the pipeline in order. Every step is a script in `scripts/`; none needs arguments
beyond the round number. Working directory is the project root, Python is `.venv/bin/python`.

## The weekly run

```bash
R=1                                             # the round being picked
.venv/bin/python scripts/fetch_players.py --round $R   # prices, ownership, injuries
.venv/bin/python scripts/fetch_roster.py  --round $R   # what is currently held
.venv/bin/python scripts/fetch_news.py                 # injury / rotation reporting
.venv/bin/python scripts/project.py --round $R         # per-player projections
.venv/bin/python scripts/project_horizon.py --from-round $R   # rounds R..R+5
.venv/bin/python scripts/build_squad.py --round $R     # the ideal eleven, from scratch
.venv/bin/python scripts/plan_transfers.py --round $R --transfers 4   # what to actually do
.venv/bin/python scripts/export_view.py                # data for the web page
```

`build_squad.py` answers "what is the best squad"; `plan_transfers.py` answers the
question that matters once a team is held: **which four changes buy the most points.**
Always run the transfer ladder (`--transfers 1 2 3 4`) and show the marginal value of
each trade — the fourth is often worth far less than the first, and unused trades are
worth keeping for an injury.

In an unlimited window (after R6, R13, R18, R23, R28, R34) run `--transfers 11`.

### Trades are an economy, not a wishlist
Spending power is **squad value + bank**, and every purchase is funded by a sale. You
cannot swap a 9cr player for a 17cr one without downgrading elsewhere, and the planner
prints the running balance for each trade so that funding chain is visible rather than
implied. The bank is inferred from the 100-credit cap when not passed; override with
`--bank` once capital gains have moved the total.

To price a specific signing the user is attached to:

```bash
.venv/bin/python scripts/plan_transfers.py --round $R --transfers 4 --target Vezenkov
```

That forces him into the squad and reports what affording him costs — which sales it
forces and how many points it gives up against the unconstrained plan. Use it whenever
the user asks "can I keep X" or "should I buy Y"; the answer is always a number, not
an opinion.

Then publish the team sheet (see **Publishing** below).

After the round has been played, also run:

```bash
.venv/bin/python scripts/ingest_history.py --seasons E2026   # new boxscores
.venv/bin/python scripts/build_facts.py                      # rebuild fact tables
.venv/bin/python scripts/track_prices.py                     # how prices actually moved
```

`track_prices.py` is how the capital-gains strategy stops being a theory — it needs at
least two round snapshots, so it starts saying something useful from Round 2.

## What to check before trusting the output

1. **Injuries.** `fetch_players.py` prints the injured count. If a squad player is out,
   he must be traded — the optimiser zeroes him but cannot spend a trade for you.
   A team-mate at his position gains the freed minutes automatically.
2. **Ownership.** Live from the game's `popularity` field. It sums to 10 across the pool
   because every manager fills ten outfield slots, so 0.40 means two squads in five.
3. **New signings.** Anyone with `confidence` below 0.15 has no EuroLeague or EuroCup
   record; his minutes are inferred from price alone. Check reporting before trusting him.
4. **Trades.** Four per round, and the coach counts. Unlimited windows after R6, R13,
   R18, R23, R28, R34 — build budget before them, spend it in them.
5. **Concentration.** `plan_transfers.py` warns if more than three held players share a
   game. The 3-per-game cap is our own risk rule, not the game's, so when too few trades
   remain to unwind it the planner relaxes it and says so.

## Non-negotiable strategy rules

These are measured, not opinions. `references/findings.md` has the numbers.

- **Captain a Turn 1 player, always.** The armband can be moved between Turns to anyone
  who has not tipped off, so a Turn 1 captain is a free option worth +1.2 to +5.7 points.
  It beats captaining a *higher-projected* Turn 2 player. The optimiser enforces this.
- **Between Turns, promote a bench player if his expected score beats what your starter
  actually scored.** That is the whole decision rule; the maths is in findings.
- **Six players score in full** — the starting five *plus the sixth man* — and only the
  other four are halved. The captain must come from the starting five.
- **Keep the bench cheap.** Three or four minimum-price slots is right; the sixth man is
  already your quality swing player. Forcing a second good bench player costs points.
- **At most three players from any one game.** Enforced by the optimiser.

## Publishing

Build the page from `data/view_round01.json` and the template pattern already in the
repo, then publish with the Artifact tool. Update the **same** artifact URL each round
rather than creating a new one — ask the user for the link, or find it with
`action: "list"`, and pass it as `url`.

Show for every player: price, projection, last season's output per round, ownership,
and the next six fixtures. Keep the reasoning visible on the card — the user reads it.

## References

- `references/rules.md` — the game's rules, exactly, with the traps
- `references/findings.md` — what was measured, what was tried and rejected
