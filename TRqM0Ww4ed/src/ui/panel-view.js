/* Draws the side panel: turn colour, player chips and hands, dice, legend, stats, log. */

import { PLAYERS, DIE_FACES } from "../config.js";
import { TERRAIN } from "../terrain.js";
import { tileCounts, deadFaces } from "../generate.js";
import { game } from "../game.js";
import { glyph } from "./icons.js";

const $ = id => document.getElementById(id);

export function renderPanel() {
  renderChips();
  renderStatus();
  renderDice();
  renderLegend();
  renderStats();
  renderLog();
}

function activePlayer() {
  return game.phase === "placing" ? game.turn : game.phase === "play" ? game.current : null;
}

function renderChips() {
  $("chips").innerHTML = PLAYERS.slice(0, game.playerCount).map((p, i) => {
    const town = [...game.towns].find(([, pi]) => pi === i);
    const active = (game.phase === "placing" && game.turn === i) || (game.phase === "play" && game.current === i);
    const hand = game.hands[i];
    const label = town ? TERRAIN[game.board.tiles[town[0]].terrain].label
                 : (game.phase === "placing" && game.turn === i ? "placing…" : "—");
    return `<div class="chip ${active ? "active" : ""}">
        <span class="dot" style="background:${p.color}"></span>${p.name}
        <span class="done">${label}</span>
      </div>
      ${game.phase === "play" ? `<div class="hand">${DIE_FACES.map(f =>
        `<span class="${hand[f] ? "" : "zero"}">${glyph(f, TERRAIN[f].color)}${hand[f]}</span>`).join("")}</div>` : ""}`;
  }).join("");
}

function renderStatus() {
  const active = activePlayer();
  document.body.style.setProperty("--turn", active === null ? "" : PLAYERS[active].color);

  $("turnbar").innerHTML = game.phase === "play"
    ? `<span class="dot"></span>Turn ${game.turnNo} — <span class="who">${PLAYERS[game.current].name}</span>`
    : `<span class="muted">no game running</span>`;

  const st = $("status");
  st.classList.toggle("bad", !!game.notice);
  st.textContent = game.notice ? game.notice
    : game.phase === "placing" ? `${PLAYERS[game.turn].name}: click a tile to found your town`
    : game.phase === "play" ? (game.awaiting ? `Turn ${game.turnNo} — ${PLAYERS[game.current].name}: keep one die`
                                             : `Turn ${game.turnNo} — ${PLAYERS[game.current].name} to roll`)
    : "Pick player count, then start";

  $("roll").disabled = game.phase !== "play" || game.awaiting;
}

function renderDice() {
  const rc = game.roller === null ? "var(--brass)" : PLAYERS[game.roller].color;
  const a = game.award;
  $("dice").innerHTML = game.dice.map((f, i) => {
    if (!f) return `<div class="die"><div class="nm muted">—</div></div>`;
    /* On doubles nobody chose, so neither die may be dressed up as a deliberate keep. */
    const isKept = !game.doubles && game.keptIndex === i;
    const tag = game.awaiting ? "click to keep"
              : !a ? "—"
              : a.doubles ? `everyone +${a.kept + a.given}`
              : isKept ? `${PLAYERS[a.roller].name} +${a.kept}`
              : `everyone else +${a.given}`;
    return `<div class="die ${isKept ? "keep" : ""} ${!game.awaiting && a && a.doubles ? "dbl" : ""}"
        ${game.awaiting ? "data-armed" : ""} data-i="${i}"
        style="${isKept ? `border-color:${rc};box-shadow:inset 0 0 0 1px ${rc}` : ""}">
        <div class="face" style="background:${TERRAIN[f].color}">${glyph(f)}</div>
        <div class="nm">${TERRAIN[f].label}</div>
        <div class="tag" style="${isKept && game.roller !== null ? `color:${rc}` : ""}">${tag}</div>
      </div>`;
  }).join("");
}

function renderLegend() {
  const counts = tileCounts(game.board);
  $("legend").innerHTML = Object.entries(TERRAIN).map(([k, v]) =>
    `<tr><td><span class="sw" style="background:${v.color}">${glyph(k)}</span>${v.label}</td>
         <td class="n">${counts[k] || 0}</td></tr>`).join("");
}

function renderStats() {
  const b = game.board, counts = tileCounts(b), N = b.tiles.length;
  const water = (counts.sea || 0) + (counts.fish || 0);
  const got = b.sizes.length;
  const dead = deadFaces(b);
  $("title").textContent = `${b.cols} × ${b.rows} · ${N} tiles`;
  $("counts").innerHTML =
    `<b>${b.per}</b> tiles of each resource<br>
     <b>${got}</b> island${got === 1 ? "" : "s"} — ${b.sizes.join(" / ")} tiles<br>
     <b>${Math.round((N - water) / N * 100)}%</b> land / <b>${Math.round(water / N * 100)}%</b> water<br>
     <b>${b.buildable}</b> city sites · <b>${b.roadSlots}</b> road slots
     ${got < b.islands ? `<br><span class="bad">Board too small for ${b.islands} islands</span>` : ""}
     ${dead.length ? `<br><span class="bad">No tiles for: ${dead.map(f => TERRAIN[f].label).join(", ")}</span>` : ""}`;
}

function renderLog() {
  $("log").innerHTML = game.events.map(e => `<div>${e}</div>`).join("");
}
