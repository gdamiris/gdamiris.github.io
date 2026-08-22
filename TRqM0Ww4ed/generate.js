/* Map generation.

   Land is grown, not carved: N island seeds are placed by farthest-point sampling and
   expanded by best-first growth into a noise cost field. Islands may never claim a tile
   adjacent to another island, which is what guarantees the requested island count and
   leaves the ocean as a single connected complement.

   Resources are then assigned by percentile bands so every resource gets an identical
   tile count, and a de-clumping pass swaps labels (a pure permutation, counts untouched)
   to break up monocultures while leaving small groves intact. */

import { TUNING, DIE_FACES } from "./config.js";
import { TERRAIN, passable, settleable } from "./terrain.js";
import { hash, mulberry32, lerp, octaves } from "./rng.js";
import { NB, px, corner, hexDist } from "./hex.js";

const BARREN_ORDER = ["mountain", "plain", "desert"];

export function generateBoard(seed, cols, rows, tuning = TUNING) {
  const T = tuning, rng = mulberry32(hash(seed));
  const shape = octaves(rng, 4);                       // island silhouette
  const g = Math.max(2, T.grain);
  const relief = octaves(rng, g), moist = octaves(rng, g), game = octaves(rng, g);
  const j = T.scatter / 100, blend = (f, r) => f * (1 - j) + r * j;

  const tiles = [], grid = [];
  for (let row = 0; row < rows; row++) {
    grid.push([]);
    for (let col = 0; col < cols; col++) {
      const u = (col + 0.5 * (row & 1)) / cols, v = row / (rows - 1), [x, y] = px(col, row);
      const t = {
        id: tiles.length, col, row, x, y, s: shape(u, v),
        e: blend(relief(u, v), rng()), m: blend(moist(u, v), rng()), g: blend(game(u, v), rng()),
        island: -1, terrain: null,
      };
      grid[row].push(t); tiles.push(t);
    }
  }
  const at = (c, r) => (r < 0 || r >= rows || c < 0 || c >= cols) ? null : grid[r][c];
  const nbrs = t => NB[t.row & 1].map(([dc, dr]) => at(t.col + dc, t.row + dr)).filter(Boolean);
  const margin = m => t => t.col >= m && t.col < cols - m && t.row >= m && t.row < rows - m;
  const inner = margin(T.edgeFrame);

  /* --- island seeds, spread as far apart as the board allows --- */
  const N = Math.max(1, Math.min(T.islands, 24));
  const pool = tiles.filter(margin(T.edgeFrame + 1));
  const seeds = [pool[Math.floor(rng() * pool.length)]];
  while (seeds.length < N) {
    let best = null, bestD = -1;
    for (const t of pool) {
      const d = Math.min(...seeds.map(s => hexDist(t, s)));
      if (d > bestD) { bestD = d; best = t; }
    }
    if (!best || bestD < 2) break;
    seeds.push(best);
  }

  /* --- island size targets --- */
  const landQuota = Math.min(pool.length, Math.round(tiles.length * (1 - T.water / 100)));
  const ev = T.evenness / 100;
  const w = seeds.map(() => lerp(0.25 + rng() * 1.5, 1, ev));
  const wSum = w.reduce((a, b) => a + b, 0);
  const target = w.map(x => Math.max(3, Math.round(landQuota * x / wSum)));

  /* --- organic growth, round robin, islands may never touch --- */
  const rough = T.roughness / 100;
  const cost = t => lerp(t.s, rng(), rough);
  const frontiers = seeds.map(() => new Map());
  const size = seeds.map(() => 0);
  seeds.forEach((s, i) => { if (s) frontiers[i].set(s, 0); });
  const claim = (t, i) => {
    t.island = i; size[i]++;
    for (const n of nbrs(t)) if (n.island === -1 && inner(n) && !frontiers[i].has(n)) frontiers[i].set(n, cost(n));
  };

  let live = true;
  while (live) {
    live = false;
    for (let i = 0; i < seeds.length; i++) {
      if (size[i] >= target[i] || frontiers[i].size === 0) continue;
      let pick = null, best = Infinity;
      for (const [t, c] of frontiers[i]) {
        if (t.island !== -1 || nbrs(t).some(n => n.island !== -1 && n.island !== i)) { frontiers[i].delete(t); continue; }
        if (c < best) { best = c; pick = t; }
      }
      if (!pick) continue;
      frontiers[i].delete(pick); claim(pick, i); live = true;
    }
    if (!live) {   // hand unused quota to whoever can still grow
      const short = size.reduce((a, b, i) => a + Math.max(0, target[i] - b), 0);
      const grower = seeds.map((_, i) => i).filter(i => frontiers[i].size > 0 && size[i] >= target[i]);
      if (short > 0 && grower.length) { grower.forEach(i => target[i] += Math.ceil(short / grower.length)); live = true; }
    }
  }

  const land = tiles.filter(t => t.island >= 0);
  tiles.filter(t => t.island < 0).forEach(t => t.terrain = "sea");

  /* --- equal-share resources --- */
  const bTot = Object.values(T.barrenMix).reduce((a, b) => a + b, 0) || 1;
  let barrenN = Math.min(land.length, Math.round(land.length * T.barren / 100));
  const per = Math.max(0, Math.floor((land.length - barrenN) / 5));
  barrenN = land.length - per * 5;                      // remainder absorbed by barren
  const need = {}; let used = 0;
  BARREN_ORDER.forEach((k, i) => {
    need[k] = i === BARREN_ORDER.length - 1 ? barrenN - used
            : Math.round(barrenN * (T.barrenMix[k] || 0) / bTot);
    used += need[k];
  });

  const byHigh = land.slice().sort((a, b) => b.e - a.e);
  byHigh.slice(0, need.mountain).forEach(t => t.terrain = "mountain");
  byHigh.slice(need.mountain, need.mountain + per).forEach(t => t.terrain = "ore");

  const rest = land.filter(t => !t.terrain).sort((a, b) => a.m - b.m);
  let i = 0;
  for (const [k, n] of [["desert", need.desert], ["plain", need.plain], ["wool", per], ["wheat", per]]) {
    rest.slice(i, i + n).forEach(t => t.terrain = k); i += n;
  }
  const wet = rest.slice(i).sort((a, b) => b.g - a.g);
  wet.slice(0, per).forEach(t => t.terrain = "deer");
  wet.slice(per).forEach(t => t.terrain = "wood");

  /* --- de-clump: only excess adjacency is penalised, so groves survive --- */
  if (T.mixing > 0) {
    const rpool = land.filter(t => TERRAIN[t.terrain].kind === "resource");
    const excess = t => Math.max(0, nbrs(t).filter(n => n.terrain === t.terrain).length - T.clumpMax);
    const iters = Math.round(rpool.length * T.mixing * 0.9);
    for (let k = 0; k < iters; k++) {
      const a = rpool[Math.floor(rng() * rpool.length)], b = rpool[Math.floor(rng() * rpool.length)];
      if (a === b || a.terrain === b.terrain) continue;
      const ring = [a, b, ...nbrs(a), ...nbrs(b)];
      const before = ring.reduce((x, t) => x + excess(t), 0);
      const ta = a.terrain, tb = b.terrain; a.terrain = tb; b.terrain = ta;
      if (ring.reduce((x, t) => x + excess(t), 0) >= before) { a.terrain = ta; b.terrain = tb; }
    }
  }

  /* --- fish: shallows in the tightest bays, same count as every other resource --- */
  tiles.filter(t => t.terrain === "sea")
       .map(t => ({ t, touch: nbrs(t).filter(n => n.island >= 0).length }))
       .filter(o => o.touch > 0)
       .sort((a, b) => b.touch - a.touch || a.t.s - b.t.s)
       .slice(0, per).forEach(o => o.t.terrain = "fish");

  /* --- edge graph: roads live between tiles --- */
  const verts = new Map(), edges = new Map();
  for (const t of tiles) {
    const ids = [0, 1, 2, 3, 4, 5].map(n => {
      const [x, y] = corner(t.col, t.row, n), k = `${Math.round(x * 10) / 10}:${Math.round(y * 10) / 10}`;
      if (!verts.has(k)) verts.set(k, verts.size);
      return verts.get(k);
    });
    for (let n = 0; n < 6; n++) {
      const [a, b] = [ids[n], ids[(n + 1) % 6]].sort((p, q) => p - q), k = `${a}-${b}`;
      if (!edges.has(k)) edges.set(k, { a, b, tiles: [] });
      edges.get(k).tiles.push(t.id);
    }
  }
  const roads = [...edges.values()].filter(e => e.tiles.length === 2 && e.tiles.every(n => passable(tiles[n])));
  const sizes = size.filter(n => n > 0).sort((a, b) => b - a);

  tiles.forEach(t => { delete t.e; delete t.m; delete t.g; delete t.s; });
  return {
    seed, cols, rows, islands: N, tuning: { ...T }, tiles, per, sizes,
    roadSlots: roads.length, buildable: tiles.filter(settleable).length,
  };
}

export const tileCounts = board => {
  const c = {};
  for (const t of board.tiles) c[t.terrain] = (c[t.terrain] || 0) + 1;
  return c;
};

export const deadFaces = board => {
  const c = tileCounts(board);
  return DIE_FACES.filter(f => !c[f]);
};
