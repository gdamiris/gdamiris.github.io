# Hex board prototype

Static, no build step. Native ES modules, so it runs as-is on GitHub Pages.

## Running

Locally, ES modules need a server — opening `index.html` over `file://` fails CORS:

    python3 -m http.server 8000     # then open http://localhost:8000

## Deploying to GitHub Pages

Push to `main`. `.github/workflows/pages.yml` runs the headless rule checks and, if they
pass, publishes the repository root. Enable it once under **Settings → Pages → Source →
GitHub Actions**. To skip the workflow entirely, set **Source → Deploy from a branch →
main / (root)** instead; the repo is already a valid static site with no build step.

Things this project does deliberately so Pages works:

- **Every path is relative** (`./src/main.js`, `./styles/...`), so the site works from a
  project subpath like `user.github.io/repo/` as well as from a custom domain. Never
  introduce a leading-slash path.
- **`.nojekyll`** is present. Without it Pages runs Jekyll, which silently drops any file
  or directory starting with an underscore.
- **No build step and no dependencies.** `package.json` exists only to mark the project as
  ESM for `node tests/run.js`; nothing is installed and nothing is bundled.
- **No external requests** — no CDNs, no web fonts. The whole site is self-contained.
- **No `localStorage`/`sessionStorage`.** All state is in memory.
- **Filenames are case-sensitive** on Pages even though macOS and Windows are not. Import
  paths must match the file names exactly.
- Pages serves over **HTTPS**, which is what WebRTC will need when multiplayer lands.

## Layout

    index.html              markup only: element ids the UI binds to
    styles/
      tokens.css            palette, terrain colours, type stacks
      base.css              page shell, shared typography
      board.css             map surface
      panel.css             side panel: controls, chips, dice, legend, log
    src/
      config.js             board sizes, players, TUNING, COSTS, UNITS, placement RULES
      terrain.js            terrain table + passable/settleable predicates
      rng.js                seeded PRNG and value noise
      hex.js                odd-r offset geometry and neighbour lookup
      generate.js           map generation
      game.js               game state and rules (no DOM)
      main.js               DOM wiring
      ui/
        state.js            selection and armed-recruit state (visual only)
        icons.js            terrain glyph sprite sheet
        board-view.js       draws the map, roads, towns and units
        panel-view.js       draws the side panel
    tests/
      run.js                geometry, generation, turn loop
      build.js              roads, bridges, town construction
      units.js              recruiting, movement, combat, revival

## Rules as they stand

**Setup is a snake draft.** Each player founds **two** towns before play, one per round,
and the round order reverses each time: with three players the picks go 0, 1, 2 — then
2, 1, 0. Whoever chose last in a round chooses first in the next, so the first seat's
advantage does not compound across both of its towns. Every town must sit on land, at
least `MIN_TOWN_GAP` tiles from every other — a town blocks all six of its neighbours.

Two towns each is not just a head start: towns are muster points and the merchant cap is
one per town, so everyone begins able to field two traders and recruit from two places.

**Production is flat, and merchants are the only way to raise it.** Every player gains
exactly **1** of the rolled resource, however many towns they hold. A **merchant** standing
on a resource tile adds **1 more** of that resource whenever it is rolled — so income is
bought with ground you have to hold, and never compounds on its own.

That last part is load-bearing. When income scaled with town count instead, simulated play
doubled its towns every four rounds, saturated the board by round 20, and then piled up
1,600 unspendable resources. Flat production with merchants gives roughly one new town
every three rounds and players who stay within a town or two of each other.

**There are five resources and six die faces.** Wood, wheat, wool, ore and fish are the
things a player can hold; the sixth face is the **wild**, which is never held. Whenever a
wild is in play the roller names a real resource in its place — for themselves if they
kept it, for the table if they gave it away.

**A turn is roll → keep → build → end.** You roll two dice and keep one; the other face
goes to everyone else. Two matching faces are not a special rule, there is simply nothing
to choose, so everyone produces that resource and the roll resolves itself. You then build
as much as you can afford and end the turn explicitly.

**One wild in play** is named by the roller — for themselves if they kept it, for the table
if they gave it away. Nothing is paid until it is named, and neither building nor ending
the turn is possible while a wild is outstanding.

**Two wilds is a famine.** Nobody produces at all. Instead every player gives up one card
for every `RULES.FAMINE_PER` they are sitting on — so a player holding 40 loses 8, and one
holding 4 loses nothing. It is the only thing in the game that pulls a runaway leader
back, and the only pressure against hoarding. It lands on about 1 roll in 36, roughly
three times a game.

Which card to give up should be the player's choice; hot-seat cannot ask three people
mid-turn, so for now it takes from the largest pile — marked as a seam like the others.

**Roads and bridges run along hex edges and meet at corners.** A town blocks its own
hexagon's perimeter, so it has exactly six ways out — one radiating edge per corner (fewer
on the board rim, where the radiating edge borders no second tile). Every new edge must
touch a vertex your network already owns, so the network stays connected by construction.
An edge holds one road, ever, and nobody may build on a tile that carries a town.

**What an edge takes depends on how much land it touches.** With land on both sides it can
only be a **road**; with water on both sides only a **bridge**; and a **coastal** edge — land
one side, water the other — takes **either**, so the player chooses whether to run a road
along the shore or throw a bridge out over the water. Open-ocean edges are deliberately
kept in the graph, so bridge chains can island-hop.

| edge | takes |
|---|---|
| land ↔ land | road (2 ore) |
| land ↔ water | road **or** bridge — your choice |
| water ↔ water | bridge (2 wood) |

**Bridges carry land units over water.** A water tile with a bridge on any of its edges is
walkable, so a foot soldier can cross a one-tile strait by land → bridged water → land. A
*road* on a coastal edge does not do this; only a bridge does. Ownership is irrelevant —
your bridge carries your enemy just as well as it carries you.

**Founding a town later** needs the spacing rule, one of the tile's six corners already on
your network, and the full cost. In practice that means about two links out from an
existing town.

| | cost |
|---|---|
| road | 2 ore |
| bridge | 2 wood |
| town | 1 wheat + 1 ore + 1 wood + 1 fish |
| port | 2 wood + 1 ore + 1 wheat |
| wall | 2 ore + 2 wood |
| repairing a unit | 1 fish — or 1 wood for a boat |
| repairing a wall | 1 ore per life, once per turn |

**Units are what wool buys.** Recruit on a town you own; one unit to a tile. A unit
recruited this turn may **march at once but not strike** — so it can leave the tile it was
born on, while there is still no recruit-and-ambush.

That is not a detail. When a fresh unit was frozen for a turn *and* a wounded unit was
rooted, a single cannon parked 2–3 tiles from a town locked it forever: every unit
recruited there was shelled before it could move, and being wounded it could then never
move at all. Its owner's only option was to spend a fish a turn keeping it barely alive.
Anything that can move can now always move, wounded or fresh.

**Armies eat.** A foot soldier costs rations, a horseman fodder, a boat a fed crew — which
is why fish and wheat appear in unit costs rather than more timber. Before that, wood
carried 14 units of demand across everything buildable against fish's 5, at identical
supply, so keeping the wood die was correct every single turn and the keep-one/give-one
choice made itself. It now runs wood 11, ore 10, wool 9, wheat 8, fish 7 — close enough
that which face is worth keeping depends on what you are building.

Fish deliberately sits lowest: it is the one resource a merchant cannot walk onto, since
every fish tile is water. Reaching one needs a bridge, or a **fishing port** built on it.

Wool is the infantry tax — foot, horse and boat all need it, the cannon does not. **Fish is
the medical supply**: patching up a damaged unit costs 1 fish — except a boat, whose hull is
planked back together with **1 wood**.

`UNITS` still supports an `either` field (a choice of one resource from a list, on top of
the fixed cost), but no unit uses it any more.

| unit | cost | move | strikes at | mustered on |
|---|---|---|---|---|
| foot soldier | 1 wool + 1 fish | 1 tile | 1 | your town |
| horseman | 2 wool + 1 wheat | 2 tiles | 1 | your town |
| **merchant** | 1 wool + 1 wheat + 1 fish | 1 tile | — cannot fight | your town |
| **spy** | 2 wool + 1 wheat + 1 fish | 3 tiles | — cannot fight | your town |
| cannon | 2 ore + 2 wood | 1 tile | **2–3** | your town |
| boat | 1 wood + 1 fish + 1 wool + 1 ore | 2 tiles | **exactly 2** | your port |

**A port** costs 2 wood + 1 ore + 1 wheat and sits **on the water** — a sea or fish tile
touching land — anywhere your network reaches. It is not a town: it produces nothing, does
not block the edges around it, and does not extend your network. It exists to launch and
repair boats, and it is a sink for wheat besides towns. A port built on a **fish** tile
works the shallows it stands in: it lands **1 extra fish** whenever fish is rolled, exactly
as a merchant would. A deep-water port on plain sea earns nothing. Because the port stands in
the water, boats muster on the port tile itself and sail back into it to repair — the same
rule that puts land units on a town.

**Land units keep to land, except across bridges.** Boats sail on water only. A land unit
walks on land, plus any water tile a bridge spans — so bridging a strait opens a road for
armies as well as for settlers, in both directions. Nothing may stack, pass through
another unit, or enter an opponent's town.

**Ports, unlike towns, are open to enemy boats — but only boats.** A harbour is a berth,
not a checkpoint: no land unit may ever stand in one, even where a bridge makes the tile
walkable, so a marching column can never shut a port down. A hostile *boat*, though, may
sail straight in and sit there, which **blockades** it: a port needs an empty tile both to launch a
boat and to repair one, so while an enemy occupies it you can do neither — and your own
damaged boats cannot get home. The blockader gets no benefit from the harbour either; it
can only repair in a port of its own. Breaking a siege means killing the boat, which takes
two hits from something that can reach it.

**A wall rings a town you already hold**, costs 2 ore + 2 wood, and has **4 lives** of its
own. While it stands, whatever shelters on that tile **cannot be attacked at all** — but it
can still shoot out, at whatever its own range reaches. Only **cannons and boats** can
touch a wall; every blow aimed at a walled tile lands on the masonry instead, and a foot
soldier or horseman simply cannot attack it. Four siege hits breach it, at which point the
wall is gone and the garrison is exposed.

Walls mend at 1 ore for 1 life, and **only one life per wall per turn** — so a besieger
firing every turn will always out-pace the masons, but slowly enough that relief has time
to arrive.

**The merchant is a civilian, and fragile on purpose.** It has **one life**, so a single hit
kills it and the income dies with it; it cannot attack anything; and you may hold only
**one per town**, so raising income means founding towns and defending the ground your
traders stand on. A merchant on barren ground earns nothing — and since fish is a water
tile, working a fish bed means bridging out to it first.

**Every player has one king**, seated in one of their towns once the draft is over, and
re-seated in a *different* town if it is ever killed. A player who owes a king must seat
it before they may roll. There are two ways to take one: conquering the town — not built
yet — or assassination.

Kings are meant to be secret. This is a hot-seat build, so for now every king is drawn for
everyone; `kingVisibleTo(viewer, owner)` in `game.js` is the single place that decides it,
and returns true for all. Multiplayer flips it to `viewer === owner` and stops sending
other players' kings at all. Two more seams are marked the same way: the answer a spy gets
from scouting, and the decision to evade.

**The spy is a civilian that ranges three tiles** — and is the only way to reach a king
that has not been besieged. It cannot fight, has one life, and dies to a single hit like a
merchant. It has three pieces of work, all needing it to stand **next to** the target town:

| | cost | |
|---|---|---|
| Scout | 1 wheat | learn whether that town holds a king |
| Steal | 1 wheat | take 1 of whatever that town's own tile produces |
| Assassinate | 2 wool | kill the king there; the spy survives |
| Evade | 1 wheat + 1 fish | shrug off a blow and slip one tile away |

**A raid takes only what the ground makes.** Stealing carries off one unit of the town
tile's own resource — so a town on ore yields ore, and a town on mountain, plain or desert
yields nothing at all. Nor can you take what the owner does not hold. The wheat is spent
on the attempt either way, but since terrain and every hand are public, an empty-handed
raid is a bad decision rather than bad luck. Two of the four barren tiles are common
enough that **where a town sits now decides how robbable it is**.

**Sentries are what stop assassins.** A spy is `cautious`: stepping onto any tile
overlooked by an enemy unit costs it *the whole turn*, so near anybody's soldiers it
manages one tile instead of three. Screening the ground around your royal town is the
counter-espionage game.

Evade is a reaction, and hot-seat cannot hand control to another player mid-turn, so it
currently fires automatically whenever the defender can pay. A spy whose owner is out of
wheat or fish dies like anything else with one life.

**The cannon is artillery**, and priced like a siege piece at 2 ore + 2 wood. It moves 1 tile,
and shells anything 2 or 3 tiles away — including boats out at sea. It cannot fire on an
adjacent enemy, so it needs infantry screening it; get under its guns and it is helpless.
It also has no way to repair: damage to a cannon is permanent. Unlike a wounded soldier it
is not rooted, so a crippled gun can still be pulled back, it just never recovers.

Its 2–3 band covers **30 tiles**, the widest reach in the game — five times a foot
soldier's. That is why it costs 4 rather than 2: a foot soldier closing from 3 tiles is
shelled twice and dies before contact, so the only land answer is a horseman, and the
answer should never cost more than the thing it answers.

**Boats trade reach for vulnerability.** A boat strikes at *exactly* 2 tiles and can hit
land units, so it bombards coasts — but it cannot touch anything adjacent, while an
adjacent land unit can hit it. Closing the distance is the counter. A damaged boat is not
rooted the way a wounded land unit is (it could never get home otherwise), but it may only
repair while sitting in one of its owner's ports, and sailing there and repairing are two
separate turns.

**The barren ground shapes how armies move.** Everything not listed costs one step:

Movement is counted in **points**, not tiles: an ordinary tile costs **3**, a foot soldier
has **3** a turn and a horseman **8**. Only cavalry feels the terrain.

| terrain | horse | everyone else |
|---|---|---|
| ordinary ground | 3 | 3 |
| **plain** | **2** | 3 |
| **mountain** | **8** — the whole turn | 3 |
| **desert** | 3, plus **1 fish** paid by the owner for every unit that enters | same |

So a horseman may spend its 8 on: two ordinary tiles **and** a plain; or four plains; or
one mountain and nothing more. Five plains, three ordinary tiles, or a mountain followed
by anything are all beyond it.

**Striking costs one ordinary tile of allowance, whatever your budget.** A unit may attack
only if it has spent no more than 3 getting there *and* still holds 3 in reserve. A foot
soldier (budget 3) therefore must not have moved at all; a horseman may have gone one
ordinary tile or one plain, but never two tiles however cheap the ground. Without that
first half, cavalry could cross two tiles of discounted plain and still fight — a reach
no other unit has, and one that let a horseman close on a cannon and kill it in a single
turn from 39% of the board.

Nothing costs zero, so cavalry range always has a ceiling: **four tiles** at the very most,
over unbroken plain. An earlier version made plains free, and a chain of them carried a
horseman **six tiles and still let it attack** — range set by the map rather than by the
unit. A unit that cannot pay the desert toll simply cannot enter the desert.

**One action per unit per turn.** A foot soldier moves *or* acts; a horseman may spend one
of its two steps and still attack, but not both. Every attack deals exactly 1 damage
whatever the attacker is, and units have 2 lives: the first hit leaves a unit **injured**,
and a second kills. A wounded unit fights and moves as normal — it can withdraw — it simply
has no life to spare until it is repaired. Towns cannot be attacked or captured.

Not settled yet: **the victory condition**.

## Where to change things

| Change | File |
|---|---|
| map feel (islands, water, mixing) | `src/config.js` → `TUNING` |
| how many tiles of each resource | `src/config.js` → `TUNING.resourcePct` |
| placement legality (gap, footprint, variety) | `src/config.js` → `RULES` |
| what roads, bridges and towns cost | `src/config.js` → `COSTS` |
| unit stats, costs and movement | `src/config.js` → `UNITS` |
| what terrain does to movement | `src/config.js` → `TERRAIN_MOVE` |
| terrain colours, glyph ink, passability | `src/terrain.js` |
| production rule (`yieldOf`) | `src/game.js` |
| turn flow (roll, keep, resolve, build, end) | `src/game.js` |
| network and build legality | `src/game.js` → `legalEdge`, `legalExpansion` |
| glyph artwork | `src/ui/icons.js` |
| palette | `styles/tokens.css` |

`game.js` holds every rule and touches no DOM, so the whole game can be driven from
tests today and from a network transport later — a peer only needs the seed, the board
size, and the `TUNING` object to derive a byte-identical map.

## Tests

    npm test          # all three suites
    node tests/run.js       # geometry, generation, turn loop
    node tests/build.js     # roads, bridges, coastal edges, towns (97 checks)
    node tests/units.js     # units, merchants, terrain, navy, siege (298 checks)

`tests/build.js` covers construction specifically, and most of it asserts what must be
**refused**: building outside the window, on an occupied edge, on a town's perimeter, off
your own network, or without the exact cost. It also builds a route to another island to
prove bridge chains can cross open ocean, and runs 60 turns of blind spending to confirm
no hand can go negative.

`tests/units.js` pins down the action economy, which is the fiddly part: that a foot
soldier which moved can no longer attack, that a horseman which spent one of two steps
still can, that an injured unit is rooted but may still fight or revive, that two hits
kill, and that a unit refreshes only on its owner's turn. It also pins the naval rules: a
port needs coastal land within reach, boats launch only beside your own port, a boat's
shot at an adjacent enemy is refused *and costs it nothing*, and a damaged boat can sail
but can only repair in a port. It also checks that open ocean with no land beside it is
never a harbour, and covers the blockade from both sides: an enemy boat may enter your
port but gains no repair from it, you can neither launch nor sail home while it sits
there, and lifting the siege restores both. For the cannon it walks the whole range band —
adjacent refused, 2 and 3 allowed, 4 refused — confirms a land gun can shell a boat at
sea, and checks that a wounded cannon can retreat but never repairs. Walls are covered
from both sides of a siege: infantry can neither breach the wall nor reach the garrison,
the garrison can still shoot out from behind it, four cannon hits breach it and expose
what was sheltering, and masonry goes up exactly one course per turn.

Covers hex geometry against true distances, generation invariants across seeds and
sizes (equal resource counts, island count, determinism), the de-clumping pass
(counts preserved, cohesion reduced but not destroyed), and 900 simulated rolls of
full games for 2–6 players.

Also covers the rules that are easy to break by accident: production ignoring terrain,
doubles resolving without crediting a deliberate keep, the roller (not whoever is
current) receiving the kept die, the edge graph partitioning into road and bridge slots
with open-ocean edges retained, a town blocking its own six perimeter edges while
offering six ways out, and the fact that a lone town can reach nowhere until roads
carry its network far enough to clear the spacing rule.
