/* Boot and DOM wiring. Everything here is glue: state lives in game.js,
   drawing lives in ui/. */

import { BOARD_SIZES, PLAYERS, TUNING } from "./config.js";
import { generateBoard } from "./generate.js";
import * as G from "./game.js";
import { mountSprites } from "./ui/icons.js";
import { renderBoard } from "./ui/board-view.js";
import { renderPanel } from "./ui/panel-view.js";

const $ = id => document.getElementById(id);
const boardSvg = $("board");

mountSprites($("sprites"));

$("size").innerHTML = BOARD_SIZES.map(s =>
  `<option value="${s.id}" ${s.default ? "selected" : ""}>${s.label}</option>`).join("");
$("players").innerHTML = [2, 3, 4, 5, 6].map(n =>
  `<option value="${n}" ${n === G.game.playerCount ? "selected" : ""}>${n} players</option>`).join("");

const render = () => { renderBoard(boardSvg); renderPanel(); };

function regenerate() {
  const [cols, rows] = $("size").value.split(",").map(Number);
  G.setBoard(generateBoard($("seed").value || "halcyon", cols, rows, TUNING));
  window.BOARD = G.game.board;   // handy for console poking
  render();
}

/* ---------- events ---------- */
$("seed").oninput   = regenerate;
$("size").onchange  = regenerate;
$("reroll").onclick = () => { $("seed").value = Math.random().toString(36).slice(2, 10); regenerate(); };

$("copy").onclick = async e => {
  await navigator.clipboard.writeText(JSON.stringify(G.game.board));
  e.target.textContent = "Copied";
  setTimeout(() => e.target.textContent = "Copy JSON", 1200);
};

$("players").onchange = e => { G.setPlayers(+e.target.value); render(); };
$("start").onclick    = () => { G.startGame(); render(); };
$("reset").onclick    = () => { G.resetGame(); render(); };

boardSvg.onclick = e => {
  const el = e.target.closest("polygon.tile");
  if (!el) return;
  G.placeTown(G.game.board.tiles[+el.dataset.id]);
  render();
};

$("roll").onclick = () => { G.rollDice(); render(); };

$("dice").onclick = e => {
  const d = e.target.closest(".die[data-armed]");
  if (!d) return;
  G.resolveRoll(+d.dataset.i);
  render();
};

regenerate();
