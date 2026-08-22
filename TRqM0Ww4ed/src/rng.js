/* Deterministic randomness. Every map is a pure function of its seed string,
   so peers only need to exchange the seed to derive an identical board. */

export const hash = str => {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

export const mulberry32 = a => () => {
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

export const smooth = t => t * t * (3 - 2 * t);
export const lerp = (a, b, t) => a + (b - a) * t;

/* Value noise on a g x g lattice, bilinear with smoothstep easing. */
export function noiseField(rng, g) {
  const L = [];
  for (let y = 0; y <= g; y++) { L.push([]); for (let x = 0; x <= g; x++) L[y].push(rng()); }
  return (u, v) => {
    const x = u * g, y = v * g;
    const x0 = Math.min(Math.floor(x), g - 1), y0 = Math.min(Math.floor(y), g - 1);
    const tx = smooth(x - x0), ty = smooth(y - y0);
    return lerp(lerp(L[y0][x0], L[y0][x0 + 1], tx), lerp(L[y0 + 1][x0], L[y0 + 1][x0 + 1], tx), ty);
  };
}

/* Three octaves, weighted toward the base frequency. */
export const octaves = (rng, base) => {
  const a = noiseField(rng, base), b = noiseField(rng, base * 2), c = noiseField(rng, base * 4);
  return (u, v) => 0.60 * a(u, v) + 0.28 * b(u, v) + 0.12 * c(u, v);
};
