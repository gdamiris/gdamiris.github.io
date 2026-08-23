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

**Setup.** Each player founds one town on a land tile, at least `MIN_TOWN_GAP` tiles from
every other town — a town blocks all six of its neighbours.

**Production is independent of the map.** A player gains 1 of a resource per town they
hold, whatever terrain that town stands on. Terrain governs where you may build, not who
gets paid.

**A turn is roll → keep → build → end.** You roll two resource dice and keep one; the
other resource goes to everyone else. Two matching faces are not a special rule, there is
simply nothing to choose, so everyone produces that resource and the roll resolves itself.
You then build as much as you can afford and end the turn explicitly.

**Roads and bridges run along hex edges and meet at corners.** A town blocks its own
hexagon's perimeter, so it has exactly six ways out — one radiating edge per corner (fewer
on the board rim, where the radiating edge borders no second tile). Every new edge must
touch a vertex your network already owns, so the network stays connected by construction.
An edge holds one road, ever, and nobody may build on a tile that carries a town.

Edge type is decided by terrain, not chosen: any edge touching sea or fish is a **bridge**,
everything else is a **road**. Open-ocean edges are deliberately kept in the graph, so
bridge chains can island-hop.

**Founding a town later** needs the spacing rule, one of the tile's six corners already on
your network, and the full cost. In practice that means about two links out from an
existing town.

| | cost |
|---|---|
| road | 2 ore |
| bridge | 2 wood |
| town | 1 wheat + 1 ore + 1 wood + 1 fish + 1 deer |
| port | 2 wood + 1 ore + 1 wheat |

**Units are what wool buys.** Recruit on a town you own; one unit to a tile, and a fresh
unit is spent on arrival, so it takes orders from its owner's next turn.

| unit | cost | move | strikes at | mustered on |
|---|---|---|---|---|
| foot soldier | 1 wool + 1 wood + 1 fish **or** deer | 1 tile | 1 | your town |
| horseman | 2 wool + 1 wood + 1 deer **or** fish | 2 tiles | 1 | your town |
| boat | 2 wood + 1 wool + 1 ore | 2 tiles | **exactly 2** | your port |

**A port** costs 2 wood + 1 ore + 1 wheat and sits **on the water** — a sea or fish tile
touching land — anywhere your network reaches. It is not a town: it produces nothing, does
not block the edges around it, and does not extend your network. It exists to launch and
repair boats, and it is the only sink for wheat besides towns. Because the port stands in
the water, boats muster on the port tile itself and sail back into it to repair — the same
rule that puts land units on a town.

**Roads and bridges do not carry armies.** Land units walk on land only and boats sail on
water only, so on land each island is its own military theatre. Nothing may stack, pass
through another unit, or enter an opponent's town.

**Ports, unlike towns, are open to the enemy.** A hostile boat may sail straight into your
harbour and sit there, which **blockades** it: a port needs an empty tile both to launch a
boat and to repair one, so while an enemy occupies it you can do neither — and your own
damaged boats cannot get home. The blockader gets no benefit from the harbour either; it
can only repair in a port of its own. Breaking a siege means killing the boat, which takes
two hits from something that can reach it.

**Boats trade reach for vulnerability.** A boat strikes at *exactly* 2 tiles and can hit
land units, so it bombards coasts — but it cannot touch anything adjacent, while an
adjacent land unit can hit it. Closing the distance is the counter. A damaged boat is not
rooted the way a wounded land unit is (it could never get home otherwise), but it may only
repair while sitting in one of its owner's ports, and sailing there and repairing are two
separate turns.

**One action per unit per turn.** A foot soldier moves *or* acts; a horseman may spend one
of its two steps and still attack, but not both. Every attack deals exactly 1 damage
whatever the attacker is, and units have 2 lives: the first hit leaves a unit **injured**,
which roots it in place — an injured unit may only attack or spend its turn reviving back
to full. A second hit kills. Towns cannot be attacked or captured.

Not settled yet: **the victory condition**.

## Where to change things

| Change | File |
|---|---|
| map feel (islands, water, mixing, barren) | `src/config.js` → `TUNING` |
| placement legality (gap, footprint, variety) | `src/config.js` → `RULES` |
| what roads, bridges and towns cost | `src/config.js` → `COSTS` |
| unit stats, costs and movement | `src/config.js` → `UNITS` |
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
    node tests/build.js     # roads, bridges, town construction (82 checks)
    node tests/units.js     # recruiting, movement, combat, ports, boats (117 checks)

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
there, and lifting the siege restores both.

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
