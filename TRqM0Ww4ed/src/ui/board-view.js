/* Draws the hex board: terrain polygons, terrain glyphs, and town markers. */

import { S, PLAYERS, UNITS, STEP } from "../config.js";
import { TERRAIN } from "../terrain.js";
import { hexPoints, corner } from "../hex.js";
import { game, legalTown, canBuild, legalEdge, legalExpansion, networkVerts,
         movePlan, targetsOf, wallTargetsOf, canAttack, injured, legalRecruit, legalPort,
         legalWall, canRepairWall, sheltered, isCoastalEdge, edgeKinds, unitAt,
         kingVisibleTo, legalKingSeat, owesKing, spyTargets, isSpy,
         townTargetsOf, townLife, townMaxLife, canRepairTown, mendedThisTurn } from "../game.js";
import { WALL } from "../config.js";
import { ui } from "./state.js";

/* Screen pixels per SVG unit. This is the one knob for how big the map draws: it fixes
   the hex size, so a bigger board is genuinely bigger rather than the same box redrawn
   with finer hexes. Boards wider than the window still shrink to fit. */
const PX_PER_UNIT = 3.0;

export function renderBoard(svg) {
  const b = game.board;
  if (!b) return;
  const w = S * Math.sqrt(3) * (b.cols + 0.5), h = S * 1.5 * b.rows + S * 0.5;
  svg.setAttribute("viewBox", `${-S * 1.9} ${-S * 1.4} ${w + S * 2} ${h + S * 1.6}`);
  /* Draw at the board's own size, so a bigger board actually looks bigger instead of
     being rescaled to the same box with smaller hexes. This has to be an explicit width
     rather than 100%: the stage is a flex item, and a percentage width there gives it no
     size of its own for the row to lay out against. */
  svg.style.width = `${Math.round((w + S * 2) * PX_PER_UNIT)}px`;
  svg.style.maxWidth = "100%";

  const placing = game.phase === "placing";
  /* a king is owed either at setup, or by whoever just lost one */
  const seating = game.phase === "crowning" || owesKing(game.current);
  const seatingFor = game.phase === "crowning" ? game.turn : game.current;
  const building = canBuild();
  const net = building ? networkVerts(game.current) : null;
  const kept = game.keptIndex === null ? null : game.dice[game.keptIndex];
  const canSettle = t => building && legalExpansion(game.current, t, net);
  const dimmed = t => placing && !legalTown(t);
  const W = S * 1.15;

  /* The tile carries the tooltip for everything standing on it — the wall bar and the
     unit markers are pointer-transparent, so this is the only thing hover can reach. */
  const label = t => {
    const w = game.walls.get(t.id), u = unitAt(t.id);
    const town = game.towns.has(t.id);
    return [`${TERRAIN[t.terrain].label} — ${t.col},${t.row}`,
      town && `${PLAYERS[game.towns.get(t.id)].name} town ${townLife(t)}/${townMaxLife(t)}`,
      w && `Wall ${w.lives}/${WALL.lives}`,
      town && mendedThisTurn(t) && "repaired this turn",
      u && `${PLAYERS[u.owner].name} ${UNITS[u.kind].label.toLowerCase()} ${u.lives}/${UNITS[u.kind].lives}`,
    ].filter(Boolean).join(" · ");
  };

  const terrain = b.tiles.map(t => {
    const spec = TERRAIN[t.terrain], lit = kept && t.terrain === kept;
    return `<polygon class="tile" data-id="${t.id}" points="${hexPoints(t.col, t.row)}" fill="${spec.color}"
      ${dimmed(t) ? 'opacity="0.35"' : ""} ${lit ? 'stroke="var(--brass)" stroke-width="2.5"' : ""}
      ><title>${label(t)}</title></polygon>`;
  }).join("");

  const glyphs = b.tiles.map(t =>
    `<use href="#i-${t.terrain}" x="${(t.x - W / 2).toFixed(1)}" y="${(t.y - W / 2).toFixed(1)}"
       width="${W.toFixed(1)}" height="${W.toFixed(1)}" pointer-events="none"
       style="color:${TERRAIN[t.terrain].ink}"
       opacity="${dimmed(t) ? 0.3 : t.terrain === "sea" ? 0.5 : 0.95}"/>`).join("");

  /* One shared shape language: everything a player owns on a tile is an inset hex ring
     in their colour, distinguished by dash and by the pip it carries. */
  const insetRing = (t, k) => [0, 1, 2, 3, 4, 5].map(n => {
    const [cx, cy] = corner(t.col, t.row, n);
    return [(t.x + (cx - t.x) * k).toFixed(1), (t.y + (cy - t.y) * k).toFixed(1)].join(",");
  }).join(" ");

  const marks = [...game.towns].map(([id, pi]) => {
    const t = b.tiles[id], c = PLAYERS[pi].color;
    return `<polygon points="${insetRing(t, 0.86)}" fill="none" stroke="${c}" stroke-width="3" pointer-events="none"/>
            <circle cx="${t.x.toFixed(1)}" cy="${(t.y + S * 0.58).toFixed(1)}" r="4.2" fill="${c}"
                    stroke="#0B1620" stroke-width="1.2" pointer-events="none"/>`;
  }).join("");

  const line = (e, extra) => {
    const [x1, y1] = b.verts[e.a], [x2, y2] = b.verts[e.b];
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra}/>`;
  };

  /* Everything already built. Bridges are dashed so water crossings read at a glance. */
  const built = [...game.roads].map(([id, r]) => line(b.edges[id],
    `stroke="${PLAYERS[r.owner].color}" stroke-width="4" stroke-linecap="round"
     ${r.bridge ? 'stroke-dasharray="5 3"' : ""} pointer-events="none"`)).join("");

  /* Buildable edges for the player whose build window is open. A coastal edge takes
     either kind, so it previews whichever the panel currently has armed. */
  const kindFor = e => isCoastalEdge(e) ? ui.edgeKind : edgeKinds(e)[0];
  const slots = !building ? "" : b.edges
    .filter(e => legalEdge(game.current, e.id, net, isCoastalEdge(e) ? ui.edgeKind : null))
    .map(e => line(e, `class="slot ${kindFor(e) === "bridge" ? "bridge" : ""}" data-edge="${e.id}"
      stroke="${PLAYERS[game.current].color}" stroke-width="7" stroke-linecap="round"`)).join("");

  /* Tiles the network can reach and the player can pay for. */
  const sites = !building ? "" : b.tiles.filter(canSettle).map(t =>
    `<circle class="site" cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="${(S * 0.42).toFixed(1)}"
       fill="none" stroke="${PLAYERS[game.current].color}" stroke-width="2"
       stroke-dasharray="3 3" pointer-events="none"/>`).join("");

  /* ---- army ---- */
  const sel = ui.selected === null ? null : game.units.get(ui.selected);
  const ordering = building && sel && sel.owner === game.current;
  const hex = t => hexPoints(t.col, t.row);

  /* where the selected unit may go, and who it may hit. Tiles that charge a toll to
     enter are marked, so a desert crossing is never a surprise. */
  const budget = ordering ? UNITS[sel.kind].move : 0;
  const moves = !ordering ? "" : [...movePlan(sel)].map(([id, p]) => {
    const priced = Object.keys(p.toll).length > 0;
    const toll = Object.entries(p.toll).map(([k, n]) => `${n} ${k}`).join(" + ");
    /* movement is in half-tiles, so report it against the budget rather than as a
       count of steps — "3 of 4 movement" is readable, "3 steps" is not */
    const left = budget - (sel.moved + p.steps);
    return `<polygon class="move ${priced ? "toll" : ""}" data-move="${id}"
        points="${hex(b.tiles[id])}" fill="${PLAYERS[sel.owner].color}"
        ><title>${p.steps} of ${budget} movement · ${left} left${
          left >= STEP ? " · can still attack" : ""}${priced ? ` · costs ${toll}` : ""}</title></polygon>`;
  }).join("");

  /* enemy towns a selected spy is standing next to */
  const plots = !(ordering && isSpy(sel)) ? "" : spyTargets(sel).map(t =>
    `<polygon class="plot" data-plot="${t.id}" points="${hex(t)}"
       fill="none" stroke="var(--brass)" stroke-width="3"/>`).join("");

  const attacks = !ordering || !canAttack(sel) ? "" :
    [...targetsOf(sel).map(e => e.tile), ...wallTargetsOf(sel), ...townTargetsOf(sel)].map(tid =>
      `<polygon class="strike" data-attack="${tid}" points="${hex(b.tiles[tid])}"
         fill="none" stroke="var(--bad)" stroke-width="3"/>`).join("");

  /* tiles that can take the armed recruit: your towns, or water beside your ports */
  const drops = !(building && ui.recruit) ? "" : b.tiles
    .filter(t => legalRecruit(game.current, ui.recruit, t))
    .map(t => `<polygon class="drop" data-recruit="${t.id}" points="${hex(t)}"
       fill="none" stroke="${PLAYERS[game.current].color}" stroke-width="3"/>`).join("");

  /* water tiles touching land that a port could open on, while port building is armed */
  const portSites = !(building && ui.build === "port") ? "" : b.tiles
    .filter(t => legalPort(game.current, t, net))
    .map(t => `<polygon class="drop" data-port="${t.id}" points="${hex(t)}"
       fill="none" stroke="${PLAYERS[game.current].color}" stroke-width="3"/>`).join("");

  /* towns that could be walled, or walls that could be patched, while armed */
  const wallSites = !(building && ui.build === "wall") ? "" : b.tiles
    .filter(t => legalWall(game.current, t))
    .map(t => `<polygon class="drop" data-wall="${t.id}" points="${hex(t)}"
       fill="none" stroke="${PLAYERS[game.current].color}" stroke-width="3"/>`).join("");

  const rebuild = !(building && ui.build === "rebuild") ? "" : b.tiles
    .filter(t => canRepairTown(game.current, t))
    .map(t => `<polygon class="drop" data-rebuild="${t.id}" points="${hex(t)}"
       fill="none" stroke="${PLAYERS[game.current].color}" stroke-width="3"/>`).join("");

  const scars = [...game.towns].filter(([id]) => townLife(b.tiles[id]) < townMaxLife(b.tiles[id]))
    .map(([id, owner]) => {
      const t = b.tiles[id], life = townLife(t), max = townMaxLife(t);
      const w = S * 0.2, gap = S * 0.07, span = max * w + (max - 1) * gap;
      return `<g pointer-events="none">${Array.from({ length: max }, (_, i) =>
        `<rect x="${(t.x - span / 2 + i * (w + gap)).toFixed(1)}" y="${(t.y + S * 0.74).toFixed(1)}"
           width="${w.toFixed(1)}" height="${(S * 0.16).toFixed(1)}" rx="0.5"
           fill="${i < life ? PLAYERS[owner].color : "none"}"
           stroke="${i < life ? PLAYERS[owner].color : "var(--bad)"}" stroke-width="0.9"/>`).join("")}</g>`;
    }).join("");

  const mendSites = !(building && ui.build === "mend") ? "" : b.tiles
    .filter(t => canRepairWall(game.current, t))
    .map(t => `<polygon class="drop" data-mend="${t.id}" points="${hex(t)}"
       fill="none" stroke="${PLAYERS[game.current].color}" stroke-width="3"/>`).join("");

  /* standing walls: a heavy ring just inside the hex, with one notch per life lost */
  /* A wall is a heavy ring plus a strength bar: one filled block per life left, hollow
     for each one battered away. The bar sits on its own dark plate inside the hex, so it
     reads against any terrain and is never clipped by the hex edge. */
  const ramparts = [...game.walls].map(([id, w]) => {
    const t = b.tiles[id], c = PLAYERS[w.owner].color;
    const bw = S * 0.26, gap = S * 0.08, h = S * 0.24;
    const span = WALL.lives * bw + (WALL.lives - 1) * gap;
    const x0 = t.x - span / 2, y0 = t.y - S * 0.62;
    const blocks = Array.from({ length: WALL.lives }, (_, i) =>
      `<rect x="${(x0 + i * (bw + gap)).toFixed(1)}" y="${y0.toFixed(1)}"
         width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="0.6"
         fill="${i < w.lives ? c : "none"}" fill-opacity="${i < w.lives ? 1 : 0}"
         stroke="${c}" stroke-width="0.9" stroke-opacity="${i < w.lives ? 1 : 0.55}"/>`).join("");
    return `<g pointer-events="none">
        <polygon points="${insetRing(t, 0.93)}" fill="none" stroke="${c}"
          stroke-width="3.5" opacity="0.95"/>
        <rect x="${(x0 - gap).toFixed(1)}" y="${(y0 - gap).toFixed(1)}"
          width="${(span + gap * 2).toFixed(1)}" height="${(h + gap * 2).toFixed(1)}"
          rx="1" fill="#06101A" fill-opacity="0.72"/>
        ${blocks}
      </g>`;
  }).join("");

  /* Kings, on the towns that hold them. `kingVisibleTo` is the multiplayer seam — it
     returns true for everyone today, so the whole table can see every crown. */
  const crowns = [...game.kings].filter(([owner]) => kingVisibleTo(game.current, owner))
    .map(([owner, id]) => {
      const t = b.tiles[id], c = PLAYERS[owner].color;
      const w = S * 0.34, y = t.y - S * 0.26;
      return `<g pointer-events="none">
          <path d="M${(t.x - w).toFixed(1)} ${(y + w * 0.9).toFixed(1)}
                   L${(t.x - w).toFixed(1)} ${(y - w * 0.5).toFixed(1)}
                   L${(t.x - w * 0.45).toFixed(1)} ${y.toFixed(1)}
                   L${t.x.toFixed(1)} ${(y - w * 0.75).toFixed(1)}
                   L${(t.x + w * 0.45).toFixed(1)} ${y.toFixed(1)}
                   L${(t.x + w).toFixed(1)} ${(y - w * 0.5).toFixed(1)}
                   L${(t.x + w).toFixed(1)} ${(y + w * 0.9).toFixed(1)} Z"
             fill="${c}" stroke="#06101A" stroke-width="1"/>
        </g>`;
    }).join("");

  /* towns that can take a king, while one is owed */
  const seats = !seating ? "" : b.tiles
    .filter(t => legalKingSeat(seatingFor, t))
    .map(t => `<polygon class="drop" data-seat="${t.id}" points="${hex(t)}"
       fill="none" stroke="${PLAYERS[seatingFor].color}" stroke-width="3"/>`).join("");

  /* a port: the same ring as a town, dashed, with its pip centred rather than below */
  const harbours = [...game.ports].map(([id, owner]) => {
    const t = b.tiles[id], c = PLAYERS[owner].color;
    return `<polygon points="${insetRing(t, 0.86)}" fill="none" stroke="${c}" stroke-width="2.5"
              stroke-dasharray="5 3" pointer-events="none"/>
            <circle cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="3.2" fill="${c}"
              stroke="#0B1620" stroke-width="1.2" pointer-events="none"/>`;
  }).join("");

  const army = [...game.units.values()].map(u => {
    const t = b.tiles[u.tile], c = PLAYERS[u.owner].color;
    const on = ui.selected === u.id;
    return `<g class="unit" pointer-events="none">
        <circle cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="${(S * 0.36).toFixed(1)}"
          fill="var(--void)" stroke="${c}" stroke-width="${on ? 3.5 : 2}"
          ${injured(u) ? 'stroke-dasharray="3 2"' : ""} opacity="0.95"/>
        <text x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" fill="${c}"
          font-size="${(S * 0.5).toFixed(1)}" text-anchor="middle" dominant-baseline="central"
          font-family="var(--sans, sans-serif)">${UNITS[u.kind].short}</text>
      </g>`;
  }).join("");

  svg.innerHTML = terrain + glyphs + slots + built + sites + moves + attacks
                + drops + portSites + wallSites + mendSites + rebuild + seats + plots
                + marks + harbours + ramparts + scars + crowns + army;
  svg.parentElement.classList.toggle("placing", placing || seating);
  svg.parentElement.classList.toggle("building", building);
}
