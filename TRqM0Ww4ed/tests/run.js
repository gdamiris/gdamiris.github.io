/* Headless checks over the pure modules. No DOM, no browser.
   Run with: node tests/run.js */

import { DIE_FACES, TUNING, RULES } from "../src/config.js";
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
  check("roller still advances on doubles", G.game.current === (who + 1) % 3);
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

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
process.exit(failures ? 1 : 0);
