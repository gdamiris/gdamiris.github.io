/* All game state and rules. No DOM access lives here, which is what lets the
   whole rule set be driven headlessly from tests (and later from netcode). */

import { PLAYERS, DIE_FACES, RESOURCES, WILD, RULES, COSTS, UNITS, WALL,
         TERRAIN_MOVE, STEP } from "./config.js";
import { TERRAIN, faceSpec, settleable, isWater, isBlocked } from "./terrain.js";
import { hexDist, neighbours } from "./hex.js";

/* Hands hold real resources only — a wild is chosen, never stored. */
export const blankHand = () => Object.fromEntries(RESOURCES.map(f => [f, 0]));

export const game = {
  board: null,
  phase: "idle",            // idle | placing | play
  playerCount: 3,
  towns: new Map(),         // tile id -> player index
  turn: 0,                  // who is placing right now, during setup
  placed: 0,                // towns founded so far during setup
  hands: PLAYERS.map(blankHand),
  turnNo: 0,
  current: 0,               // whose turn it is
  roller: null,             // who rolled the dice currently on screen
  awaiting: false,          // a die still needs choosing
  dice: [null, null],
  keptIndex: null,
  doubles: false,           // both faces matched, so there was no die choice to make
  pick: { mine: null, theirs: null },  // the faces in play, wilds resolved to resources
  needWild: null,           // "mine" | "theirs" — which wild the roller still has to name
  award: null,              // what the last roll actually paid, for the panel to show
  rolled: false,            // the current player has rolled, so building is open to them
  roads: new Map(),         // edge id -> { owner, bridge }
  units: new Map(),         // unit id -> { id, owner, kind, tile, lives, moved, acted }
  nextUnit: 1,
  ports: new Map(),         // tile id -> player index
  walls: new Map(),         // tile id -> { owner, lives, repaired }
  townHurt: new Map(),      // tile id -> damage taken by the town itself
  busy: new Set(),          // towns that have spent their turn — repairing OR mustering
  kings: new Map(),         // player index -> tile id of the town they sit in
  crown: null,              // { player, from } — a king owed, after an assassination
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

/* Production is flat: every player gains 1 of the rolled resource, however many towns
   they hold. The only way to earn more is to put a merchant on the ground that makes it
   — so income is bought with territory you have to hold, and never compounds on its own.

   A port works its own water the same way: one built on a fish tile lands an extra fish
   whenever fish comes up. Sea tiles produce nothing, so a deep-water port earns nothing. */
export const merchantsOf = pi => unitsOf(pi).filter(u => unitSpec(u).trades);

export const yieldOf = (pi, res) => 1
  + merchantsOf(pi).filter(u => tileById(u.tile).terrain === res).length
  + portsOf(pi).filter(t => t.terrain === res).length;

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

/* Setup is a snake draft: everyone founds one town a round, and the round order reverses
   each time, so whoever picked last in a round picks first in the next. That keeps the
   first player's advantage from compounding across both of their towns. */
export const townsToPlace = () => RULES.TOWNS_AT_START * game.playerCount;

export function placingPlayer(placed = game.placed, pc = game.playerCount) {
  const round = Math.floor(placed / pc), i = placed % pc;
  return round % 2 === 0 ? i : pc - 1 - i;
}

/* Placement must never dead-end: relax the variety rule rather than stall. */
export function ensureSites() {
  while (legalCount() === 0 && game.varietyReq > 1) {
    game.varietyReq--;
    emit(`No sites left — variety requirement relaxed to ${game.varietyReq}`);
  }
}

/* ---------- town life ---------- */

/* How many of this player's OTHER towns share a road component with this one. Walking
   the built edges rather than networkVerts is the point: owning many towns counts for
   nothing, joining them up is what counts. */
export function linkedTowns(pi, t) {
  const adj = new Map();
  for (const [id, r] of game.roads) {
    if (r.owner !== pi) continue;
    const e = edgeById(id);
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b); adj.get(e.b).push(e.a);
  }
  const corners = game.board.corners;
  const seen = new Set(corners[t.id]), q = [...corners[t.id]];
  while (q.length) for (const n of adj.get(q.pop()) || [])
    if (!seen.has(n)) { seen.add(n); q.push(n); }
  return townsOf(pi).filter(o => o.id !== t.id && corners[o.id].some(c => seen.has(c))).length;
}

/* A town's own life: its base, plus what its roads are worth, capped. */
export const townMaxLife = t => {
  const pi = game.towns.get(t.id);
  if (pi === undefined) return 0;
  return RULES.TOWN_LIFE + Math.min(linkedTowns(pi, t), RULES.TOWN_LINK_CAP);
};
const hurtOf = tid => game.townHurt.get(tid) || 0;
export const townLife = t => Math.max(0, townMaxLife(t) - hurtOf(t.id));

/* Repairs need hands. Only a foot soldier or a horseman standing in the town can do the
   work — a cannon is a siege engine and a civilian is no use on the walls. And a town
   gets ONE repair a turn, wall OR masonry, never both: two stacking repairs made a
   defended town impossible for a lone attacker to make any progress against at all. */
export const workCrew = (pi, t) => {
  const u = unitAt(t.id);
  return u && u.owner === pi && !!unitSpec(u).mends ? u : null;
};
/* A town does one job a turn: it either repairs or it musters, never both. */
export const townBusy = t => game.busy.has(t.id);
export const mendedThisTurn = townBusy;

/* Anything standing in the town that will actually fight adds its remaining lives to
   what an attacker has to chew through. Civilians man no walls and add nothing. */
export const garrisonOf = t => {
  const u = unitAt(t.id);
  return u && game.towns.get(t.id) === u.owner && !!unitSpec(u).range ? u : null;
};
export const townDefence = t => townLife(t) + (garrisonOf(t) ? garrisonOf(t).lives : 0);

export function canRepairTown(pi, t) {
  if (!t || game.towns.get(t.id) !== pi) return false;
  if (!hurtOf(t.id) || mendedThisTurn(t) || !workCrew(pi, t)) return false;
  return canAfford(pi, COSTS.townRepair);
}

export function whyNoTownRepair(pi, t) {
  if (!t || !game.towns.has(t.id)) return "No town there";
  if (game.towns.get(t.id) !== pi) return "That is not your town";
  if (!hurtOf(t.id)) return "That town is unharmed";
  if (mendedThisTurn(t)) return "Something there has already been repaired this turn";
  if (!workCrew(pi, t)) return "Needs a foot soldier or horseman in the town";
  return `Needs ${costLabel(COSTS.townRepair)}`;
}

export function repairTown(t) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (!canRepairTown(pi, t)) { game.notice = whyNoTownRepair(pi, t); return false; }
  pay(pi, COSTS.townRepair);
  game.townHurt.set(t.id, hurtOf(t.id) - 1);
  game.busy.add(t.id);
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> rebuilds a town (${townLife(t)}/${townMaxLife(t)})`);
  return true;
}

/* A town beaten down to nothing is CONQUERED, not destroyed. It stays on the map and
   stays its owner's: it still links roads, still counts against the merchant cap, still
   blocks new towns nearby, and can still shelter a king. What it loses is the two things
   that make a town worth holding — it can muster nobody, and it stops helping its owner
   trade. And its gates stand open, so an enemy may walk in and hold it. */
export const townFallen = t => game.towns.has(t.id) && townLife(t) <= 0;

/* Who a town's trade counts for: its owner while it stands, the occupier once it has
   fallen and somebody else is standing in it, and nobody while it lies empty. */
export function tradeHolder(t) {
  const owner = game.towns.get(t.id);
  if (owner === undefined) return null;
  if (!townFallen(t)) return owner;
  const u = unitAt(t.id);
  return u && u.owner !== owner ? u.owner : null;
}

/* A player's towns may be worked on again when their turn comes round. */
const refreshTowns = pi => {
  for (const id of [...game.busy]) if (game.towns.get(id) === pi) game.busy.delete(id);
};

/* ---------- trade ---------- */

/* Anyone may swap resources at TRADE_BASE to 1, and holding the right ground makes the
   swap cheaper: every town of yours standing ON that resource takes 1 off, and 1 more if
   that town is joined by your roads to another of your towns. A conquered town helps
   whoever is standing in it, not the player whose name is on it — so taking a town is a
   raid on its owner's economy as much as on their army. Never cheaper than TRADE_FLOOR. */
export function tradeTowns(pi, res) {
  return [...game.towns.keys()].map(tileById)
    .filter(t => t.terrain === res && tradeHolder(t) === pi);
}

export function tradeRatio(pi, res) {
  let off = 0;
  for (const t of tradeTowns(pi, res)) {
    off += 1;                                       // the town itself
    if (linkedTowns(game.towns.get(t.id), t) > 0) off += 1;   // and its roads
  }
  return Math.max(RULES.TRADE_FLOOR, RULES.TRADE_BASE - off);
}

export const canTrade = (pi, give, get) =>
  give !== get && RESOURCES.includes(give) && RESOURCES.includes(get)
  && game.hands[pi][give] >= tradeRatio(pi, give);

export function trade(give, get) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (give === get) { game.notice = "Trade needs two different resources"; return false; }
  const rate = tradeRatio(pi, give);
  if (!canTrade(pi, give, get)) {
    game.notice = `Needs ${rate} ${give} to get 1 ${get}`;
    return false;
  }
  game.hands[pi][give] -= rate;
  game.hands[pi][get] += 1;
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b>` +
       ` trades ${rate} ${TERRAIN[give].label} for 1 ${TERRAIN[get].label}`);
  return true;
}

/* ---------- kings ---------- */

export const kingOf = pi => game.kings.has(pi) ? tileById(game.kings.get(pi)) : null;
export const kingAt = tid => { for (const [pi, id] of game.kings) if (id === tid) return pi; return null; };

/* SEAM FOR MULTIPLAYER. A king is meant to be known only to its own player. Every
   client will eventually be sent only what it may see, and this is the one place that
   decides it — flip the body to `viewer === owner` (and stop sending other players'
   kings over the wire at all) once each player has their own screen. Until then the
   whole table can see every king, which is what makes the rules testable hot-seat. */
export const kingVisibleTo = (_viewer, _owner) => true;

export const legalKingSeat = (pi, t) => {
  if (!t || game.towns.get(t.id) !== pi) return false;
  /* a re-seated king must move house, not sit back down where it was killed */
  if (game.crown && game.crown.player === pi && game.crown.from === t.id) return false;
  return game.kings.get(pi) !== t.id;
};

export function whyNoSeat(pi, t) {
  if (!t || !game.towns.has(t.id)) return "A king sits in a town";
  if (game.towns.get(t.id) !== pi) return "That is not your town";
  if (game.crown && game.crown.player === pi && game.crown.from === t.id)
    return "Choose a different town from the one that was taken";
  return "Already seated there";
}

/* Used both for the opening round and for re-seating after an assassination. */
export function seatKing(t) {
  const pi = game.phase === "crowning" ? game.turn
           : game.crown ? game.crown.player : null;
  if (pi === null) return false;
  if (!legalKingSeat(pi, t)) { game.notice = whyNoSeat(pi, t); return false; }
  game.kings.set(pi, t.id);
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> seats a king`);

  if (game.phase === "crowning") {
    game.turn++;
    if (game.turn >= game.playerCount) {
      game.phase = "play"; game.current = 0; game.turnNo = 1;
      emit(`Every king is seated — turn 1, ${PLAYERS[0].name} to roll`);
    }
  } else game.crown = null;
  return true;
}

/* A player who owes a king must seat it before doing anything else on their turn. */
export const owesKing = pi => !!game.crown && game.crown.player === pi;

/* ---------- roads, bridges, and the network ---------- */

/* Vertex-pair -> edge id, rebuilt whenever the board changes. */
let EDGE_AT = new Map();
function indexEdges() {
  EDGE_AT = new Map();
  if (game.board) for (const e of game.board.edges) EDGE_AT.set(`${e.a}-${e.b}`, e.id);
}
export const edgeBetween = (u, v) => EDGE_AT.get(u < v ? `${u}-${v}` : `${v}-${u}`);
export const edgeById = id => game.board.edges[id];

/* What may be built on an edge, decided by how much land it touches. A coastal edge —
   land on one side, water on the other — takes either: a road runs along the shore, a
   bridge reaches out over the water. Bridge comes first, so it stays the default. */
export const edgeKinds = e => {
  const land = e.tiles.filter(id => !isWater(tileById(id))).length;
  return land === 2 ? ["road"] : land === 0 ? ["bridge"] : ["bridge", "road"];
};
export const isCoastalEdge = e => edgeKinds(e).length > 1;
export const edgeCost = (e, kind = edgeKinds(e)[0]) =>
  kind === "bridge" ? COSTS.bridge : COSTS.road;

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

export const canBuild = () =>
  game.phase === "play" && game.rolled && !game.awaiting && !game.needWild;

export function legalEdge(pi, id, net = networkVerts(pi), kind = null) {
  const e = edgeById(id);
  if (!e || game.roads.has(id)) return false;
  for (const tid of e.tiles) if (game.towns.has(tid)) return false;   // a town blocks its perimeter
  if (!net.has(e.a) && !net.has(e.b)) return false;
  const kinds = edgeKinds(e);
  if (kind && !kinds.includes(kind)) return false;
  return (kind ? [kind] : kinds).some(k => canAfford(pi, edgeCost(e, k)));
}

export function whyEdgeIllegal(pi, id, net = networkVerts(pi), kind = null) {
  const e = edgeById(id);
  if (!e) return "Not a buildable edge";
  const kinds = edgeKinds(e);
  /* the terrain reason comes first: it holds however the network runs */
  if (kind && !kinds.includes(kind)) return wrongKind(kind);
  if (game.roads.has(id)) return "Something is built there already";
  if (e.tiles.some(tid => game.towns.has(tid))) return "A town blocks that edge";
  if (!net.has(e.a) && !net.has(e.b)) return "Must connect to your network";
  return `Needs ${(kind ? [kind] : kinds).map(k => costLabel(edgeCost(e, k))).join(" or ")}`;
}

const wrongKind = kind =>
  kind === "road" ? "A road needs land on both sides" : "A bridge needs water on one side";

export const costLabel = cost => Object.entries(cost).map(([k, n]) => `${n} ${k}`).join(" + ");

export function buildEdge(id, kind = null) {
  if (!canBuild()) return false;
  const pi = game.current, e = edgeById(id);
  if (!e) { game.notice = "Not a buildable edge"; return false; }
  const kinds = edgeKinds(e);
  if (kind && !kinds.includes(kind)) { game.notice = wrongKind(kind); return false; }
  /* with no kind asked for, take the first the player can actually pay for */
  const pick = kind || kinds.find(k => canAfford(pi, edgeCost(e, k))) || kinds[0];
  if (!legalEdge(pi, id, undefined, pick)) {
    game.notice = whyEdgeIllegal(pi, id, undefined, kind); return false;
  }
  pay(pi, edgeCost(e, pick));
  game.roads.set(id, { owner: pi, bridge: pick === "bridge" });
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> builds a ${pick}`);
  return true;
}

/* A water tile with a bridge on any of its edges can be walked on: that is what lets a
   land unit cross a one-tile strait. Ownership is irrelevant — masonry is masonry, and
   your bridge carries your enemy just as well as it carries you. */
export const bridged = tid => tileEdges(tileById(tid))
  .some(eid => { const r = game.roads.get(eid); return !!r && r.bridge; });

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

/* ---------- walls ---------- */

export const wallAt = tid => game.walls.get(tid) || null;
export const wallsOf = pi => [...game.walls].filter(([, w]) => w.owner === pi).map(([id]) => tileById(id));

/* A tile whose wall still stands. Nothing behind it can be struck at all. */
export const sheltered = tid => { const w = game.walls.get(tid); return !!w && w.lives > 0; };
export const isSiege = u => WALL.breachedBy.includes(u.kind);

export function legalWall(pi, t) {
  if (!t || game.towns.get(t.id) !== pi) return false;   // walls ring a town you hold
  if (game.walls.has(t.id)) return false;
  return canAfford(pi, COSTS.wall);
}

export function whyWallIllegal(pi, t) {
  if (!t || !game.towns.has(t.id)) return "Walls go around a town";
  if (game.towns.get(t.id) !== pi) return "That is not your town";
  if (game.walls.has(t.id)) return "Already walled";
  return `Needs ${costLabel(COSTS.wall)}`;
}

export function buildWall(t) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (!legalWall(pi, t)) { game.notice = whyWallIllegal(pi, t); return false; }
  pay(pi, COSTS.wall);
  game.walls.set(t.id, { owner: pi, lives: WALL.lives, repaired: false });
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> walls the town at ${t.col},${t.row}`);
  return true;
}

export function canRepairWall(pi, t) {
  const w = t && game.walls.get(t.id);
  if (!w || w.owner !== pi || w.lives >= WALL.lives) return false;
  if (mendedThisTurn(t) || !workCrew(pi, t)) return false;
  return canAfford(pi, WALL.repair);
}

export function whyNoWallRepair(pi, t) {
  const w = t && game.walls.get(t.id);
  if (!w) return "No wall there";
  if (w.owner !== pi) return "That is not your wall";
  if (w.lives >= WALL.lives) return "That wall is intact";
  if (mendedThisTurn(t)) return "Something there has already been repaired this turn";
  if (!workCrew(pi, t)) return "Needs a foot soldier or horseman in the town";
  return `Needs ${costLabel(WALL.repair)}`;
}

export function repairWall(t) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (!canRepairWall(pi, t)) { game.notice = whyNoWallRepair(pi, t); return false; }
  const w = game.walls.get(t.id);
  pay(pi, WALL.repair);
  w.lives++; game.busy.add(t.id);              // the town has spent its turn
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> repairs a wall (${w.lives}/${WALL.lives})`);
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
  if (home.get(t.id) !== pi) return false;
  if (UNITS[kind].home === "town" && (townFallen(t) || townBusy(t))) return false;
  return true;
}

/* Some kinds are rationed by how many towns you hold — a merchant per town. */
export const capOf = (pi, kind) => {
  const per = UNITS[kind].perTown;
  return per ? per * townsOf(pi).length : Infinity;
};
export const countOf = (pi, kind) => unitsOf(pi).filter(u => u.kind === kind).length;
export const withinCap = (pi, kind) => countOf(pi, kind) < capOf(pi, kind);

export function legalRecruit(pi, kind, t) {
  if (!legalLaunch(pi, kind, t)) return false;
  if (!withinCap(pi, kind)) return false;
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
                : !withinCap(pi, kind)
                  ? `Only ${UNITS[kind].perTown} ${UNITS[kind].label.toLowerCase()} per town`
                : t && townBusy(t) ? "That town has already worked this turn"
                : t && townFallen(t) ? "A conquered town musters nobody"
                : !legalLaunch(pi, kind, t)
                  ? (UNITS[kind].home === "port" ? "Launch from one of your ports"
                                                 : "Recruit on one of your towns")
                : `Needs ${unitCostLabel(kind)}`;
    return false;
  }
  if (UNITS[kind].home === "town") game.busy.add(t.id);   // a town musters OR repairs
  const paid = payUnit(pi, kind), spec = UNITS[kind], id = game.nextUnit++;
  /* A fresh unit can march away at once but cannot strike until its owner's next turn. */
  game.units.set(id, { id, owner: pi, kind, tile: t.id, lives: spec.lives,
                       moved: 0, acted: false, fresh: true });
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> ${spec.home === "port" ? "launches" : "recruits"} a ${spec.label.toLowerCase()}${paid ? ` (${paid})` : ""}`);
  return id;
}

/* One action per unit per turn. A foot soldier moves OR acts; a horseman and a boat may
   spend one of their two steps and still attack, but not both steps.

   Anything that can move at all can always move: a wounded unit may retreat, and a unit
   recruited this turn may march off the tile it was born on. Rooting either of them let
   a single cannon parked outside retaliation range lock a town forever — the unit could
   neither leave nor be defended, only bleed a fish a turn staying alive. */
export const canMove = u => !u.acted && u.moved < unitSpec(u).move;
/* Room left for one ordinary tile of movement means the unit still has an attack in it:
   a foot soldier must not have moved at all, a horseman may have spent one tile.
   A civilian has no range at all and can never attack, and neither does a unit recruited
   this turn — it may march, but the ambush has to wait for its owner's next turn.

   The allowance is one ordinary tile either way: a unit must have spent no more than STEP
   getting there, and still hold STEP in reserve. For a foot soldier (budget STEP) both
   halves collapse to "must not have moved". For a horseman the first half is what bites —
   without it, its larger budget let it cross two tiles on discounted plain ground and
   still strike, which is a reach no other unit has. */
export const strikeAllowance = kind => Math.min(UNITS[kind].move - STEP, STEP);

export const canAttack = u => !u.acted && !u.fresh && !!unitSpec(u).range
  && u.moved <= strikeAllowance(u.kind);

export const atPort = u => game.ports.get(u.tile) === u.owner;

/* Patching a unit up costs a fish, unless the unit says otherwise — a boat is planked
   back together with wood rather than fed. */
export const repairCost = u => unitSpec(u).repair || COSTS.revive;

export const canRevive = u => {
  const spec = unitSpec(u);
  if (spec.noRevive || u.acted || u.moved !== 0 || !injured(u)) return false;
  if (!canAfford(u.owner, repairCost(u))) return false;
  return spec.reviveAtPort ? atPort(u) : true;
};

export function whyNoRevive(u) {
  const spec = unitSpec(u);
  if (spec.noRevive) return `Damage to a ${spec.label.toLowerCase()} is permanent`;
  if (!injured(u)) return "Not damaged";
  if (!canAfford(u.owner, repairCost(u))) return `Needs ${costLabel(repairCost(u))}`;
  if (spec.reviveAtPort && !atPort(u)) return "Sail back into one of your ports";
  if (u.moved !== 0 || u.acted) return "Already acted this turn";
  return "";
}

/* "1" for melee, "2" for a single band, "2–3" for a spread. */
export const rangeLabel = kind => {
  const [lo, hi] = UNITS[kind].range;
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
};

/* Where a unit may stand: its own domain, and empty. Towns are closed to enemies, but
   ports deliberately are not — an enemy boat that parks in your harbour blockades it,
   because a port needs an empty tile to launch from and to repair in. */
export function canStand(u, t) {
  const afloat = unitSpec(u).domain === "water";
  /* Land units keep to land, except where a bridge spans the water for them. */
  const ground = afloat ? isWater(t) : (settleable(t) || (isWater(t) && bridged(t.id)));
  if (!ground) return false;
  /* A harbour is a berth, not a checkpoint: only boats may sit in one, so no marching
     column can blockade a port. */
  if (!afloat && game.ports.has(t.id)) return false;
  if (unitAt(t.id)) return false;
  const town = game.towns.get(t.id);
  /* a standing town is closed to enemies; a conquered one has its gates open */
  return town === undefined || town === u.owner || townFallen(t);
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

/* Terrain effects, per unit kind. Everything unlisted is one step and no toll. */
export const stepCost = (kind, terrain) => {
  const rule = TERRAIN_MOVE[terrain];
  const c = rule && rule.cost && rule.cost[kind];
  return c === undefined ? STEP : c;
};
export const stepToll = terrain => (TERRAIN_MOVE[terrain] || {}).toll || null;

const addToll = (a, b) => {
  if (!b) return a;
  const out = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] || 0) + n;
  return out;
};
const tollSize = t => Object.values(t).reduce((a, b) => a + b, 0);

/* Is this tile overlooked by an enemy unit? */
export const watched = (u, t) =>
  around(t).some(x => { const e = unitAt(x.id); return !!e && e.owner !== u.owner; });

/* Cheapest way to every tile this unit could reach, in steps and in tolls paid along
   the way. Plains cost a horseman nothing, so this has to be a weighted search rather
   than a plain ring-by-ring flood: zero-cost ground can carry a rider any distance.
   Among equal-step routes it prefers the one that pays the smaller toll. */
export function movePlan(u) {
  const best = new Map();                         // tile id -> { steps, toll }
  if (!canMove(u)) return best;
  const budget = unitSpec(u).move - u.moved;
  const start = tileById(u.tile);
  best.set(start.id, { steps: 0, toll: {} });

  const buckets = Array.from({ length: budget + 1 }, () => []);
  buckets[0].push(start);
  for (let c = 0; c <= budget; c++) {
    while (buckets[c].length) {
      const t = buckets[c].pop();
      const here = best.get(t.id);
      if (here.steps !== c) continue;             // superseded by a cheaper route
      for (const n of around(t)) {
        if (!canStand(u, n)) continue;
        /* A cautious unit that slips within sight of an enemy spends its whole turn
           doing it — which is what limits a spy to one tile near anybody's sentries. */
        const cost = unitSpec(u).cautious && watched(u, n)
          ? unitSpec(u).move : stepCost(u.kind, n.terrain);
        const steps = c + cost;
        if (steps > budget) continue;
        const toll = addToll(here.toll, stepToll(n.terrain));
        if (!canAfford(u.owner, toll)) continue;  // no water, no desert crossing
        const prev = best.get(n.id);
        if (prev && (prev.steps < steps
          || (prev.steps === steps && tollSize(prev.toll) <= tollSize(toll)))) continue;
        best.set(n.id, { steps, toll });
        buckets[steps].push(n);
      }
    }
  }
  best.delete(start.id);
  return best;
}

/* The same thing flattened to tile -> steps, which is all most callers want. */
export const reachable = u =>
  new Map([...movePlan(u)].map(([id, p]) => [id, p.steps]));

export const inRange = (u, t) => {
  const r = unitSpec(u).range;
  if (!r) return false;                           // civilians strike nothing
  const d = hexDist(tileById(u.tile), t);
  return d >= r[0] && d <= r[1];
};

/* Enemy units this unit could strike. A boat's [2, 2] means adjacent enemies are safe
   from it — and free to hit back, which is the counter to outranging everything.
   Anything behind a standing wall is off the table entirely. */
export const targetsOf = u => [...game.units.values()]
  .filter(e => e.owner !== u.owner && !sheltered(e.tile) && inRange(u, tileById(e.tile)));

/* Enemy walls this unit could batter. Siege weapons only. */
export const wallTargetsOf = u => !isSiege(u) ? []
  : [...game.walls].filter(([tid, w]) =>
      w.owner !== u.owner && w.lives > 0 && inRange(u, tileById(tid))).map(([tid]) => tid);

/* Enemy towns this unit could storm: in range, not sheltered behind a standing wall,
   and with no fighting garrison in the way. */
export const townTargetsOf = u => [...game.towns]
  .filter(([tid, owner]) => owner !== u.owner && !sheltered(tid)
    && !garrisonOf(tileById(tid)) && !townFallen(tileById(tid))
    && inRange(u, tileById(tid)))
  .map(([tid]) => tid);

const mine = id => {
  const u = game.units.get(id);
  return u && u.owner === game.current && canBuild() ? u : null;
};

export function moveUnit(id, tid) {
  const u = mine(id);
  if (!u) return false;
  const plan = movePlan(u).get(tid);
  if (!plan) { game.notice = "That unit cannot reach there"; return false; }
  if (!canAfford(u.owner, plan.toll)) {
    game.notice = `Crossing costs ${costLabel(plan.toll)}`; return false;
  }
  pay(u.owner, plan.toll);
  u.tile = tid; u.moved += plan.steps; game.notice = "";
  if (tollSize(plan.toll))
    emit(`<b style="color:${PLAYERS[u.owner].color}">${PLAYERS[u.owner].name}</b>` +
         ` spends ${costLabel(plan.toll)} crossing the desert`);
  return true;
}

export function attackUnit(id, tid) {
  const u = mine(id);
  if (!u || !canAttack(u)) return false;
  if (!inRange(u, tileById(tid))) {
    game.notice = `That unit strikes at ${rangeLabel(u.kind)} tiles`;
    return false;
  }
  const who = `<b style="color:${PLAYERS[u.owner].color}">${PLAYERS[u.owner].name}</b>`;

  /* A standing wall takes every blow aimed at its tile, and only siege weapons land. */
  const wall = game.walls.get(tid);
  if (wall && wall.lives > 0 && wall.owner !== u.owner) {
    if (!isSiege(u)) {
      game.notice = `A ${unitSpec(u).label.toLowerCase()} cannot breach a wall`;
      return false;
    }
    wall.lives--; u.acted = true; game.notice = "";
    const whose = `<b style="color:${PLAYERS[wall.owner].color}">${PLAYERS[wall.owner].name}</b>`;
    if (wall.lives <= 0) { game.walls.delete(tid); emit(`${who} breaches ${whose}'s wall`); }
    else emit(`${who} batters ${whose}'s wall (${wall.lives}/${WALL.lives})`);
    return true;
  }

  const target = unitAt(tid);
  const townOwner = game.towns.get(tid);
  const holds = target && target.owner !== u.owner && !!unitSpec(target).range;

  /* An enemy town with no fighting garrison takes the blow itself. A garrison absorbs
     first — which is exactly what "a defender adds its lives to the town" amounts to,
     and it means wounding the garrison weakens the place. Civilians defend nothing. */
  if (townOwner !== undefined && townOwner !== u.owner && !holds) {
    const t = tileById(tid);
    game.townHurt.set(tid, hurtOf(tid) + 1);
    u.acted = true; game.notice = "";
    const who = `<b style="color:${PLAYERS[u.owner].color}">${PLAYERS[u.owner].name}</b>`;
    const whose = `<b style="color:${PLAYERS[townOwner].color}">${PLAYERS[townOwner].name}</b>`;
    if (townLife(t) <= 0)
      emit(`${who} conquers ${whose}'s town at ${t.col},${t.row} — it musters nobody now`);
    else emit(`${who} storms ${whose}'s town (${townLife(t)}/${townMaxLife(t)})`);
    return true;
  }

  if (!target || target.owner === u.owner) { game.notice = "Nothing to attack there"; return false; }

  /* SEAM FOR MULTIPLAYER: evading is the defender's decision, so once each player has a
     screen this should pause and ask them. Hot-seat cannot hand control over mid-turn,
     so for now it fires whenever the defender can pay for it. */
  if (tryEvade(target, u)) { u.acted = true; game.notice = ""; return true; }

  target.lives -= 1;
  u.acted = true;                                 // attacking ends the unit's turn
  game.notice = "";
  const vic = `<b style="color:${PLAYERS[target.owner].color}">${PLAYERS[target.owner].name}</b>`;
  if (target.lives <= 0) { game.units.delete(target.id); emit(`${who} kills ${vic}'s ${unitSpec(target).label.toLowerCase()}`); }
  else emit(`${who} wounds ${vic}'s ${unitSpec(target).label.toLowerCase()}`);
  return true;
}

/* ---------- spycraft ---------- */

export const isSpy = u => !!unitSpec(u).spy;

/* Enemy towns a spy is standing next to — everything it can work on. */
export const spyTargets = u => !isSpy(u) ? []
  : around(tileById(u.tile)).filter(t => game.towns.has(t.id) && game.towns.get(t.id) !== u.owner);

const spyAct = (id, tid, cost, what) => {
  const u = mine(id);
  if (!u) return null;
  if (!isSpy(u)) { game.notice = `Only a spy can ${what}`; return null; }
  if (u.acted) { game.notice = "That spy has already acted"; return null; }
  const t = tileById(tid);
  if (!spyTargets(u).some(x => x.id === tid)) {
    game.notice = "Stand next to the town first"; return null;
  }
  if (!canAfford(u.owner, cost)) { game.notice = `Needs ${costLabel(cost)}`; return null; }
  return { u, t, owner: game.towns.get(tid) };
};

/* Look into an adjacent town and learn whether its king is there. */
export function peekTown(id, tid) {
  const act = spyAct(id, tid, COSTS.peek, "scout");
  if (!act) return false;
  pay(act.u.owner, COSTS.peek);
  act.u.acted = true;
  const found = game.kings.get(act.owner) === tid;
  game.notice = found ? "The king is in that town" : "No king in that town";
  /* SEAM FOR MULTIPLAYER: the answer belongs to the scouting player alone. Once each
     player has a screen, send this to them and log only that a town was scouted. */
  emit(`<b style="color:${PLAYERS[act.u.owner].color}">${PLAYERS[act.u.owner].name}</b>` +
       ` scouts ${PLAYERS[act.owner].name}'s town — ${found ? "the king is there" : "no king"}`);
  return found;
}

/* What a raid on this town would actually carry off: the resource its own tile makes,
   but only if the town's owner has any of it. Null means the trip is wasted — barren
   ground produces nothing to steal, and you cannot take what nobody holds. */
export function stealable(u, tid) {
  const owner = game.towns.get(tid);
  if (owner === undefined || owner === u.owner) return null;
  const res = tileById(tid).terrain;
  if (!RESOURCES.includes(res)) return null;
  return game.hands[owner][res] > 0 ? res : null;
}

/* The wheat is spent on the attempt, not on the result — a raid on barren ground or on
   an empty purse still costs the spy its turn. Everything it depends on is public, so
   an empty-handed raid is a choice rather than a gamble. */
export function stealFrom(id, tid) {
  const act = spyAct(id, tid, COSTS.steal, "steal");
  if (!act) return false;
  pay(act.u.owner, COSTS.steal);
  act.u.acted = true;
  game.notice = "";

  const res = stealable(act.u, tid);
  const who = `<b style="color:${PLAYERS[act.u.owner].color}">${PLAYERS[act.u.owner].name}</b>`;
  const from = `<b style="color:${PLAYERS[act.owner].color}">${PLAYERS[act.owner].name}</b>`;
  if (!res) {
    game.notice = RESOURCES.includes(tileById(tid).terrain)
      ? "Nothing in that town's stores to take" : "That town sits on barren ground";
    emit(`${who} raids ${from}'s town and comes away with nothing`);
    return false;
  }
  game.hands[act.owner][res] -= 1;
  game.hands[act.u.owner][res] += 1;
  emit(`${who} steals ${TERRAIN[res].label} from ${from}`);
  return true;
}

export function assassinate(id, tid) {
  const act = spyAct(id, tid, COSTS.assassinate, "assassinate");
  if (!act) return false;
  if (game.kings.get(act.owner) !== tid) {
    game.notice = "No king in that town"; return false;
  }
  pay(act.u.owner, COSTS.assassinate);
  act.u.acted = true;
  game.kings.delete(act.owner);
  game.crown = { player: act.owner, from: tid };
  game.notice = "";
  emit(`<b style="color:${PLAYERS[act.u.owner].color}">${PLAYERS[act.u.owner].name}</b>` +
       ` assassinates <b style="color:${PLAYERS[act.owner].color}">${PLAYERS[act.owner].name}</b>'s king`);
  return true;
}

/* A spy shrugs off a blow and slips away, if its owner can pay for it. The tile it
   retreats to must be further from the attacker than the one it left. */
function tryEvade(target, attacker) {
  if (!unitSpec(target).spy || !canAfford(target.owner, COSTS.evade)) return false;
  const from = tileById(attacker.tile), here = tileById(target.tile);
  const away = around(here)
    .filter(t => canStand(target, t) && hexDist(t, from) > hexDist(here, from));
  if (!away.length) return false;
  pay(target.owner, COSTS.evade);
  target.tile = away[0].id;
  emit(`<b style="color:${PLAYERS[target.owner].color}">${PLAYERS[target.owner].name}</b>'s spy evades and slips away`);
  return true;
}

export function reviveUnit(id) {
  const u = mine(id);
  if (!u) return false;
  if (!canRevive(u)) { game.notice = whyNoRevive(u); return false; }
  pay(u.owner, repairCost(u));
  u.lives = unitSpec(u).lives; u.acted = true; game.notice = "";
  emit(`<b style="color:${PLAYERS[u.owner].color}">${PLAYERS[u.owner].name}</b>'s ${unitSpec(u).label.toLowerCase()} recovers`);
  return true;
}

const refreshUnits = pi => {
  for (const u of unitsOf(pi)) { u.moved = 0; u.acted = false; u.fresh = false; }
};

/* ---------- lifecycle ---------- */
function clearRound() {
  game.towns = new Map(); game.turn = 0; game.placed = 0;
  game.turnNo = 0; game.current = 0;
  game.roller = null; game.awaiting = false; game.dice = [null, null];
  game.keptIndex = null; game.doubles = false; game.award = null;
  game.pick = { mine: null, theirs: null }; game.needWild = null;
  game.rolled = false; game.roads = new Map();
  game.units = new Map(); game.nextUnit = 1;
  game.ports = new Map(); game.walls = new Map();
  game.kings = new Map(); game.crown = null;
  game.townHurt = new Map(); game.busy = new Set();
  game.notice = ""; game.varietyReq = RULES.MIN_VARIETY;
  game.hands = PLAYERS.map(blankHand);
}

export function setBoard(board) { game.board = board; game.phase = "idle"; indexEdges(); clearRound(); }
export function setPlayers(n)   { game.playerCount = n; game.phase = "idle"; clearRound(); }

export function startGame() {
  clearRound();
  game.phase = "placing";
  game.turn = placingPlayer();
  ensureSites();
  const sites = legalCount(), need = townsToPlace();
  emit(`— new game, ${game.playerCount} players · ${RULES.TOWNS_AT_START} towns each · ${sites} legal sites —`);
  if (sites < need) emit(`<span class="bad">Board is too tight for ${need} towns — reroll or size up</span>`);
}

export function resetGame() { clearRound(); game.phase = "idle"; emit("— reset —"); }

/* ---------- actions ---------- */
export function placeTown(t) {
  if (game.phase !== "placing") return false;
  if (!legalTown(t)) { game.notice = whyIllegal(t); return false; }
  game.notice = "";
  game.towns.set(t.id, game.turn);
  emit(`<b style="color:${PLAYERS[game.turn].color}">${PLAYERS[game.turn].name}</b> settles ${TERRAIN[t.terrain].label} at ${t.col},${t.row}`);
  game.placed++;
  if (game.placed >= townsToPlace()) {
    game.phase = "crowning"; game.turn = 0;
    emit(`All towns placed — each player now seats a king`);
  } else {
    game.turn = placingPlayer();
    ensureSites();
  }
  return true;
}

export function rollDice(rand = Math.random) {
  if (game.phase !== "play" || game.awaiting || game.rolled) return false;
  if (owesKing(game.current)) {   // seat the new king before anything else
    game.notice = "Seat your king first — click one of your towns";
    return false;
  }
  game.rolled = true;
  const n = DIE_FACES.length;
  game.dice = [DIE_FACES[Math.floor(rand() * n)], DIE_FACES[Math.floor(rand() * n)]];
  game.keptIndex = null; game.awaiting = true; game.roller = game.current;
  game.notice = ""; game.award = null; game.needWild = null;
  game.pick = { mine: null, theirs: null };
  const [a, b] = game.dice;
  game.doubles = a === b;
  emit(`<b>Turn ${game.turnNo}</b> · ${PLAYERS[game.current].name} rolled ${faceSpec(a).label} + ${faceSpec(b).label}`);
  /* Doubles are not a special rule — there is simply nothing to choose between two
     identical faces, so the turn resolves itself. Two wilds are still doubles, but the
     roller then names both resources, so the choice moves rather than disappearing. */
  if (game.doubles) {
    if (a === WILD) {
      emit(`<b>Famine</b> — two wilds, nobody produces`);
      game.awaiting = false; game.keptIndex = null;
      famine();
    } else {
      emit(`Doubles — no choice, everyone produces ${faceSpec(a).label}`);
      resolveRoll(0);
    }
  }
  return true;
}

/* The roller keeps one die; the other resource goes to everyone else. A kept wild has to
   be named before anything is paid, and so does a given one — the roller chooses both,
   which is what makes a double wild the strongest roll in the game rather than a dud. */
export function resolveRoll(keepIdx) {
  if (!game.awaiting) return false;
  if (game.roller === null) game.roller = game.current;
  game.keptIndex = keepIdx;
  game.awaiting = false;
  game.pick = { mine: game.dice[keepIdx], theirs: game.dice[1 - keepIdx] };
  return settlePicks();
}

export const held = pi => RESOURCES.reduce((a, f) => a + game.hands[pi][f], 0);

/* Two wilds is a famine, not a windfall: nobody produces at all, and every player gives
   up one card for every FAMINE_PER they are sitting on. It scales with the size of the
   pile, so it bites whoever has been hoarding and passes over anyone living hand to
   mouth — the one thing in the game that pulls a runaway leader back. */
function famine() {
  const parts = [];
  for (let i = 0; i < game.playerCount; i++) {
    let owed = Math.floor(held(i) / RULES.FAMINE_PER);
    const lost = {};
    while (owed-- > 0) {
      /* SEAM FOR MULTIPLAYER: which card to give up is the player's choice. Until each
         has their own screen there is nobody to ask mid-turn, so take from the largest
         pile — what a player would usually pick anyway. */
      const f = RESOURCES.reduce((a, b) => game.hands[i][b] > game.hands[i][a] ? b : a);
      if (game.hands[i][f] <= 0) break;
      game.hands[i][f]--; lost[f] = (lost[f] || 0) + 1;
    }
    if (Object.keys(lost).length)
      parts.push(`<b style="color:${PLAYERS[i].color}">${PLAYERS[i].name}</b> −${costLabel(lost)}`);
  }
  game.award = { roller: game.roller, mine: WILD, theirs: WILD,
                 kept: 0, given: 0, doubles: true, famine: true };
  emit(parts.length ? "→ " + parts.join(", ")
                    : "→ nobody had stores enough to lose any");
}

/* Ask for the next outstanding wild, or pay out once both faces are real resources. */
function settlePicks() {
  for (const slot of ["mine", "theirs"]) {
    if (game.pick[slot] === WILD) { game.needWild = slot; return true; }
  }
  game.needWild = null;
  payOut();
  return true;
}

export function nameWild(res) {
  if (!game.needWild || !RESOURCES.includes(res)) return false;
  const slot = game.needWild;
  game.pick[slot] = res;
  emit(`${PLAYERS[game.roller].name} names ${TERRAIN[res].label} ${slot === "mine" ? "for themselves" : "for everyone else"}`);
  return settlePicks();
}

function payOut() {
  const who = game.roller;                      // the roller keeps, not whoever is current
  const { mine, theirs } = game.pick;
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
}

export function endTurn() {
  if (game.phase !== "play" || game.awaiting || game.needWild || !game.rolled) return false;
  game.rolled = false;
  game.turnNo++;
  game.current = (game.current + 1) % game.playerCount;
  game.notice = "";
  refreshUnits(game.current);      // the incoming player's units are ready again
  refreshTowns(game.current);      // and their work crews can start again
  return true;
}

export { settleable };
