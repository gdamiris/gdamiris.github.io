/* Draws the side panel: turn colour, player chips and hands, dice, legend, stats, log. */

import { PLAYERS, RESOURCES, COSTS, UNITS } from "../config.js";
import { TERRAIN, faceSpec } from "../terrain.js";
import { tileCounts, deadFaces } from "../generate.js";
import { game, canBuild, canAfford, canAffordUnit, canMove, canAttack, canRevive,
         injured, unitsOf, portsOf, atPort, hasBerth, blockaders, rangeLabel } from "../game.js";
import { glyph } from "./icons.js";
import { ui } from "./state.js";

const $ = id => document.getElementById(id);

export function renderPanel() {
  renderChips();
  renderStatus();
  renderDice();
  renderBuild();
  renderArmy();
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
      ${game.phase === "play" ? `<div class="hand">${RESOURCES.map(f =>
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
                            : game.rolled    ? `Turn ${game.turnNo} — ${PLAYERS[game.current].name}: build or end turn`
                                             : `Turn ${game.turnNo} — ${PLAYERS[game.current].name} to roll`)
    : "Pick player count, then start";

  $("roll").disabled     = game.phase !== "play" || game.awaiting || game.rolled;
  $("endturn").disabled  = !canBuild();
}

function renderDice() {
  const rc = game.roller === null ? "var(--brass)" : PLAYERS[game.roller].color;
  const a = game.award;
  const dice = game.dice.map((f, i) => {
    if (!f) return `<div class="die"><div class="nm muted">—</div></div>`;
    /* On doubles nobody chose, so neither die may be dressed up as a deliberate keep. */
    const isKept = !game.doubles && game.keptIndex === i;
    const spec = faceSpec(f);
    const tag = game.awaiting ? "click to keep"
              : game.needWild ? "naming…"
              : !a ? "—"
              : a.doubles ? `everyone +${a.kept + a.given}`
              : isKept ? `${PLAYERS[a.roller].name} +${a.kept}`
              : `everyone else +${a.given}`;
    return `<div class="die ${isKept ? "keep" : ""} ${!game.awaiting && a && a.doubles ? "dbl" : ""}"
        ${game.awaiting ? "data-armed" : ""} data-i="${i}"
        style="${isKept ? `border-color:${rc};box-shadow:inset 0 0 0 1px ${rc}` : ""}">
        <div class="face" style="background:${spec.color}">${glyph(f)}</div>
        <div class="nm">${spec.label}</div>
        <div class="tag" style="${isKept && game.roller !== null ? `color:${rc}` : ""}">${tag}</div>
      </div>`;
  }).join("");
  $("dice").innerHTML = dice;
  renderWild();
}

/* A wild pays nothing until the roller names a real resource — for themselves first,
   then for the table. */
function renderWild() {
  const slot = game.needWild;
  $("wild").innerHTML = !slot ? "" :
    `<div class="wild">
       <div class="ask">Wild — name a resource
         <b>${slot === "mine" ? "for yourself" : "for everyone else"}</b></div>
       <div class="picks">${RESOURCES.map(r =>
         `<button class="pick" data-wild="${r}" title="${TERRAIN[r].label}">
            <span class="sw" style="background:${TERRAIN[r].color}">${glyph(r)}</span>
          </button>`).join("")}</div>
     </div>`;
}

/* The three costs, greyed out until the current player can actually pay them.
   Edge type is not a choice, so road and bridge are shown as information, not buttons. */
function renderBuild() {
  const open = canBuild(), pi = game.current;
  const row = (name, cost, note) => {
    const ok = open && canAfford(pi, cost);
    return `<div class="cost ${ok ? "" : "off"}">
        <span class="what">${name}</span>
        <span class="price">${Object.entries(cost).map(([k, n]) =>
          `${n}${glyph(k, TERRAIN[k].color)}`).join("")}</span>
        <span class="note">${note}</span>
      </div>`;
  };
  const portOk = open && canAfford(pi, COSTS.port);
  $("build").innerHTML =
    row("Road", COSTS.road, "land edge") +
    row("Bridge", COSTS.bridge, "sea or fish edge") +
    row("Town", COSTS.town, "reachable tile") +
    `<button class="recruit ${ui.build === "port" ? "armed" : ""}" data-build="port"
       ${portOk ? "" : "disabled"}>
       <span class="what">Port</span>
       <span class="price">${Object.entries(COSTS.port).map(([k, n]) =>
         `${n}${glyph(k, TERRAIN[k].color)}`).join("")}</span>
     </button>` +
    `<div class="hint">${!open
      ? (game.phase === "play" ? "Roll first" : "No game running")
      : ui.build === "port" ? "Click an outlined water tile beside land"
      : "Click a highlighted edge or circled tile"}</div>`;
}

/* Recruiting is two-step: arm a unit kind here, then click one of your towns.
   Below it, the orders available to whichever unit is selected. */
function renderArmy() {
  const open = canBuild(), pi = game.current;
  const price = spec =>
    Object.entries(spec.cost).map(([k, n]) => `${n}${glyph(k, TERRAIN[k].color)}`).join("") +
    (spec.either ? ` +1${spec.either.map(r => glyph(r, TERRAIN[r].color)).join("")}` : "");

  /* a boat needs a port; either kind also needs somewhere free to muster */
  const why = k => {
    if (UNITS[k].home === "port" && portsOf(pi).length === 0) return "Needs a port";
    if (!hasBerth(pi, k)) return UNITS[k].home === "port"
      ? "Every port is blockaded or occupied" : "Every town already holds a unit";
    return "";
  };

  const buttons = Object.entries(UNITS).map(([k, spec]) => {
    const blocked = why(k);
    return `<button class="recruit ${ui.recruit === k ? "armed" : ""}" data-recruit="${k}"
       ${open && canAffordUnit(pi, k) && !blocked ? "" : "disabled"}
       title="${blocked}">
       <span class="what">${spec.label}</span><span class="price">${price(spec)}</span>
     </button>`;
  }).join("");

  const siege = blockaders(pi);

  const sel = ui.selected === null ? null : game.units.get(ui.selected);
  let orders;
  if (!open) {
    orders = `<div class="hint">${game.phase === "play" ? "Roll first" : "No game running"}</div>`;
  } else if (ui.recruit) {
    orders = `<div class="hint">Click one of your towns to place the ${UNITS[ui.recruit].label.toLowerCase()}</div>`;
  } else if (!sel || sel.owner !== pi) {
    const n = unitsOf(pi).length;
    orders = `<div class="hint">${n ? "Click one of your units to give it orders" : "No units yet"}</div>`;
  } else {
    const spec = UNITS[sel.kind];
    const can = [canMove(sel) && "move", canAttack(sel) && "attack"].filter(Boolean);
    const stranded = injured(sel) && spec.reviveAtPort && !atPort(sel);
    orders = `<div class="orders">
        <div><b>${spec.label}</b> · ${sel.lives}/${spec.lives} lives
          ${injured(sel) ? `<span class="bad">injured</span>` : ""}</div>
        <div class="can">${can.length ? `can ${can.join(" or ")}` : "spent for this turn"}
          ${spec.range[0] > 1 ? ` · strikes at ${rangeLabel(sel.kind)}` : ""}</div>
        ${canRevive(sel) ? `<button class="wide" data-order="revive">Revive</button>` : ""}
        ${stranded ? `<div class="hint">Sail back into one of your ports to repair</div>` : ""}
        ${injured(sel) && spec.noRevive ? `<div class="hint">Damage to a ${spec.label.toLowerCase()} is permanent</div>` : ""}
      </div>`;
  }
  const warning = siege.length
    ? `<div class="hint bad">${siege.length} of your port${siege.length > 1 ? "s are" : " is"} blockaded</div>`
    : "";
  $("army").innerHTML = buttons + warning + orders;
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
     <b>${b.buildable}</b> town sites · <b>${b.roadSlots}</b> road / <b>${b.bridgeSlots}</b> bridge edges
     ${got < b.islands ? `<br><span class="bad">Board too small for ${b.islands} islands</span>` : ""}
     ${dead.length ? `<br><span class="bad">No tiles for: ${dead.map(f => TERRAIN[f].label).join(", ")}</span>` : ""}`;
}

function renderLog() {
  $("log").innerHTML = game.events.map(e => `<div>${e}</div>`).join("");
}
