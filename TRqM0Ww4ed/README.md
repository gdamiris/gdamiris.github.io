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
      config.js             board sizes, players, TUNING, placement RULES
      terrain.js            terrain table + passable/settleable predicates
      rng.js                seeded PRNG and value noise
      hex.js                odd-r offset geometry and neighbour lookup
      generate.js           map generation
      game.js               game state and rules (no DOM)
      main.js               DOM wiring
      ui/
        icons.js            terrain glyph sprite sheet
        board-view.js       draws the map
        panel-view.js       draws the side panel
    tests/run.js            headless checks over the pure modules

## Where to change things

| Change | File |
|---|---|
| map feel (islands, water, mixing, barren) | `src/config.js` → `TUNING` |
| placement legality (gap, footprint, variety) | `src/config.js` → `RULES` |
| terrain colours, glyph ink, passability | `src/terrain.js` |
| production rule (`yieldOf`) | `src/game.js` |
| turn flow (roll, keep, resolve) | `src/game.js` |
| glyph artwork | `src/ui/icons.js` |
| palette | `styles/tokens.css` |

`game.js` holds every rule and touches no DOM, so the whole game can be driven from
tests today and from a network transport later — a peer only needs the seed, the board
size, and the `TUNING` object to derive a byte-identical map.

## Tests

    node tests/run.js

Covers hex geometry against true distances, generation invariants across seeds and
sizes (equal resource counts, island count, determinism), the de-clumping pass
(counts preserved, cohesion reduced but not destroyed), and 900 simulated rolls of
full games for 2–6 players.
