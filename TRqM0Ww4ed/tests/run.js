/* Headless checks over the pure modules. No DOM, no browser.
   Run with: node tests/run.js */

import { DIE_FACES, TUNING, RULES, COSTS } from "../src/config.js";
import { TERRAIN, isResource, settleable } from "../src/terrain.js";
import { NB, hexDist } from "../src/hex.js";
import { generateBoard, tileCounts } from "../src/generate.js";
import * as G from "../src/game.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) { failures++; console.log("  FAIL", name, detail); }
};
const section = name => console.log("\n" + name);

/* ---- geometry: offset neighbours must match true hex distance ---- */
section("geometry");
{
  const b = generateBoard("geo", 13, 15);
  const S = b.tiles[1].x - b.tiles[0].x;
  let bad = 0, asym = 0;
  for (const t of b.tiles) {
    const truth = b.tiles.filter(o => o !== t && Math.hypot(o.x - t.x, o.y - t.y) < S * 1.05).map(o => o.id).sort((a, c) => a - c);
    const got = NB[t.row & 1].map(([dc, dr]) => {
      const c = t.col + dc, r = t.row + dr;
      return (c < 0 || r < 0 || c >= b.cols || r >= b.rows) ? null : b.tiles[r * b.cols + c];
    }).filter(Boolean).map(o => o.id).sort((a, c) => a - c);
    if (JSON.stringify(truth) !== JSON.stringify(got)) bad++;
    for (const id of got) if (!NB[b.tiles[id].row & 1].some(([dc, dr]) =>
      b.tiles[id].col + dc === t.col && b.tiles[id].row + dr === t.row)) asym++;
  }
  check("offset neighbours match geometry", bad === 0, `${bad} tiles`);
  check("adjacency is symmetric", asym === 0, `${asym} links`);
}

/* ---- generation invariants across many seeds and sizes ---- */
section("generation");
for (const [cols, rows] of [[11, 13], [13, 15], [15, 17]]) {
  for (let i = 0; i < 8; i++) {
    const b = generateBoard("seed" + i, cols, rows);
    const c = tileCounts(b);
    const tag = `${cols}x${rows} seed${i}`;
    check("every resource has equal count", new Set(DIE_FACES.map(f => c[f] || 0)).size === 1, tag + " " + DIE_FACES.map(f => c[f] || 0));
    check("resource count matches board.per", DIE_FACES.every(f => (c[f] || 0) === b.per), tag);
    check("island count honoured", b.sizes.length === b.islands, `${tag} got ${b.sizes.length}/${b.islands}`);
    check("determinism", JSON.stringify(generateBoard("seed" + i, cols, rows)) === JSON.stringify(b), tag);
    check("no unassigned tiles", b.tiles.every(t => TERRAIN[t.terrain]), tag);
  }
}

/* ---- de-clumping preserves counts and reduces monocultures ---- */
section("de-clumping");
{
  const raw = generateBoard("halcyon", 13, 15, { ...TUNING, mixing: 0 });
  const mix = generateBoard("halcyon", 13, 15, TUNING);
  const cohesion = b => {
    const res = b.tiles.filter(isResource);
    const nb = t => NB[t.row & 1].map(([dc, dr]) => {
      const c = t.col + dc, r = t.row + dr;
      return (c < 0 || r < 0 || c >= b.cols || r >= b.rows) ? null : b.tiles[r * b.cols + c];
    }).filter(Boolean);
    return res.reduce((a, t) => a + nb(t).filter(n => n.terrain === t.terrain).length, 0) / res.length;
  };
  check("counts survive mixing", JSON.stringify(DIE_FACES.map(f => tileCounts(raw)[f])) === JSON.stringify(DIE_FACES.map(f => tileCounts(mix)[f])));
  check("mixing lowers cohesion", cohesion(mix) < cohesion(raw), `${cohesion(raw).toFixed(2)} -> ${cohesion(mix).toFixed(2)}`);
  check("mixing keeps some cohesion", cohesion(mix) > 0.5, cohesion(mix).toFixed(2));
}

/* ---- full games: placement, turn order, yields ---- */
section("game loop");
{
  let rolls = 0;
  for (let s = 0; s < 6; s++) {
    for (let pc = 2; pc <= 6; pc++) {
      G.setBoard(generateBoard("g" + s, 13, 15));
      G.setPlayers(pc);
      G.startGame();
      for (let p = 0; p < pc; p++) {
        const opts = G.game.board.tiles.filter(G.legalTown);
        check("legal sites available", opts.length > 0, `seed g${s} pc${pc} player ${p}`);
        if (!opts.length) break;
        G.placeTown(opts[Math.floor(opts.length * (p + 1) / (pc + 1))]);
      }
      check("placement completed", G.game.phase === "play", `seed g${s} pc${pc}`);
      check("one town per player", G.game.towns.size === pc);
      check("towns respect the gap rule", [...G.game.towns.keys()].every((a, i, arr) =>
        arr.slice(i + 1).every(b => hexDist(G.game.board.tiles[a], G.game.board.tiles[b]) >= RULES.MIN_TOWN_GAP)));
      check("no town on water", [...G.game.towns.keys()].every(id => settleable(G.game.board.tiles[id])));

      for (let k = 0; k < 30; k++) {
        const who = G.game.current;
        G.rollDice();
        if (G.game.awaiting) G.resolveRoll(k % 2);
        check("turn waits for endTurn", G.game.current === who);
        check("cannot roll twice in a turn", G.rollDice() === false);
        G.endTurn();
        rolls++;
        check("turn advances", G.game.current === (who + 1) % pc, `${who} -> ${G.game.current}`);
        check("hands stay finite", G.game.hands.slice(0, pc).every(h => DIE_FACES.every(f => Number.isFinite(h[f]) && h[f] >= 0)));
      }
      check("yield never exceeds town count", DIE_FACES.every(f =>
        Array.from({ length: pc }, (_, i) => G.yieldOf(i, f)).every(v => v <= G.townsOf(0).length + pc)));
    }
  }
  console.log(`  (${rolls} rolls simulated)`);
}

/* ---- production is independent of terrain ---- */
section("production");
{
  G.setBoard(generateBoard("halcyon", 13, 15));
  G.setPlayers(3);
  G.startGame();
  for (let p = 0; p < 3; p++) G.placeTown(G.game.board.tiles.filter(G.legalTown)[p * 3 + 1]);

  check("every player produces every resource", [0, 1, 2].every(i =>
    DIE_FACES.every(f => G.yieldOf(i, f) === 1)),
    [0, 1, 2].map(i => DIE_FACES.filter(f => !G.yieldOf(i, f)).join("/")).join(" "));
  check("yield ignores the town's own terrain", new Set([0, 1, 2].flatMap(i =>
    DIE_FACES.map(f => G.yieldOf(i, f)))).size === 1);

  /* the roller keeps one face, everyone else takes the other */
  const before = G.game.hands.map(h => ({ ...h }));
  const who = G.game.current;
  G.rollDice(() => 0.01);                       // forces wood + wood -> doubles
  check("matching faces resolve without a click", G.game.awaiting === false);
  check("doubles are flagged", G.game.doubles === true);
  check("doubles pay every player", [0, 1, 2].every(i =>
    G.game.hands[i].wood === before[i].wood + 1),
    [0, 1, 2].map(i => G.game.hands[i].wood).join(","));
  check("doubles credit no deliberate keep", G.game.award.doubles === true);
  check("doubles still leave a build window", G.game.current === who && G.canBuild());
}

/* ---- the roller, not whoever is current, receives the kept die ---- */
section("keep one, give one");
{
  G.setBoard(generateBoard("halcyon", 13, 15));
  G.setPlayers(3);
  G.startGame();
  for (let p = 0; p < 3; p++) G.placeTown(G.game.board.tiles.filter(G.legalTown)[p * 3 + 1]);

  let n = 0;
  const roller = G.game.current;
  G.rollDice(() => [0.01, 0.9][n++]);            // wood + fish, distinct
  check("distinct faces await a choice", G.game.awaiting === true && G.game.doubles === false);
  const [a, b] = G.game.dice;
  G.resolveRoll(0);                              // keep the LEFT die
  check("roller receives the kept face", G.game.hands[roller][a] === 1, `${a} -> ${G.game.hands[roller][a]}`);
  check("roller does not receive the given face", G.game.hands[roller][b] === 0);
  check("others receive the given face", [0, 1, 2].filter(i => i !== roller)
    .every(i => G.game.hands[i][b] === 1 && G.game.hands[i][a] === 0));
  check("award reports what was paid", G.game.award.roller === roller && G.game.award.kept === 1
    && G.game.award.given === 2, JSON.stringify(G.game.award));
}

/* Settle `n` players inland and as far apart as the board allows, so neither the board
   rim nor a neighbour's blocked perimeter skews what follows. */
function seedTowns(n) {
  const b = G.game.board;
  const inland = t => t.col > 1 && t.row > 1 && t.col < b.cols - 2 && t.row < b.rows - 2;
  for (let p = 0; p < n; p++) {
    const opts = b.tiles.filter(t => G.legalTown(t) && inland(t));
    const placed = [...G.game.towns.keys()].map(id => b.tiles[id]);
    const pick = placed.length
      ? opts.reduce((best, t) => {
          const d = Math.min(...placed.map(o => hexDist(t, o)));
          return d > best.d ? { t, d } : best;
        }, { t: opts[0], d: -1 }).t
      : opts[Math.floor(opts.length / 2)];
    G.placeTown(pick);
  }
}

/* ---- edge graph: roads on land, bridges on water, oceans crossable ---- */
section("edge graph");
{
  const b = generateBoard("halcyon", 13, 15);
  const water = t => TERRAIN[b.tiles[t].terrain].water;

  check("every interior edge borders exactly 2 tiles", b.edges.every(e => e.tiles.length === 2));
  check("edge type follows terrain", b.edges.every(e => e.water === e.tiles.some(water)));
  check("open-ocean edges are kept", b.edges.some(e => e.tiles.every(water)),
    "bridges must be able to island-hop");
  check("slot counts partition the graph", b.roadSlots + b.bridgeSlots === b.edges.length);
  check("every tile has 6 corners", b.corners.length === b.tiles.length
    && b.corners.every(c => c.length === 6));
  check("corners index real vertices", b.corners.flat().every(v => b.verts[v]));
  check("edges are deterministic",
    JSON.stringify(generateBoard("halcyon", 13, 15).edges) === JSON.stringify(b.edges));
}

/* ---- building: cost, connectivity, and the perimeter a town blocks ---- */
section("building");
{
  G.setBoard(generateBoard("halcyon", 13, 15));
  G.setPlayers(2);
  G.startGame();
  /* A rim town has fewer than 6 ways out, because the edges radiating off the board
     border only one tile and are not part of the graph. Settle inland to test the full six. */
  seedTowns(2);

  const b = G.game.board, me = G.game.current, home = G.townsOf(me)[0];

  check("nothing is buildable before rolling", G.canBuild() === false);
  G.rollDice(() => 0.01);
  check("build window opens after rolling", G.canBuild() === true);

  const net = G.networkVerts(me);
  check("a town contributes its 6 corners", net.size === 6);
  check("a town blocks its own perimeter",
    G.tileEdges(home).every(id => G.legalEdge(me, id) === false));

  /* 6 corners, each with one edge radiating away from the town */
  G.game.hands[me].ore = 99; G.game.hands[me].wood = 99;
  const open = b.edges.filter(e => G.legalEdge(me, e.id));
  check("a town has exactly 6 ways out", open.length === 6, `got ${open.length}`);

  const first = open[0];
  check("cost matches edge type", JSON.stringify(G.edgeCost(first))
    === JSON.stringify(first.water ? COSTS.bridge : COSTS.road));
  const ore = G.game.hands[me].ore, wood = G.game.hands[me].wood;
  check("building succeeds", G.buildEdge(first.id) === true);
  check("cost is deducted", first.water ? G.game.hands[me].wood === wood - 2
                                        : G.game.hands[me].ore === ore - 2);
  check("edge is occupied once only", G.buildEdge(first.id) === false);
  check("network grew past the new edge", G.networkVerts(me).size === 7);

  /* poverty must block, even when the geometry is fine */
  G.game.hands[me].ore = 0; G.game.hands[me].wood = 0;
  check("cannot build without resources",
    b.edges.every(e => G.legalEdge(me, e.id) === false));

  /* an unconnected edge is never legal, however rich you are */
  G.game.hands[me].ore = 99; G.game.hands[me].wood = 99;
  const reach = G.networkVerts(me);
  check("disconnected edges stay illegal", b.edges
    .filter(e => !reach.has(e.a) && !reach.has(e.b))
    .every(e => G.legalEdge(me, e.id) === false));
}

/* ---- founding a town needs reach, spacing, and the full cost ---- */
section("expansion");
{
  G.setBoard(generateBoard("halcyon", 13, 15));
  G.setPlayers(2);
  G.startGame();
  seedTowns(2);
  G.rollDice(() => 0.01);

  const b = G.game.board, me = G.game.current, home = G.townsOf(me)[0];
  DIE_FACES.forEach(f => G.game.hands[me][f] = 99);

  /* A lone town reaches only its own tile and its 6 neighbours, all of which fail the
     spacing rule — so nothing is settleable until roads carry the network outward. */
  check("a lone town can reach nowhere", b.tiles.every(t => G.legalExpansion(me, t) === false));

  let builds = 0;
  while (builds < 8 && !b.tiles.some(t => G.legalExpansion(me, t))) {
    const e = b.edges.find(x => G.legalEdge(me, x.id));
    if (!e) break;
    G.buildEdge(e.id); builds++;
  }
  const sites = b.tiles.filter(t => G.legalExpansion(me, t));
  check("roads open up a town site", sites.length > 0, `after ${builds} builds`);
  check("a site is at least 2 tiles out", sites.every(t => hexDist(t, home) >= RULES.MIN_TOWN_GAP));
  check("reachable tiles touch the network", sites.every(t =>
    b.corners[t.id].some(c => G.networkVerts(me).has(c))));
  check("reachable tiles respect the gap", sites.every(t =>
    [...G.game.towns.keys()].every(id => hexDist(t, b.tiles[id]) >= RULES.MIN_TOWN_GAP)));
  check("no town on water", sites.every(settleable));

  const before = G.game.towns.size;
  const cost = { ...G.game.hands[me] };
  check("founding succeeds", G.buildTown(sites[0]) === true);
  check("town is recorded", G.game.towns.size === before + 1 && G.game.towns.get(sites[0].id) === me);
  check("full cost is paid", Object.entries(COSTS.town)
    .every(([k, n]) => G.game.hands[me][k] === cost[k] - n),
    JSON.stringify(COSTS.town));
  check("a second town doubles income", G.yieldOf(me, "wood") === 2);

  /* an unreachable-but-legal tile must still be refused */
  const far = b.tiles.find(t => G.legalTown(t) && !G.legalExpansion(me, t));
  if (far) check("unreachable tiles are refused", G.buildTown(far) === false);

  /* and poverty blocks founding outright */
  DIE_FACES.forEach(f => G.game.hands[me][f] = 0);
  check("cannot found a town while broke", b.tiles.every(t => G.legalExpansion(me, t) === false));
}

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
