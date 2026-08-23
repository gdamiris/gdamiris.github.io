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
  turn: 0,                  // placement cursor
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
  return !!w && w.owner === pi && w.lives < WALL.lives && !w.repaired
      && canAfford(pi, WALL.repair);
}

export function whyNoWallRepair(pi, t) {
  const w = t && game.walls.get(t.id);
  if (!w) return "No wall there";
  if (w.owner !== pi) return "That is not your wall";
  if (w.lives >= WALL.lives) return "That wall is intact";
  if (w.repaired) return "That wall has been repaired this turn";
  return `Needs ${costLabel(WALL.repair)}`;
}

export function repairWall(t) {
  if (!canBuild()) return false;
  const pi = game.current;
  if (!canRepairWall(pi, t)) { game.notice = whyNoWallRepair(pi, t); return false; }
  const w = game.walls.get(t.id);
  pay(pi, WALL.repair);
  w.lives++; w.repaired = true;                 // one course a turn, no more
  game.notice = "";
  emit(`<b style="color:${PLAYERS[pi].color}">${PLAYERS[pi].name}</b> repairs a wall (${w.lives}/${WALL.lives})`);
  return true;
}

const refreshWalls = pi => { for (const [, w] of game.walls) if (w.owner === pi) w.repaired = false; };

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
                : !legalLaunch(pi, kind, t)
                  ? (UNITS[kind].home === "port" ? "Launch from one of your ports"
                                                 : "Recruit on one of your towns")
                : `Needs ${unitCostLabel(kind)}`;
    return false;
  }
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
   this turn — it may march, but the ambush has to wait for its owner's next turn. */
export const canAttack = u => !u.acted && !u.fresh && !!unitSpec(u).range
  && u.moved <= unitSpec(u).move - STEP;

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
        const steps = c + stepCost(u.kind, n.terrain);
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
  if (!target || target.owner === u.owner) { game.notice = "Nothing to attack there"; return false; }

  target.lives -= 1;
  u.acted = true;                                 // attacking ends the unit's turn
  game.notice = "";
  const vic = `<b style="color:${PLAYERS[target.owner].color}">${PLAYERS[target.owner].name}</b>`;
  if (target.lives <= 0) { game.units.delete(target.id); emit(`${who} kills ${vic}'s ${unitSpec(target).label.toLowerCase()}`); }
  else emit(`${who} wounds ${vic}'s ${unitSpec(target).label.toLowerCase()}`);
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
  game.towns = new Map(); game.turn = 0; game.turnNo = 0; game.current = 0;
  game.roller = null; game.awaiting = false; game.dice = [null, null];
  game.keptIndex = null; game.doubles = false; game.award = null;
  game.pick = { mine: null, theirs: null }; game.needWild = null;
  game.rolled = false; game.roads = new Map();
  game.units = new Map(); game.nextUnit = 1;
  game.ports = new Map(); game.walls = new Map();
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
    emit(a === WILD
      ? `Double wild — ${PLAYERS[game.current].name} names both resources`
      : `Doubles — no choice, everyone produces ${faceSpec(a).label}`);
    resolveRoll(0);
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
  refreshWalls(game.current);      // and their masons can lay another course
  return true;
}

export { settleable };
