/* Board geometry, board sizes, players, and every generation constant.
   Tune the map here; nothing else in the codebase hard-codes these numbers. */

export const S = 15;                       // hex radius in SVG units

export const BOARD_SIZES = [
  { id: "11,13", label: "Small — 11 x 13 (143 tiles)",    cols: 11, rows: 13 },
  { id: "13,15", label: "Standard — 13 x 15 (195 tiles)", cols: 13, rows: 15, default: true },
  { id: "15,17", label: "Large — 15 x 17 (255 tiles)",    cols: 15, rows: 17 },
  { id: "17,20", label: "Huge — 17 x 20 (340 tiles)",     cols: 17, rows: 20 },
];

export const DIE_FACES = ["wood", "deer", "wheat", "wool", "ore", "fish"];

export const PLAYERS = [
  { name: "Crimson", color: "#D6453F" },
  { name: "Azure",   color: "#4A9BD1" },
  { name: "Gold",    color: "#EFC050" },
  { name: "Violet",  color: "#9B6BC4" },
  { name: "Jade",    color: "#46C08A" },
  { name: "Bone",    color: "#E8EDF0" },
];

/* Map generation. */
export const TUNING = {
  islands:    10,   // number of separate landmasses
  water:      34,   // % of board that ends up ocean + shallows
  evenness:   55,   // 100 = islands all the same size, 0 = one continent + scraps
  roughness:  35,   // 0 = smooth blobs, 100 = ragged fjords
  barren:     12,   // % of land with no resource
  grain:       5,   // resource region size: low = few big provinces, high = many small
  scatter:    15,   // 0 = pure geography, 100 = shuffled bag
  mixing:     70,   // strength of the de-clumping pass (counts always preserved)
  clumpMax:    2,   // same-terrain neighbours a tile may keep before de-clumping touches it
  barrenMix:  { mountain: 5, plain: 3, desert: 2 },
  edgeFrame:   0,   // rings of forced ocean around the board (0 = land may reach the edge)
};

/* Placement rules. Set a minimum to 1 to disable it. */
export const RULES = {
  MIN_TOWN_GAP:  2,   // no two towns within this many tiles
  MIN_FOOTPRINT: 1,   // own tile + ring must be at least this many tiles
  MIN_VARIETY:   1,   // ...covering at least this many distinct resources
};
