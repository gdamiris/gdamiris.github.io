/* Boot and DOM wiring. Everything here is glue: state lives in game.js,
   drawing lives in ui/. */

import { BOARD_SIZES, PLAYERS, TUNING } from "./config.js";
import { generateBoard } from "./generate.js";
import * as G from "./game.js";
import { mountSprites } from "./ui/icons.js";
import { renderBoard } from "./ui/board-view.js";
import { renderPanel } from "./ui/panel-view.js";
import { ui, clearUi } from "./ui/state.js";

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
  clearUi();
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

/* Order matters: army overlays sit above the terrain and must be read first. */
boardSvg.onclick = e => {
  const hit = sel => e.target.closest(sel);

  const edge = hit("line[data-edge]");
  if (edge) {
    const e = G.game.board.edges[+edge.dataset.edge];
    G.buildEdge(e.id, G.isCoastalEdge(e) ? ui.edgeKind : null);
    return render();
  }

  const harbour = hit("[data-port]");
  if (harbour) { G.buildPort(G.game.board.tiles[+harbour.dataset.port]); ui.build = null; return render(); }

  const seat = hit("[data-seat]");
  if (seat) { G.seatKing(G.game.board.tiles[+seat.dataset.seat]); return render(); }

  const plot = hit("[data-plot]");
  if (plot) {
    const tid = +plot.dataset.plot;
    if (ui.spyAct === "kill") G.assassinate(ui.selected, tid);
    else if (ui.spyAct === "steal") G.stealFrom(ui.selected, tid);
    else G.peekTown(ui.selected, tid);
    ui.spyAct = null;
    return render();
  }

  const rampart = hit("[data-wall]");
  if (rampart) { G.buildWall(G.game.board.tiles[+rampart.dataset.wall]); ui.build = null; return render(); }

  const rebuilt = hit("[data-rebuild]");
  if (rebuilt) { G.repairTown(G.game.board.tiles[+rebuilt.dataset.rebuild]); return render(); }

  const mend = hit("[data-mend]");
  if (mend) { G.repairWall(G.game.board.tiles[+mend.dataset.mend]); return render(); }

  const drop = hit("[data-recruit]");
  if (drop) { G.recruit(ui.recruit, G.game.board.tiles[+drop.dataset.recruit]); ui.recruit = null; return render(); }

  const strike = hit("[data-attack]");
  if (strike) { G.attackUnit(ui.selected, +strike.dataset.attack); return render(); }

  const move = hit("[data-move]");
  if (move) { G.moveUnit(ui.selected, +move.dataset.move); return render(); }

  const el = hit("polygon.tile");
  if (!el) return;
  const t = G.game.board.tiles[+el.dataset.id];

  /* clicking your own unit selects it; anything else is a build or a placement */
  const unit = G.unitAt(t.id);
  if (unit && unit.owner === G.game.current && G.canBuild()) {
    ui.selected = ui.selected === unit.id ? null : unit.id;
    ui.recruit = null;
    return render();
  }
  ui.selected = null;
  if (G.game.phase === "placing") G.placeTown(t); else G.buildTown(t);
  render();
};

$("army").onclick = e => {
  const r = e.target.closest("[data-recruit]");
  if (r) {
    ui.recruit = ui.recruit === r.dataset.recruit ? null : r.dataset.recruit;
    ui.selected = null; ui.build = null;
    return render();
  }
  const order = e.target.closest("[data-order]");
  if (!order) return;
  if (order.dataset.order === "revive") { G.reviveUnit(ui.selected); return render(); }
  /* spy work is two-step: arm it here, then click the brass-outlined town */
  ui.spyAct = ui.spyAct === order.dataset.order ? null : order.dataset.order;
  render();
};

$("trade").onclick = e => {
  const g = e.target.closest("[data-give]");
  if (g) { ui.give = ui.give === g.dataset.give ? null : g.dataset.give; return render(); }
  const w = e.target.closest("[data-want]");
  if (w) { G.trade(ui.give, w.dataset.want); ui.give = null; render(); }
};

$("build").onclick = e => {
  const k = e.target.closest("[data-edgekind]");
  if (k) { ui.edgeKind = k.dataset.edgekind; return render(); }

  const b = e.target.closest("[data-build]");
  if (!b) return;
  ui.build = ui.build === b.dataset.build ? null : b.dataset.build;
  ui.recruit = null; ui.selected = null;
  render();
};

$("roll").onclick    = () => { G.rollDice(); render(); };
$("endturn").onclick = () => { G.endTurn(); clearUi(); render(); };

$("dice").onclick = e => {
  const d = e.target.closest(".die[data-armed]");
  if (!d) return;
  G.resolveRoll(+d.dataset.i);
  render();
};

$("wild").onclick = e => {
  const p = e.target.closest("[data-wild]");
  if (!p) return;
  G.nameWild(p.dataset.wild);
  render();
};

regenerate();
