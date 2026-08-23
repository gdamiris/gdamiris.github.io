/* Draws the hex board: terrain polygons, terrain glyphs, and town markers. */

import { S, PLAYERS, UNITS } from "../config.js";
import { TERRAIN } from "../terrain.js";
import { hexPoints, corner } from "../hex.js";
import { game, legalTown, canBuild, legalEdge, legalExpansion, networkVerts,
         reachable, targetsOf, wallTargetsOf, canAttack, injured, legalRecruit, legalPort,
         legalWall, canRepairWall, sheltered, isCoastalEdge, edgeKinds } from "../game.js";
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
  /* Cap the drawn width to the board's own size, so a bigger board actually looks
     bigger instead of being rescaled to the same box with smaller hexes. */
  svg.style.maxWidth = `${Math.round((w + S * 2) * PX_PER_UNIT)}px`;

  const placing = game.phase === "placing";
  const building = canBuild();
  const net = building ? networkVerts(game.current) : null;
  const kept = game.keptIndex === null ? null : game.dice[game.keptIndex];
  const canSettle = t => building && legalExpansion(game.current, t, net);
  const dimmed = t => placing && !legalTown(t);
  const W = S * 1.15;

  const terrain = b.tiles.map(t => {
    const spec = TERRAIN[t.terrain], lit = kept && t.terrain === kept;
    return `<polygon class="tile" data-id="${t.id}" points="${hexPoints(t.col, t.row)}" fill="${spec.color}"
      ${dimmed(t) ? 'opacity="0.35"' : ""} ${lit ? 'stroke="var(--brass)" stroke-width="2.5"' : ""}
      ><title>${spec.label} — ${t.col},${t.row}</title></polygon>`;
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

  /* where the selected unit may go, and who it may hit */
  const moves = !ordering ? "" : [...reachable(sel).keys()].map(id =>
    `<polygon class="move" data-move="${id}" points="${hex(b.tiles[id])}"
       fill="${PLAYERS[sel.owner].color}"/>`).join("");

  const attacks = !ordering || !canAttack(sel) ? "" :
    [...targetsOf(sel).map(e => e.tile), ...wallTargetsOf(sel)].map(tid =>
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

  const mendSites = !(building && ui.build === "mend") ? "" : b.tiles
    .filter(t => canRepairWall(game.current, t))
    .map(t => `<polygon class="drop" data-mend="${t.id}" points="${hex(t)}"
       fill="none" stroke="${PLAYERS[game.current].color}" stroke-width="3"/>`).join("");

  /* standing walls: a heavy ring just inside the hex, with one notch per life lost */
  const ramparts = [...game.walls].map(([id, w]) => {
    const t = b.tiles[id], c = PLAYERS[w.owner].color;
    const ring = insetRing(t, 0.97);
    const pips = Array.from({ length: WALL.lives }, (_, i) =>
      `<rect x="${(t.x - S * 0.42 + i * S * 0.22).toFixed(1)}" y="${(t.y - S * 0.82).toFixed(1)}"
         width="${(S * 0.15).toFixed(1)}" height="${(S * 0.15).toFixed(1)}"
         fill="${i < w.lives ? c : "none"}" stroke="${c}" stroke-width="1"/>`).join("");
    return `<g pointer-events="none">
        <polygon points="${ring}" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.9"/>
        ${pips}</g>`;
  }).join("");

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
                + drops + portSites + wallSites + mendSites
                + marks + harbours + ramparts + army;
  svg.parentElement.classList.toggle("placing", placing);
  svg.parentElement.classList.toggle("building", building);
}
