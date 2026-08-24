/* Draws the side panel: turn colour, player chips and hands, dice, legend, stats, log. */

import { PLAYERS, RESOURCES, COSTS, UNITS, WALL, RULES, SCORE } from "../config.js";
import { TERRAIN, faceSpec } from "../terrain.js";
import { tileCounts, deadFaces } from "../generate.js";
import { game, canBuild, canAfford, canAffordUnit, canMove, canAttack, canRevive,
         injured, unitsOf, portsOf, atPort, hasBerth, blockaders, rangeLabel,
         canRepairWall, wallsOf, sheltered, withinCap, countOf, capOf,
         townsOf, merchantsOf, owesKing, isSpy, spyTargets, kingOf, stealable,
         canRepairTown, townLife, townMaxLife, tradeRatio, canTrade,
         scoreOf, standingScore } from "../game.js";
import { glyph } from "./icons.js";
import { ui } from "./state.js";

const $ = id => document.getElementById(id);

export function renderPanel() {
  renderChips();
  renderStatus();
  renderDice();
  renderBuild();
  renderTrade();
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
    const active = (game.phase === "placing" && game.turn === i) || (game.phase === "play" && game.current === i);
    const hand = game.hands[i];
    /* towns and merchants are what a player's position amounts to: muster points, and
       the income standing on the ground */
    const towns = townsOf(i).length, traders = merchantsOf(i).length;
    const pts = scoreOf(i);
    const lead = Math.max(...PLAYERS.slice(0, game.playerCount).map((_, k) => scoreOf(k)));
    const crowned = kingOf(i) ? " ♚" : "";
    const label = game.phase === "placing" && game.turn === i ? "placing…"
                : towns ? `${towns} town${towns > 1 ? "s" : ""}` +
                          (traders ? ` · ${traders}M` : "") + crowned
                : "—";
    return `<div class="chip ${active ? "active" : ""} ${game.winner === i ? "won" : ""}">
        <span class="dot" style="background:${p.color}"></span>${p.name}
        <span class="done">${label}</span>
        <span class="pts ${pts === lead && pts > 0 ? "lead" : ""}"
              title="${standingScore(i)} standing + ${game.earned[i]} earned">${pts}</span>
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
  st.textContent = game.winner !== null
    ? `${PLAYERS[game.winner].name} wins with ${scoreOf(game.winner)} of ${SCORE.target} points`
    : game.notice ? game.notice
    : game.phase === "placing"
      ? `${PLAYERS[game.turn].name}: found town ${Math.floor(game.placed / game.playerCount) + 1}`
        + ` of ${RULES.TOWNS_AT_START} — click a tile`
    : game.phase === "crowning"
      ? `${PLAYERS[game.turn].name}: seat your king — click one of your towns`
    : owesKing(game.current)
      ? `${PLAYERS[game.current].name}: seat a new king — click a different town`
    : game.phase === "play" ? (game.awaiting ? `Turn ${game.turnNo} — ${PLAYERS[game.current].name}: keep one die`
                            : game.needWild  ? `Turn ${game.turnNo} — name the wild`
                            : game.rolled && game.award && game.award.famine
                              ? `Famine — nobody produced; 1 lost per ${RULES.FAMINE_PER} held`
                            : game.rolled    ? `Turn ${game.turnNo} — ${PLAYERS[game.current].name}: build or end turn`
                                             : `Turn ${game.turnNo} — ${PLAYERS[game.current].name} to roll`)
    : "Pick player count, then start";

  $("roll").disabled     = game.phase !== "play" || game.awaiting || game.rolled
                           || owesKing(game.current);
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
              : a.famine ? "famine"
              : a.doubles ? `everyone +${a.kept + a.given}`
              : isKept ? `${PLAYERS[a.roller].name} +${a.kept}`
              : `everyone else +${a.given}`;
    return `<div class="die ${isKept ? "keep" : ""} ${!game.awaiting && a && a.doubles ? "dbl" : ""}
        ${a && a.famine ? "famine" : ""}"
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
  const priceOf = cost => Object.entries(cost)
    .map(([k, n]) => `${n}${glyph(k, TERRAIN[k].color)}`).join("");
  const arm = (mode, label, cost, ok) =>
    `<button class="recruit ${ui.build === mode ? "armed" : ""}" data-build="${mode}"
       ${ok ? "" : "disabled"}>
       <span class="what">${label}</span><span class="price">${priceOf(cost)}</span>
     </button>`;

  const mendable = open && game.board
    && game.board.tiles.some(t => canRepairWall(pi, t));

  /* A coastal edge takes either kind, so the player says which a click means. */
  const shore = `<div class="cost shore">
      <span class="what">Shore</span>
      <span class="toggle">${["bridge", "road"].map(k =>
        `<button class="${ui.edgeKind === k ? "on" : ""}" data-edgekind="${k}"
           ${open ? "" : "disabled"}>${k}</button>`).join("")}</span>
      <span class="note">coastal edge</span>
    </div>`;

  $("build").innerHTML =
    row("Road", COSTS.road, "land on both sides") +
    row("Bridge", COSTS.bridge, "water on one side") +
    shore +
    row("Town", COSTS.town, "reachable tile") +
    arm("port", "Port", COSTS.port, open && canAfford(pi, COSTS.port)) +
    arm("wall", "Wall", COSTS.wall, open && canAfford(pi, COSTS.wall)) +
    (wallsOf(pi).length ? arm("mend", "Repair wall", WALL.repair, mendable) + wallList(pi) : "") +
    (hurtTowns(pi).length
      ? arm("rebuild", "Rebuild town", COSTS.townRepair,
            open && hurtTowns(pi).some(t => canRepairTown(pi, t))) + townList(pi) : "") +
    `<div class="hint">${!open
      ? (game.phase === "play" ? "Roll first" : "No game running")
      : ui.build === "port" ? "Click an outlined water tile beside land"
      : ui.build === "wall" ? "Click one of your towns to wall it"
      : ui.build === "mend" ? "Click an outlined wall — one life per turn"
      : ui.build === "rebuild" ? "Click an outlined town — one life per turn"
      : "Click a highlighted edge or circled tile"}</div>`;
}

/* A spy's work, armed here and aimed by clicking a brass-outlined town. */
function spyOrders(sel) {
  const towns = spyTargets(sel).length;
  if (!towns) return `<div class="hint">Move beside an enemy town to work</div>`;
  if (sel.acted) return `<div class="hint">This spy has already acted</div>`;
  const btn = (act, label, cost) =>
    `<button class="recruit ${ui.spyAct === act ? "armed" : ""}" data-order="${act}"
       ${canAfford(sel.owner, cost) ? "" : "disabled"}>
       <span class="what">${label}</span>
       <span class="price">${Object.entries(cost).map(([k, n]) =>
         `${n}${glyph(k, TERRAIN[k].color)}`).join("")}</span>
     </button>`;
  /* say up front what a raid would come away with — it is all public knowledge anyway */
  const loot = spyTargets(sel).map(t => stealable(sel, t.id)).filter(Boolean);
  const spoils = loot.length
    ? [...new Set(loot)].map(r => glyph(r, TERRAIN[r].color)).join("")
    : "<span class='muted'>nothing to take</span>";

  return btn("peek", "Scout", COSTS.peek)
    + btn("steal", "Steal", COSTS.steal)
    + btn("kill", "Assassinate", COSTS.assassinate)
    + `<div class="hint">${ui.spyAct === "steal" ? `Would take ${spoils}`
        : ui.spyAct ? "Click an outlined town"
        : `${towns} town${towns > 1 ? "s" : ""} in reach`}</div>`;
}

/* Towns that have taken a beating, weakest first, so a siege is never a surprise. */
const hurtTowns = pi => townsOf(pi).filter(t => townLife(t) < townMaxLife(t));

function townList(pi) {
  return `<div class="walls">${hurtTowns(pi)
    .sort((a, b) => townLife(a) - townLife(b))
    .map(t => {
      const life = townLife(t), max = townMaxLife(t);
      return `<div class="wallrow hurt">
         <span class="where">${t.col},${t.row}</span>
         <span class="bar">${Array.from({ length: max }, (_, i) =>
           `<i class="${i < life ? "on" : ""}"></i>`).join("")}</span>
         <span class="n">${life}/${max}</span>
       </div>`;
    }).join("")}</div>`;
}

/* Your walls and how much of each is left standing, so their strength is never something
   you had to be watching the log to know. */
function wallList(pi) {
  const walls = wallsOf(pi).map(t => ({ t, w: game.walls.get(t.id) }))
    .sort((a, b) => a.w.lives - b.w.lives);
  return `<div class="walls">${walls.map(({ t, w }) =>
    `<div class="wallrow ${w.lives < WALL.lives ? "hurt" : ""}">
       <span class="where">${t.col},${t.row}</span>
       <span class="bar">${Array.from({ length: WALL.lives }, (_, i) =>
         `<i class="${i < w.lives ? "on" : ""}"></i>`).join("")}</span>
       <span class="n">${w.lives}/${WALL.lives}</span>
     </div>`).join("")}</div>`;
}

/* Trade is two-step: pick what you are giving, then what you want back. The rate for
   each resource is shown up front, since holding the right ground is what lowers it. */
function renderTrade() {
  const open = canBuild(), pi = game.current;
  const rates = RESOURCES.map(r => {
    const rate = tradeRatio(pi, r), armed = ui.give === r;
    const can = open && game.hands[pi][r] >= rate;
    return `<button class="rate ${armed ? "armed" : ""}" data-give="${r}"
        ${can ? "" : "disabled"} title="${TERRAIN[r].label}: ${rate} for 1">
        <span class="sw" style="background:${TERRAIN[r].color}">${glyph(r)}</span>
        <span class="n">${rate}</span>
      </button>`;
  }).join("");

  const wants = !ui.give ? "" : `<div class="picks">${RESOURCES
    .filter(r => r !== ui.give)
    .map(r => `<button class="pick" data-want="${r}" title="${TERRAIN[r].label}"
        ${canTrade(pi, ui.give, r) ? "" : "disabled"}>
        <span class="sw" style="background:${TERRAIN[r].color}">${glyph(r)}</span>
      </button>`).join("")}</div>`;

  $("trade").innerHTML = `<div class="rates">${rates}</div>${wants}
    <div class="hint">${!open ? "Roll first"
      : ui.give ? `Give ${tradeRatio(pi, ui.give)} ${TERRAIN[ui.give].label} — pick what you want`
      : "A town on the ground takes 1 off, its roads 1 more"}</div>`;
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
    if (!withinCap(pi, k))
      return `${countOf(pi, k)} of ${capOf(pi, k)} — ${UNITS[k].perTown} per town`;
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
          ${!spec.range ? " · civilian, cannot fight"
            : spec.range[0] > 1 ? ` · strikes at ${rangeLabel(sel.kind)}` : ""}
          ${spec.trades ? ` · trading ${TERRAIN[game.board.tiles[sel.tile].terrain].label}` : ""}</div>
        ${canRevive(sel) ? `<button class="wide" data-order="revive">Revive</button>` : ""}
        ${isSpy(sel) ? spyOrders(sel) : ""}
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
