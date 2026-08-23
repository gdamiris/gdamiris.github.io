/* Construction rules: roads, bridges, and founding towns. No DOM, no browser.
   Run with: node tests/build.js

   These are the rules that are easiest to break by accident, because most of them are
   about what must be REFUSED rather than what must work. */

import { RESOURCES, COSTS, RULES } from "../src/config.js";
import { isWater, settleable } from "../src/terrain.js";
import { hexDist } from "../src/hex.js";
import { generateBoard } from "../src/generate.js";
import * as G from "../src/game.js";

let failures = 0, total = 0;
const check = (name, cond, detail = "") => {
  total++;
  if (!cond) { failures++; console.log("  FAIL", name, detail); }
};
const section = name => console.log("\n" + name);

/* ---------- fixtures ---------- */

/* Settle players inland and as far apart as the board allows. A rim town has fewer than
   six ways out and a crowded one has its exits blocked by a neighbour's perimeter, so
   neither makes a fair fixture. */
/* Play out the whole snake draft: every player founds TOWNS_AT_START towns, inland and
   as far apart as the board allows. */
function seedTowns() {
  const b = G.game.board;
  const inland = t => t.col > 1 && t.row > 1 && t.col < b.cols - 2 && t.row < b.rows - 2;
  for (let p = 0; p < G.townsToPlace(); p++) {
    const opts = b.tiles.filter(t => G.legalTown(t) && inland(t));
    const placed = [...G.game.towns.keys()].map(id => b.tiles[id]);
    G.placeTown(placed.length
      ? opts.reduce((best, t) => {
          const d = Math.min(...placed.map(o => hexDist(t, o)));
          return d > best.d ? { t, d } : best;
        }, { t: opts[0], d: -1 }).t
      : opts[Math.floor(opts.length / 2)]);
  }
  seatKings();
}

/* Kings are seated after the draft, one per player, each in their first town. */
function seatKings() {
  while (G.game.phase === "crowning") G.seatKing(G.townsOf(G.game.turn)[0]);
}

const DOUBLES = () => 0.01;                       // wood + wood: resolves itself
const SPLIT = (n => () => [0.01, 0.5][n++ % 2])(0); // wood + ore: leaves a choice

/* A board with `n` players settled and the current player's build window open. */
function fresh(n = 2, seed = "halcyon") {
  G.setBoard(generateBoard(seed, 13, 15));
  G.setPlayers(n);
  G.startGame();
  seedTowns();
  G.rollDice(DOUBLES);
  return G.game.board;
}

const rich   = (pi, v = 999) => RESOURCES.forEach(f => G.game.hands[pi][f] = v);
const broke  = pi => RESOURCES.forEach(f => G.game.hands[pi][f] = 0);
const hand   = pi => ({ ...G.game.hands[pi] });
const pass   = (rand = DOUBLES) => { G.endTurn(); G.rollDice(rand); };
const openTo = (pi, net = G.networkVerts(pi)) =>
  G.game.board.edges.filter(e => G.legalEdge(pi, e.id, net));

/* Shortest buildable run of edges from pi's network to a corner of `target`.
   Returns edge ids in build order, [] if already touching, null if unreachable. */
function pathTo(pi, target) {
  const b = G.game.board;
  const start = G.networkVerts(pi);
  if (b.corners[target.id].some(c => start.has(c))) return [];

  const adj = new Map();
  for (const e of b.edges) {
    if (G.game.roads.has(e.id) || e.tiles.some(t => G.game.towns.has(t))) continue;
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push([e.b, e.id]);
    adj.get(e.b).push([e.a, e.id]);
  }
  const goal = new Set(b.corners[target.id]);
  const prev = new Map(), seen = new Set(start);
  const q = [...start];
  while (q.length) {
    const v = q.shift();
    if (goal.has(v)) {
      const out = [];
      for (let u = v; prev.has(u); u = prev.get(u)[0]) out.unshift(prev.get(u)[1]);
      return out;
    }
    for (const [n, eid] of adj.get(v) || []) {
      if (seen.has(n)) continue;
      seen.add(n); prev.set(n, [v, eid]); q.push(n);
    }
  }
  return null;
}

/* ---------- the build window ---------- */
section("build window");
{
  G.setBoard(generateBoard("halcyon", 13, 15));
  G.setPlayers(2);
  check("cannot build before the game starts", G.canBuild() === false);

  G.startGame();
  check("cannot build during placement", G.canBuild() === false);

  seedTowns();
  check("cannot build before rolling", G.canBuild() === false);

  const me = G.game.current;
  rich(me);
  const before = hand(me);
  const anyEdge = G.game.board.edges[0].id;
  check("buildEdge is refused before rolling", G.buildEdge(anyEdge) === false);
  check("a refused build costs nothing", JSON.stringify(hand(me)) === JSON.stringify(before));

  G.rollDice(SPLIT);
  check("cannot build while a die is still owed", G.game.awaiting && G.canBuild() === false);
  G.resolveRoll(0);
  check("build opens once the roll resolves", G.canBuild() === true);

  G.endTurn();
  check("build closes when the turn ends", G.canBuild() === false);
  check("endTurn is refused twice", G.endTurn() === false);
}

/* ---------- what a town offers, and what it blocks ---------- */
section("town perimeter and exits");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);

  const startNet = G.networkVerts(me);
  const ownCorners = new Set(G.townsOf(me).flatMap(t => b.corners[t.id]));
  check("the network starts as the corners of your towns",
    startNet.size === ownCorners.size && [...ownCorners].every(c => startNet.has(c)));
  check("which is 6 per town", startNet.size === 6 * G.townsOf(me).length,
    `${startNet.size} for ${G.townsOf(me).length} towns`);
  check("a town blocks every edge of its own hexagon",
    G.tileEdges(home).every(id => G.legalEdge(me, id) === false));
  check("blocked perimeter reports why",
    G.tileEdges(home).every(id => G.whyEdgeIllegal(me, id) === "A town blocks that edge"));

  const open = openTo(me);
  check("each inland town has exactly 6 ways out",
    open.length === 6 * G.townsOf(me).length, `got ${open.length}`);
  check("no exit touches a town's own tile",
    open.every(e => !e.tiles.some(id => G.game.towns.has(id))));
  check("every exit touches a corner of one of your towns",
    open.every(e => ownCorners.has(e.a) || ownCorners.has(e.b)));

  /* an opponent's town blocks just as hard as your own */
  const theirs = [...G.game.towns].find(([, o]) => o !== me);
  check("an opponent's perimeter is blocked too",
    G.tileEdges(b.tiles[theirs[0]]).every(id => G.legalEdge(me, id) === false));
}

/* ---------- roads: land edges, 2 ore ---------- */
section("roads");
{
  const b = fresh(2);
  const me = G.game.current;
  /* Fund first: openTo only lists edges the player can actually pay for, so picking a
     target while broke silently hands back a disconnected edge. */
  rich(me);
  const road = openTo(me).find(e => !e.water);
  check("an inland town has a land exit", !!road);

  G.game.hands[me].ore = 1;
  check("1 ore is not enough for a road", G.legalEdge(me, road.id) === false);
  check("shortfall reports the cost",
    G.whyEdgeIllegal(me, road.id) === `Needs ${G.costLabel(COSTS.road)}`);

  G.game.hands[me].ore = 2;
  check("2 ore is exactly enough", G.legalEdge(me, road.id) === true);
  check("a road costs ore", JSON.stringify(G.edgeCost(road)) === JSON.stringify(COSTS.road));

  const before = hand(me), netBefore = G.networkVerts(me).size;
  check("the road is built", G.buildEdge(road.id) === true);
  check("2 ore is deducted", G.game.hands[me].ore === before.ore - 2);
  check("nothing else is spent",
    RESOURCES.filter(f => f !== "ore").every(f => G.game.hands[me][f] === before[f]));
  check("the road is recorded to its owner", G.game.roads.get(road.id).owner === me);
  check("a land edge is not flagged as a bridge", G.game.roads.get(road.id).bridge === false);
  check("the network gains the far vertex", G.networkVerts(me).size === netBefore + 1);

  rich(me);
  check("an edge can only be built once", G.buildEdge(road.id) === false);
  check("occupied edges report why",
    G.whyEdgeIllegal(me, road.id) === "Something is built there already");
}

/* ---------- bridges: water edges, 2 wood ---------- */
section("bridges");
{
  const b = fresh(2);
  const me = G.game.current;

  check("the graph keeps water edges", b.edges.some(e => e.water));
  check("water edges touch sea or fish",
    b.edges.filter(e => e.water).every(e => e.tiles.some(t => isWater(b.tiles[t]))));
  check("land edges touch no water",
    b.edges.filter(e => !e.water).every(e => e.tiles.every(t => !isWater(b.tiles[t]))));
  check("a bridge costs wood",
    JSON.stringify(G.edgeCost(b.edges.find(e => e.water))) === JSON.stringify(COSTS.bridge));

  /* walk out to the coast and cross */
  rich(me);
  const coast = b.tiles.find(t => isWater(t) && hexDist(t, G.townsOf(me)[0]) > 1);
  const path = coast ? pathTo(me, coast) : null;
  check("a coast is reachable", Array.isArray(path), "no water tile could be pathed to");

  if (Array.isArray(path)) {
    path.forEach(id => G.buildEdge(id));
    const built = [...G.game.roads.values()];
    check("reaching water required at least one bridge", built.some(r => r.bridge));
    check("bridge flags match the graph",
      [...G.game.roads].every(([id, r]) => r.bridge === b.edges[id].water));

    const wood = G.game.hands[me].wood, ore = G.game.hands[me].ore;
    const bridges = built.filter(r => r.bridge).length, roads = built.length - bridges;
    check("spend matches the mix of road and bridge",
      wood === 999 - bridges * 2 && ore === 999 - roads * 2,
      `${roads} roads, ${bridges} bridges -> ore ${ore}, wood ${wood}`);
  }

  /* ore cannot pay for a bridge, nor wood for a road */
  const b2 = fresh(2);
  const me2 = G.game.current;
  rich(me2);
  const water = openTo(me2).find(e => e.water);
  if (water) {
    G.game.hands[me2].ore = 99; G.game.hands[me2].wood = 0;
    check("ore does not buy a bridge",
      G.legalEdge(me2, water.id, undefined, "bridge") === false);
    G.game.hands[me2].wood = 2;
    check("wood buys a bridge",
      G.legalEdge(me2, water.id, undefined, "bridge") === true);
  } else {
    console.log("  (skipped: this fixture's town has no water exit)");
  }
}

/* ---------- coastal edges take either kind ---------- */
section("coastal edges");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);
  const landCount = e => e.tiles.filter(id => !isWater(b.tiles[id])).length;

  check("land-to-land edges take a road only", b.edges.filter(e => landCount(e) === 2)
    .every(e => JSON.stringify(G.edgeKinds(e)) === JSON.stringify(["road"])));
  check("open-water edges take a bridge only", b.edges.filter(e => landCount(e) === 0)
    .every(e => JSON.stringify(G.edgeKinds(e)) === JSON.stringify(["bridge"])));
  check("coastal edges take either", b.edges.filter(e => landCount(e) === 1)
    .every(e => G.edgeKinds(e).includes("road") && G.edgeKinds(e).includes("bridge")));
  check("coastal edges are flagged", b.edges
    .every(e => G.isCoastalEdge(e) === (landCount(e) === 1)));
  check("there are coastal edges to build on",
    b.edges.filter(G.isCoastalEdge).length > 0);

  check("a road on open water is refused", (() => {
    const e = b.edges.find(x => landCount(x) === 0);
    return G.legalEdge(me, e.id, undefined, "road") === false
      && G.whyEdgeIllegal(me, e.id, undefined, "road") === "A road needs land on both sides";
  })());
  check("a bridge between two land tiles is refused", (() => {
    const e = b.edges.find(x => landCount(x) === 2);
    return G.legalEdge(me, e.id, undefined, "bridge") === false
      && G.whyEdgeIllegal(me, e.id, undefined, "bridge") === "A bridge needs water on one side";
  })());

  /* walk out to a coastal edge and build a ROAD on it */
  let steps = 0;
  while (steps < 14 && !openTo(me).some(G.isCoastalEdge)) {
    const e = openTo(me)[0];
    if (!e) break;
    G.buildEdge(e.id); steps++;
  }
  const coast = openTo(me).find(G.isCoastalEdge);
  check("a coastal edge comes into reach", !!coast, `after ${steps} builds`);

  if (coast) {
    check("both kinds cost differently",
      JSON.stringify(G.edgeCost(coast, "road")) === JSON.stringify(COSTS.road)
      && JSON.stringify(G.edgeCost(coast, "bridge")) === JSON.stringify(COSTS.bridge));

    const ore = G.game.hands[me].ore, wood = G.game.hands[me].wood;
    check("a road can be built on the shore", G.buildEdge(coast.id, "road") === true);
    check("it is recorded as a road", G.game.roads.get(coast.id).bridge === false);
    check("it was paid for in ore", G.game.hands[me].ore === ore - 2
      && G.game.hands[me].wood === wood);
  }

  /* and the same kind of edge can instead take a bridge */
  const coast2 = openTo(me).find(G.isCoastalEdge);
  if (coast2) {
    const ore = G.game.hands[me].ore, wood = G.game.hands[me].wood;
    check("a bridge can be built on the shore", G.buildEdge(coast2.id, "bridge") === true);
    check("it is recorded as a bridge", G.game.roads.get(coast2.id).bridge === true);
    check("it was paid for in wood", G.game.hands[me].wood === wood - 2
      && G.game.hands[me].ore === ore);
  }

  /* affordability is per kind: ore alone still buys the coastal road */
  const coast3 = openTo(me).find(G.isCoastalEdge);
  if (coast3) {
    G.game.hands[me].wood = 0; G.game.hands[me].ore = 2;
    check("with ore but no wood the shore still takes a road",
      G.legalEdge(me, coast3.id) === true
      && G.legalEdge(me, coast3.id, undefined, "road") === true
      && G.legalEdge(me, coast3.id, undefined, "bridge") === false);
  }
}

/* ---------- connectivity ---------- */
section("network connectivity");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);

  const net = G.networkVerts(me);
  const detached = b.edges.filter(e => !net.has(e.a) && !net.has(e.b)
    && !e.tiles.some(t => G.game.towns.has(t)));
  check("there are detached edges to test", detached.length > 0);
  check("detached edges are illegal however rich you are",
    detached.every(e => G.legalEdge(me, e.id) === false));
  check("detachment reports why",
    G.whyEdgeIllegal(me, detached[0].id) === "Must connect to your network");

  /* build a chain: each new edge must extend the previous one */
  let last = null, chain = 0;
  for (let i = 0; i < 4; i++) {
    const e = openTo(me).find(x => x.id !== last);
    if (!e) break;
    G.buildEdge(e.id); last = e.id; chain++;
  }
  check("a chain of 4 edges builds", chain === 4, `built ${chain}`);
  check("the network grew with the chain",
    G.networkVerts(me).size === 6 * G.townsOf(me).length + chain);

  /* an opponent's roads are not your roads */
  const mine = new Set([...G.game.roads].filter(([, r]) => r.owner === me).map(([id]) => id));
  pass();
  const them = G.game.current;
  rich(them);
  check("turn actually passed", them !== me);
  check("opponent cannot build on your edges",
    [...mine].every(id => G.legalEdge(them, id) === false));
  const theirNet = G.networkVerts(them);
  check("opponent's network excludes your edges",
    [...mine].every(id => !(theirNet.has(b.edges[id].a) && theirNet.has(b.edges[id].b))));
}

/* ---------- founding a town ---------- */
section("town construction");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);

  check("a lone town can reach nowhere",
    b.tiles.every(t => G.legalExpansion(me, t) === false));
  check("unreached tiles report why", (() => {
    const t = b.tiles.find(x => G.legalTown(x));
    return G.whyExpansionIllegal(me, t) === "Your network does not reach that tile";
  })());

  /* roads outward until a site opens */
  let builds = 0;
  while (builds < 10 && !b.tiles.some(t => G.legalExpansion(me, t))) {
    const e = openTo(me)[0];
    if (!e) break;
    G.buildEdge(e.id); builds++;
  }
  const sites = b.tiles.filter(t => G.legalExpansion(me, t));
  check("roads open a town site", sites.length > 0, `after ${builds} builds`);
  check("a site is at least the gap away",
    sites.every(t => [...G.game.towns.keys()]
      .every(id => hexDist(t, b.tiles[id]) >= RULES.MIN_TOWN_GAP)));
  check("a site is never water", sites.every(settleable));
  check("a site touches the network", sites.every(t =>
    b.corners[t.id].some(c => G.networkVerts(me).has(c))));

  const site = sites[0];

  /* every single resource in the cost is required */
  for (const res of Object.keys(COSTS.town)) {
    const keep = G.game.hands[me][res];
    G.game.hands[me][res] = COSTS.town[res] - 1;
    check(`short on ${res} blocks founding`, G.legalExpansion(me, site) === false);
    G.game.hands[me][res] = keep;
  }
  check("full cost restores legality", G.legalExpansion(me, site) === true);

  const before = hand(me), towns = G.game.towns.size, income = G.yieldOf(me, "wood");
  check("the town is founded", G.buildTown(site) === true);
  check("it is recorded to its owner", G.game.towns.get(site.id) === me);
  check("the town count grew by one", G.game.towns.size === towns + 1);
  check("every resource in the cost is paid",
    Object.entries(COSTS.town).every(([k, n]) => G.game.hands[me][k] === before[k] - n));
  check("wool is not part of the cost", G.game.hands[me].wool === before.wool);
  check("income is flat, whatever the town count", G.yieldOf(me, "wood") === income,
    "towns buy territory and muster points, not income");
  check("the new town adds its corners to the network",
    b.corners[site.id].every(c => G.networkVerts(me).has(c)));
  check("the new town blocks its own perimeter",
    G.tileEdges(site).filter(id => !G.game.roads.has(id))
      .every(id => G.legalEdge(me, id) === false));
  check("the same tile cannot be settled twice", G.buildTown(site) === false);
  check("neighbours of the new town are now blocked",
    G.around(site).every(t => G.legalExpansion(me, t) === false));

  broke(me);
  check("a broke player can found nothing",
    b.tiles.every(t => G.legalExpansion(me, t) === false));
  check("water is refused outright",
    b.tiles.filter(isWater).every(t => G.legalTown(t) === false));
}

/* ---------- island hopping ---------- */
section("island hopping");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);

  const target = b.tiles
    .filter(t => settleable(t) && t.island >= 0 && t.island !== home.island
      && [...G.game.towns.keys()].every(id => hexDist(t, b.tiles[id]) >= RULES.MIN_TOWN_GAP))
    .sort((x, y) => hexDist(x, home) - hexDist(y, home))[0];

  check("another island has a settleable tile", !!target);

  if (target) {
    const path = pathTo(me, target);
    check("a route to another island exists", Array.isArray(path) && path.length > 0,
      `island ${home.island} -> ${target.island}`);

    if (Array.isArray(path) && path.length) {
      check("the route crosses water", path.some(id => b.edges[id].water),
        "islands never touch, so a crossing is required");
      check("every step of the route builds", path.every(id => G.buildEdge(id)),
        `${path.length} edges`);
      check("the far island is now reachable", G.legalExpansion(me, target) === true);
      check("the town is founded overseas", G.buildTown(target) === true);
      check("a second island does not raise income", G.yieldOf(me, "ore") === 1);
      console.log(`  (crossed to island ${target.island} in ${path.length} edges, ` +
        `${path.filter(id => b.edges[id].water).length} of them bridges)`);
    }
  }
}

/* ---------- nothing ever goes negative ---------- */
section("conservation");
{
  const b = fresh(3);
  let negative = 0, illegalBuilds = 0;

  for (let turn = 0; turn < 60; turn++) {
    const pi = G.game.current;
    /* spend everything affordable, then verify no hand ever dipped below zero */
    for (let i = 0; i < 3; i++) {
      const e = openTo(pi)[0];
      if (e && !G.buildEdge(e.id)) illegalBuilds++;
      const site = b.tiles.find(t => G.legalExpansion(pi, t));
      if (site && !G.buildTown(site)) illegalBuilds++;
    }
    if (G.game.hands.some(h => RESOURCES.some(f => h[f] < 0))) negative++;
    pass(turn % 3 === 0 ? SPLIT : DOUBLES);
    if (G.game.awaiting) G.resolveRoll(turn % 2);
  }
  check("no hand ever went negative", negative === 0, `${negative} turns`);
  check("no legal-looking build was refused", illegalBuilds === 0, `${illegalBuilds} refusals`);
  check("towns only ever grew", G.game.towns.size >= 3);
  check("every road belongs to a real player",
    [...G.game.roads.values()].every(r => r.owner >= 0 && r.owner < G.game.playerCount));
  console.log(`  (${G.game.roads.size} edges and ${G.game.towns.size} towns built over 60 turns)`);
}

console.log(failures
  ? `\n${failures} FAILURES out of ${total} checks`
  : `\nall ${total} checks passed`);
process.exit(failures ? 1 : 0);
