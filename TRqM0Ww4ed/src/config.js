/* Board geometry, board sizes, players, and every generation constant.
   Tune the map here; nothing else in the codebase hard-codes these numbers. */

export const S = 15;                       // hex radius in SVG units

export const BOARD_SIZES = [
  { id: "11,13", label: "Small — 11 x 13 (143 tiles)",    cols: 11, rows: 13 },
  { id: "13,15", label: "Standard — 13 x 15 (195 tiles)", cols: 13, rows: 15, default: true },
  { id: "15,17", label: "Large — 15 x 17 (255 tiles)",    cols: 15, rows: 17 },
  { id: "17,20", label: "Huge — 17 x 20 (340 tiles)",     cols: 17, rows: 20 },
];

/* Five resources a player can hold, and a sixth die face that is none of them: the wild.
   A wild is never held — whoever it pays picks a real resource instead, and the roller
   always does the picking, for themselves and for the table. */
export const RESOURCES = ["wood", "wheat", "wool", "ore", "fish"];
export const WILD = "wild";
export const DIE_FACES = [...RESOURCES, WILD];

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

/* What things cost. Edge type is decided by terrain, not by the player: an edge touching
   sea or fish is a bridge, anything else is a road. */
export const COSTS = {
  road:   { ore: 2 },
  bridge: { wood: 2 },
  town:   { wheat: 1, ore: 1, wood: 1, fish: 1 },
  port:   { wood: 2, ore: 1, wheat: 1 },
  revive: { fish: 1 },      // patching up any unit costs a fish
};

/* Units. `either` is a choice of one resource from the list, on top of `cost`.
   Every attack deals exactly 1 damage whatever the attacker is.

   `domain`  where the unit may stand: land units never touch water, boats never touch land.
   `range`   [min, max] distance in tiles it may strike. A boat's [2, 2] means it cannot
             hit anything adjacent, which is exactly what makes closing on it the counter.
   Roads and bridges do not carry armies, so on land each island is its own theatre. */
export const UNITS = {
  foot:  { label: "Foot soldier", short: "F", move: 1, lives: 2, domain: "land", range: [1, 1],
           cost: { wool: 1, wood: 1 }, either: null, home: "town" },
  horse: { label: "Horseman",     short: "H", move: 2, lives: 2, domain: "land", range: [1, 1],
           cost: { wool: 2, wood: 1 }, either: null, home: "town" },
  /* Artillery: outranges everything but cannot fire close in, so it needs infantry to
     screen it. Damage is permanent — a cannon has no way to repair — but a wounded one
     can still be pulled back, unlike a wounded soldier. */
  cannon:{ label: "Cannon",       short: "C", move: 1, lives: 2, domain: "land",  range: [2, 3],
           cost: { ore: 2 }, either: null, home: "town",
           movesInjured: true, noRevive: true },
  /* Boats launch from a port and must return to one to recover. They keep moving while
     injured — rooting them would make reaching a port impossible. */
  boat:  { label: "Boat",         short: "B", move: 2, lives: 2, domain: "water", range: [2, 2],
           cost: { wood: 2, wool: 1, ore: 1 }, either: null, home: "port",
           movesInjured: true, reviveAtPort: true },
};

/* Placement rules. Set a minimum to 1 to disable it. */
export const RULES = {
  MIN_TOWN_GAP:  2,   // no two towns within this many tiles
  MIN_FOOTPRINT: 1,   // own tile + ring must be at least this many tiles
  MIN_VARIETY:   1,   // ...covering at least this many distinct resources
};
