/* Draws the hex board: terrain polygons, terrain glyphs, and town markers. */

import { S, PLAYERS } from "../config.js";
import { TERRAIN } from "../terrain.js";
import { hexPoints, corner } from "../hex.js";
import { game, legalTown } from "../game.js";

export function renderBoard(svg) {
  const b = game.board;
  if (!b) return;
  const w = S * Math.sqrt(3) * (b.cols + 0.5), h = S * 1.5 * b.rows + S * 0.5;
  svg.setAttribute("viewBox", `${-S * 1.9} ${-S * 1.4} ${w + S * 2} ${h + S * 1.6}`);

  const placing = game.phase === "placing";
  const kept = game.keptIndex === null ? null : game.dice[game.keptIndex];
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

  svg.innerHTML = terrain + glyphs + marks;
  svg.parentElement.classList.toggle("placing", placing);
}
