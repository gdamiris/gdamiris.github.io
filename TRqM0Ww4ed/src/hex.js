/* Pointy-top hexes on an odd-r offset grid: odd rows are shifted half a hex right.
   Tile ids are row-major, so id === row * cols + col. */

import { S } from "./config.js";

export const NB = [
  [[+1, 0], [0, -1], [-1, -1], [-1, 0], [-1, +1], [0, +1]],  // even rows
  [[+1, 0], [+1, -1], [0, -1], [-1, 0], [0, +1], [+1, +1]],  // odd rows
];

export const px = (col, row) => [S * Math.sqrt(3) * (col + 0.5 * (row & 1)), S * 1.5 * row];

export const corner = (col, row, i) => {
  const [x, y] = px(col, row), a = (Math.PI / 180) * (60 * i - 30);
  return [x + S * Math.cos(a), y + S * Math.sin(a)];
};

export const hexPoints = (col, row) =>
  [0, 1, 2, 3, 4, 5].map(i => corner(col, row, i).map(v => v.toFixed(1)).join(",")).join(" ");

export const axial = t => [t.col - ((t.row - (t.row & 1)) / 2), t.row];

export const hexDist = (a, b) => {
  const [q1, r1] = axial(a), [q2, r2] = axial(b), dq = q1 - q2, dr = r1 - r2;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
};

export const tileAt = (board, c, r) =>
  (c < 0 || r < 0 || c >= board.cols || r >= board.rows) ? null : board.tiles[r * board.cols + c];

export const neighbours = (board, t) =>
  NB[t.row & 1].map(([dc, dr]) => tileAt(board, t.col + dc, t.row + dr)).filter(Boolean);

/* ---------- line of sight ---------- */

/* Cube coordinates, which are what you need to walk a straight line between two hexes. */
const cube = t => { const [q, r] = axial(t); return [q, -q - r, r]; };

const cubeRound = (x, y, z) => {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return [rx, ry, rz];
};

const fromCube = (board, [q, , r]) => tileAt(board, q + ((r - (r & 1)) / 2), r);

/* The tiles a shot passes THROUGH on its way from a to b — both ends excluded, since
   you may fire from a mountain and at something standing on one.

   A line between two hex centres can run exactly along the seam between two tiles, and
   then there is no single honest answer for which one it crosses. `nudge` leans the line
   a hair to one side so the rounding is decided rather than arbitrary; callers check both
   leanings and take the clear one, so a shot is only blocked when EVERY way of drawing
   the line runs into the obstacle. */
export function hexLine(board, a, b, nudge = 1e-6) {
  const n = hexDist(a, b);
  if (n < 2) return [];
  const [ax, ay, az] = cube(a), [bx, by, bz] = cube(b);
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const tile = fromCube(board, cubeRound(
      ax + (bx - ax + nudge) * t,
      ay + (by - ay - nudge * 2) * t,
      az + (bz - az + nudge) * t));
    if (tile && tile !== a && tile !== b) out.push(tile);
  }
  return out;
}
