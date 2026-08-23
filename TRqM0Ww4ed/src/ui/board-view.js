/* Draws the hex board: terrain polygons, terrain glyphs, and town markers. */

import { S, PLAYERS, UNITS } from "../config.js";
import { TERRAIN } from "../terrain.js";
import { hexPoints, corner } from "../hex.js";
import { game, legalTown, canBuild, legalEdge, legalExpansion, networkVerts,
         reachable, targetsOf, canAttack, injured, legalRecruit, legalPort } from "../game.js";
import { ui } from "./state.js";

export function renderBoard(svg) {
  const b = game.board;
  if (!b) return;
  const w = S * Math.sqrt(3) * (b.cols + 0.5), h = S * 1.5 * b.rows + S * 0.5;
  svg.setAttribute("viewBox", `${-S * 1.9} ${-S * 1.4} ${w + S * 2} ${h + S * 1.6}`);

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

  const marks = [...game.towns].map(([id, pi]) => {
    const t = b.tiles[id], c = PLAYERS[pi].color;
    const ring = [0, 1, 2, 3, 4, 5].map(n => {
      const [cx, cy] = corner(t.col, t.row, n);
      return [(t.x + (cx - t.x) * 0.86).toFixed(1), (t.y + (cy - t.y) * 0.86).toFixed(1)].join(",");
    }).join(" ");
    return `<polygon points="${ring}" fill="none" stroke="${c}" stroke-width="3" pointer-events="none"/>
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

  /* Buildable edges for the player whose build window is open. */
  const slots = !building ? "" : b.edges.filter(e => legalEdge(game.current, e.id, net))
    .map(e => line(e, `class="slot ${e.water ? "bridge" : ""}" data-edge="${e.id}"
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

  const attacks = !ordering || !canAttack(sel) ? "" : targetsOf(sel).map(e =>
    `<polygon class="strike" data-attack="${e.tile}" points="${hex(b.tiles[e.tile])}"
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

  /* every port on the board, as a small anchor mark */
  const harbours = [...game.ports].map(([id, owner]) => {
    const t = b.tiles[id], c = PLAYERS[owner].color;
    return `<g pointer-events="none">
        <circle cx="${t.x.toFixed(1)}" cy="${(t.y - S * 0.05).toFixed(1)}" r="${(S * 0.3).toFixed(1)}"
          fill="none" stroke="${c}" stroke-width="2.5"/>
        <path d="M${(t.x - S * 0.22).toFixed(1)} ${(t.y - S * 0.05).toFixed(1)}
                 h${(S * 0.44).toFixed(1)} M${t.x.toFixed(1)} ${(t.y - S * 0.3).toFixed(1)}
                 v${(S * 0.5).toFixed(1)}" stroke="${c}" stroke-width="2" fill="none"/>
      </g>`;
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
                + drops + portSites + marks + harbours + army;
  svg.parentElement.classList.toggle("placing", placing);
  svg.parentElement.classList.toggle("building", building);
}
