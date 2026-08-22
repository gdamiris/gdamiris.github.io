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
