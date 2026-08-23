/* All game state and rules. No DOM access lives here, which is what lets the
   whole rule set be driven headlessly from tests (and later from netcode). */

import { PLAYERS, DIE_FACES, RULES, COSTS, UNITS } from "./config.js";
import { TERRAIN, settleable, isWater, isBlocked } from "./terrain.js";
import { hexDist, neighbours } from "./hex.js";

export const blankHand = () => Object.fromEntries(DIE_FACES.map(f => [f, 0]));

export const game = {
  board: null,
  phase: "idle",            // idle | placing | play
  playerCount: 3,
  towns: new Map(),         // tile id -> player index
  turn: 0,                  // placement cursor
  hands: PLAYERS.map(blankHand),
  turnNo: 0,
  current: 0,               // whose turn it is
  roller: null,             // who rolled the dice currently on screen
  awaiting: false,          // a die still needs choosing
  dice: [null, null],
  keptIndex: null,
  doubles: false,           // both faces matched, so there was no choice to make
  award: null,              // what the last roll actually paid, for the panel to show
  rolled: false,            // the current player has rolled, so building is open to them
  roads: new Map(),         // edge id -> { owner, bridge }
  units: new Map(),         // unit id -> { id, owner, kind, tile, lives, moved, acted }
  nextUnit: 1,
  ports: new Map(),         // tile id -> player index
  notice: "",               // transient feedback for the status line
  varietyReq: RULES.MIN_VARIETY,
  events: [],               // newest-first log, rendered by the panel
};

export const emit = html => { game.events.unshift(html); game.events.length = Math.min(game.events.length, 80); };

/* ---------- geography helpers ---------- */
export const around = t => neighbours(game.board, t);
export const tileById = id => game.board.tiles[id];
export const townsOf = pi => [...game.towns].filter(([, o]) => o === pi).map(([id]) => tileById(id));
export const footprint = pi => townsOf(pi).flatMap(t => [t, ...around(t)]);

/* Production is independent of the map: a player gains 1 of the rolled resource per town
   they hold, whatever terrain that town stands on. Terrain still governs where a town may
   be founded (see legalTown) — it just no longer decides who gets paid. */
export const yieldOf = (pi, _res) => townsOf(pi).length;

/* ---------- placement rules ---------- */
export function legalTown(t) {
  if (isBlocked(t) || isWater(t)) return false;
  if (game.towns.has(t.id)) return false;
  for (const id of game.towns.keys()) if (hexDist(t, tileById(id)) < RULES.MIN_TOWN_GAP) return false;
  const foot = [t, ...around(t)];
  if (foot.length < RULES.MIN_FOOTPRINT) return false;
  const kinds = new Set(foot.map(x => x.terrain).filter(x => DIE_FACES.includes(x)));
  return kinds.size >= game.varietyReq;
}

export function whyIllegal(t) {
  if (isWater(t)) return "No towns on water";
  if (isBlocked(t)) return "No towns at sea";
  if (game.towns.has(t.id)) return "Already settled";
  for (const id of game.towns.keys()) if (hexDist(t, tileById(id)) < RULES.MIN_TOWN_GAP) return "Too close to another town";
  if ([t, ...around(t)].length < RULES.MIN_FOOTPRINT) return "Too little land around that tile";
  return `Needs ${game.varietyReq} different resources nearby`;
}

export const legalCount = () => game.board.tiles.filter(legalTown).length;

/* Placement must never dead-end: relax the variety rule rather than stall. */
export function ensureSites() {
  while (legalCount() === 0 && game.varietyReq > 1) {
    game.varietyReq--;
    emit(`No sites left — variety requirement relaxed to ${game.varietyReq}`);
  }
}

/* ---------- roads, bridges, and the network ---------- */

/* Vertex-pair -> edge id, rebuilt whenever the board changes. */
let EDGE_AT = new Map();
function indexEdges() {
  EDGE_AT = new Map();
  if (game.board) for (const e of game.board.edges) EDGE_AT.set(`${e.a}-${e.b}`, e.id);
}
export const edgeBetween = (u, v) => EDGE_AT.get(u < v ? `${u}-${v}` : `${v}-${u}`);
export const edgeById = id => game.board.edges[id];
export const edgeCost = e => e.water ? COSTS.bridge : COSTS.road;

export const canAfford = (pi, cost) => Object.entries(cost).every(([k, n]) => game.hands[pi][k] >= n);
const pay = (pi, cost) => { for (const [k, n] of Object.entries(cost)) game.hands[pi][k] -= n; };

/* The 6 edges of a tile's own hexagon — the perimeter a town blocks. */
export const tileEdges = t => {
  const c = game.board.corners[t.id], out = [];
  for (let i = 0; i < 6; i++) {
    const id = edgeBetween(c[i], c[(i + 1) % 6]);
    if (id !== undefined) out.push(id);
  }
  return out;
};

/* Where a player may build from: the corners of their towns plus the ends of everything
   they have already built. Since every new edge must touch this set, the network stays
   connected by construction and never needs a traversal. */
export function networkVerts(pi) {
  const v = new Set();
  for (const t of townsOf(pi)) for (const c of game.board.corners[t.id]) v.add(c);
  for (const [id, r] of game.roads) if (r.owner === pi) { const e = edgeById(id); v.add(e.a); v.add(e.b); }
  return v;
}

export const canBuild = () => game.phase === "play" && game.rolled && !game.awaiting;

export function legalEdge(pi, id, net = networkVerts(pi)) {
  const e = edgeById(id);
  if (!e || game.roads.has(id)) return false;
  for (const tid of e.tiles) if (game.towns.has(tid)) return false;   // a town blocks its perimeter
  if (!net.has(e.a) && !net.has(e.b)) return false;
  return canAfford(pi, edgeCost(e));
}

export function whyEdgeIllegal(pi, id, net = networkVerts(pi)) {
  const e = edgeById(id);
  if (!e) return "Not a buildable edge";
  if (game.roads.has(id)) return "Something is built there already";
  if (e.tiles.some(tid => game.towns.has(tid))) return "A town blocks that edge";
  if (!net.has(e.a) && !net.has(e.b)) return "Must connect to your network";
  return `Needs ${costLabel(edgeCost(e))}`;
}

export const costLabel = cost => Object.entries(cost).map(([k, n]) => `${n} ${k}`).join(" + ");

export function buildEdge(id) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (!legalEdge(pi, id)) { game.notice = whyEdgeIllegal(pi, id); return false; }
  const e = edgeById(id);
  pay(pi, edgeCost(e));
  game.roads.set(id, { owner: pi, bridge: e.water });
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> builds a ${e.water ? "bridge" : "road"}`);
  return true;
}

/* Founding a town after setup: everything legalTown asks, plus the network must already
   touch one of the tile's corners, plus the cost. */
export function legalExpansion(pi, t, net = networkVerts(pi)) {
  if (!legalTown(t)) return false;
  if (!game.board.corners[t.id].some(c => net.has(c))) return false;
  return canAfford(pi, COSTS.town);
}

export function whyExpansionIllegal(pi, t, net = networkVerts(pi)) {
  if (!legalTown(t)) return whyIllegal(t);
  if (!game.board.corners[t.id].some(c => net.has(c))) return "Your network does not reach that tile";
  return `Needs ${costLabel(COSTS.town)}`;
}

export function buildTown(t) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (!legalExpansion(pi, t)) { game.notice = whyExpansionIllegal(pi, t); return false; }
  pay(pi, COSTS.town);
  game.towns.set(t.id, pi);
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> founds a town on ${TERRAIN[t.terrain].label} at ${t.col},${t.row}`);
  return true;
}

/* ---------- ports ---------- */

/* A port sits on the water — a sea or fish tile touching land — within reach of your
   network. It is not a town: it produces nothing, does not block the edges around it,
   and does not extend your network. Boats muster on the port tile itself and must come
   back to it to repair, exactly as land units muster on a town. */
export const isHarbour = t => isWater(t) && around(t).some(settleable);
export const portsOf = pi => [...game.ports].filter(([, o]) => o === pi).map(([id]) => tileById(id));

export function legalPort(pi, t, net = networkVerts(pi)) {
  if (!t || !isHarbour(t)) return false;
  if (game.ports.has(t.id) || unitAt(t.id)) return false;
  if (!game.board.corners[t.id].some(c => net.has(c))) return false;
  return canAfford(pi, COSTS.port);
}

export function whyPortIllegal(pi, t, net = networkVerts(pi)) {
  if (!t || !isWater(t)) return "Ports go on water";
  if (!isHarbour(t)) return "A port must touch land";
  if (game.ports.has(t.id)) return "Already a port";
  if (unitAt(t.id)) return "A unit is in the way";
  if (!game.board.corners[t.id].some(c => net.has(c))) return "Your network does not reach that tile";
  return `Needs ${costLabel(COSTS.port)}`;
}

export function buildPort(t) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (!legalPort(pi, t)) { game.notice = whyPortIllegal(pi, t); return false; }
  pay(pi, COSTS.port);
  game.ports.set(t.id, pi);
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> opens a port at ${t.col},${t.row}`);
  return true;
}

/* ---------- units ---------- */

export const unitSpec = u => UNITS[u.kind];
export const unitsOf  = pi => [...game.units.values()].filter(u => u.owner === pi);
export const injured  = u => u.lives < unitSpec(u).lives;
export const unitAt   = tid => {
  for (const u of game.units.values()) if (u.tile === tid) return u;
  return null;
};

/* A unit needs the fixed cost, plus one resource from its `either` list if it has one. */
export function canAffordUnit(pi, kind) {
  const spec = UNITS[kind];
  if (!canAfford(pi, spec.cost)) return false;
  if (!spec.either) return true;
  return spec.either.some(r => game.hands[pi][r] >= 1 + (spec.cost[r] || 0));
}

/* Spend the fixed cost, then the either-resource the player holds most of. */
function payUnit(pi, kind) {
  const spec = UNITS[kind];
  pay(pi, spec.cost);
  if (!spec.either) return null;
  const pick = spec.either.slice().sort((a, b) => game.hands[pi][b] - game.hands[pi][a])[0];
  game.hands[pi][pick] -= 1;
  return pick;
}

export const unitCostLabel = kind => costLabel(UNITS[kind].cost) +
  (UNITS[kind].either ? ` + 1 ${UNITS[kind].either.join(" or ")}` : "");

/* Land units muster on one of your towns, boats on one of your ports. Both structures
   sit in the unit's own domain, so this is the same rule twice. */
export function legalLaunch(pi, kind, t) {
  if (!t || unitAt(t.id)) return false;
  const home = UNITS[kind].home === "port" ? game.ports : game.towns;
  return home.get(t.id) === pi;
}

export function legalRecruit(pi, kind, t) {
  if (!legalLaunch(pi, kind, t)) return false;
  return canAffordUnit(pi, kind);
}

export function recruit(kind, t) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (!legalRecruit(pi, kind, t)) {
    const sitting = t && unitAt(t.id);
    game.notice = sitting && sitting.owner !== pi && game.ports.get(t.id) === pi
                  ? "That port is blockaded"
                : sitting ? "That tile already holds a unit"
                : !legalLaunch(pi, kind, t)
                  ? (UNITS[kind].home === "port" ? "Launch from one of your ports"
                                                 : "Recruit on one of your towns")
                : `Needs ${unitCostLabel(kind)}`;
    return false;
  }
  const paid = payUnit(pi, kind), spec = UNITS[kind], id = game.nextUnit++;
  /* A fresh unit is spent for the turn — it acts from its owner's next turn on. */
  game.units.set(id, { id, owner: pi, kind, tile: t.id, lives: spec.lives, moved: spec.move, acted: true });
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> ${spec.home === "port" ? "launches" : "recruits"} a ${spec.label.toLowerCase()}${paid ? ` (${paid})` : ""}`);
  return id;
}

/* One action per unit per turn. A foot soldier moves OR acts; a horseman and a boat may
   spend one of their two steps and still attack, but not both steps. Injured land units
   are rooted; boats are not, or they could never sail home to a port. */
export const canMove = u => !u.acted && u.moved < unitSpec(u).move
  && (!injured(u) || !!unitSpec(u).movesInjured);
export const canAttack = u => !u.acted && u.moved <= unitSpec(u).move - 1;

export const atPort = u => game.ports.get(u.tile) === u.owner;

export const canRevive = u => {
  if (u.acted || u.moved !== 0 || !injured(u)) return false;
  return unitSpec(u).reviveAtPort ? atPort(u) : true;
};

/* Where a unit may stand: its own domain, and empty. Towns are closed to enemies, but
   ports deliberately are not — an enemy boat that parks in your harbour blockades it,
   because a port needs an empty tile to launch from and to repair in. */
export function canStand(u, t) {
  if (unitSpec(u).domain === "water" ? !isWater(t) : !settleable(t)) return false;
  if (unitAt(t.id)) return false;
  const town = game.towns.get(t.id);
  return town === undefined || town === u.owner;
}

/* Does this player have anywhere to muster this kind right now? A port under blockade
   does not count, nor does a town that already holds a unit. */
export function hasBerth(pi, kind) {
  const home = UNITS[kind].home === "port" ? game.ports : game.towns;
  for (const [id, owner] of home) if (owner === pi && !unitAt(id)) return true;
  return false;
}

/* Who is sitting in this player's port, if anybody hostile. */
export const blockaders = pi => portsOf(pi)
  .map(t => unitAt(t.id)).filter(u => u && u.owner !== pi);

export function reachable(u) {
  const out = new Map();                          // tile id -> steps spent
  if (!canMove(u)) return out;
  let frontier = [tileById(u.tile)];
  for (let step = 1; step <= unitSpec(u).move - u.moved; step++) {
    const next = [];
    for (const t of frontier) for (const n of around(t)) {
      if (n.id === u.tile || out.has(n.id) || !canStand(u, n)) continue;
      out.set(n.id, step); next.push(n);
    }
    frontier = next;
  }
  return out;
}

export const inRange = (u, t) => {
  const [lo, hi] = unitSpec(u).range, d = hexDist(tileById(u.tile), t);
  return d >= lo && d <= hi;
};

/* Everything this unit could strike. A boat's [2, 2] means adjacent enemies are safe
   from it — and free to hit back, which is the counter to outranging everything. */
export const targetsOf = u => [...game.units.values()]
  .filter(e => e.owner !== u.owner && inRange(u, tileById(e.tile)));

const mine = id => {
  const u = game.units.get(id);
  return u && u.owner === game.current && canBuild() ? u : null;
};

export function moveUnit(id, tid) {
  const u = mine(id);
  if (!u) return false;
  const steps = reachable(u).get(tid);
  if (steps === undefined) { game.notice = "That unit cannot reach there"; return false; }
  u.tile = tid; u.moved += steps; game.notice = "";
  return true;
}

export function attackUnit(id, tid) {
  const u = mine(id);
  if (!u || !canAttack(u)) return false;
  const target = unitAt(tid);
  if (!target || target.owner === u.owner) { game.notice = "Nothing to attack there"; return false; }
  if (!inRange(u, tileById(tid))) {
    const [lo, hi] = unitSpec(u).range;
    game.notice = lo === hi ? `That unit strikes at exactly ${lo} tiles` : "Target is out of range";
    return false;
  }

  target.lives -= 1;
  u.acted = true;                                 // attacking ends the unit's turn
  game.notice = "";
  const who = `<b style="color:${PLAYERS[u.owner].color}">${PLAYERS[u.owner].name}</b>`;
  const vic = `<b style="color:${PLAYERS[target.owner].color}">${PLAYERS[target.owner].name}</b>`;
  if (target.lives <= 0) { game.units.delete(target.id); emit(`${who} kills ${vic}'s ${unitSpec(target).label.toLowerCase()}`); }
  else emit(`${who} wounds ${vic}'s ${unitSpec(target).label.toLowerCase()}`);
  return true;
}

export function reviveUnit(id) {
  const u = mine(id);
  if (!u || !canRevive(u)) return false;
  u.lives = unitSpec(u).lives; u.acted = true; game.notice = "";
  emit(`<b style="color:${PLAYERS[u.owner].color}">${PLAYERS[u.owner].name}</b>'s ${unitSpec(u).label.toLowerCase()} recovers`);
  return true;
}

const refreshUnits = pi => { for (const u of unitsOf(pi)) { u.moved = 0; u.acted = false; } };

/* ---------- lifecycle ---------- */
function clearRound() {
  game.towns = new Map(); game.turn = 0; game.turnNo = 0; game.current = 0;
  game.roller = null; game.awaiting = false; game.dice = [null, null];
  game.keptIndex = null; game.doubles = false; game.award = null;
  game.rolled = false; game.roads = new Map();
  game.units = new Map(); game.nextUnit = 1; game.ports = new Map();
  game.notice = ""; game.varietyReq = RULES.MIN_VARIETY;
  game.hands = PLAYERS.map(blankHand);
}

export function setBoard(board) { game.board = board; game.phase = "idle"; indexEdges(); clearRound(); }
export function setPlayers(n)   { game.playerCount = n; game.phase = "idle"; clearRound(); }

export function startGame() {
  clearRound();
  game.phase = "placing";
  ensureSites();
  const sites = legalCount();
  emit(`— new game, ${game.playerCount} players · ${sites} legal sites —`);
  if (sites < game.playerCount) emit(`<span class="bad">Board is too tight for ${game.playerCount} — reroll or size up</span>`);
}

export function resetGame() { clearRound(); game.phase = "idle"; emit("— reset —"); }

/* ---------- actions ---------- */
export function placeTown(t) {
  if (game.phase !== "placing") return false;
  if (!legalTown(t)) { game.notice = whyIllegal(t); return false; }
  game.notice = "";
  game.towns.set(t.id, game.turn);
  emit(`<b style="color:${PLAYERS[game.turn].color}">${PLAYERS[game.turn].name}</b> settles ${TERRAIN[t.terrain].label} at ${t.col},${t.row}`);
  game.turn++;
  if (game.turn >= game.playerCount) {
    game.phase = "play"; game.current = 0; game.turnNo = 1;
    emit(`All towns placed — turn 1, ${PLAYERS[0].name} to roll`);
  } else ensureSites();
  return true;
}

export function rollDice(rand = Math.random) {
  if (game.phase !== "play" || game.awaiting || game.rolled) return false;
  game.rolled = true;
  game.dice = [DIE_FACES[Math.floor(rand() * 6)], DIE_FACES[Math.floor(rand() * 6)]];
  game.keptIndex = null; game.awaiting = true; game.roller = game.current;
  game.notice = ""; game.award = null;
  const [a, b] = game.dice;
  game.doubles = a === b;
  emit(`<b>Turn ${game.turnNo}</b> · ${PLAYERS[game.current].name} rolled ${TERRAIN[a].label} + ${TERRAIN[b].label}`);
  /* Doubles are not a special rule — there is simply nothing to choose between two
     identical faces, so everybody produces that resource and the turn resolves itself.
     The panel must say so rather than mark die 0 as a deliberate keep. */
  if (game.doubles) { emit(`Doubles — no choice, everyone produces ${TERRAIN[a].label}`); resolveRoll(0); }
  return true;
}

/* The roller keeps one die; the other resource goes to everyone else. */
export function resolveRoll(keepIdx) {
  if (!game.awaiting) return false;
  if (game.roller === null) game.roller = game.current;
  const who = game.roller;                      // the roller keeps, not whoever is current
  const mine = game.dice[keepIdx], theirs = game.dice[1 - keepIdx];
  game.keptIndex = keepIdx;

  const parts = [];
  let kept = 0, given = 0;
  for (let i = 0; i < game.playerCount; i++) {
    const res = i === who ? mine : theirs;
    const n = yieldOf(i, res);
    game.hands[i][res] += n;
    if (i === who) kept += n; else given += n;
    if (n) parts.push(`<b style="color:${PLAYERS[i].color}">${PLAYERS[i].name}</b> +${n} ${TERRAIN[res].label}`);
  }
  game.award = { roller: who, mine, theirs, kept, given, doubles: game.doubles };
  emit(parts.length ? "→ " + parts.join(", ") : "→ nobody produces");

  /* The turn does NOT pass here any more — the roller now gets a build window and
     ends the turn explicitly. */
  game.awaiting = false;
  return true;
}

export function endTurn() {
  if (game.phase !== "play" || game.awaiting || !game.rolled) return false;
  game.rolled = false;
  game.turnNo++;
  game.current = (game.current + 1) % game.playerCount;
  game.notice = "";
  refreshUnits(game.current);      // the incoming player's units are ready again
  return true;
}

export { settleable };
