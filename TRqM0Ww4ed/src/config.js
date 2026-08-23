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
  /* Islands may never touch, so every extra island costs a ring of forced ocean. That
     makes `islands` the real control over the land/sea split: `water` only bites once
     its quota falls below what the island layout would have produced anyway. At 8
     islands the two are balanced, and a 13x15 board lands on ~36 sea tiles. */
  islands:     8,   // number of separate landmasses
  water:      28,   // % of board that ends up ocean + shallows (an upper bound on land)
  evenness:   55,   // 100 = islands all the same size, 0 = one continent + scraps
  roughness:  35,   // 0 = smooth blobs, 100 = ragged fjords
  resourcePct: 10,  // % of the whole board each of the five resources gets
                    // barren is whatever land is left after that
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
  wall:   { ore: 2, wood: 2 },
};

/* Walls go up around a town you already hold. Infantry cannot touch them and cannot
   reach what shelters behind them — only siege weapons can, and they must batter the
   wall down first. Masonry is rebuilt a course at a time: one life per turn, no more. */
export const WALL = {
  lives: 4,
  repair: { ore: 1 },               // 1 ore buys back 1 life, once per wall per turn
  breachedBy: ["cannon", "boat"],
};

/* Movement is counted in half-tiles so terrain can be faster as well as slower without
   ever being free: entering an ordinary tile costs STEP, and a unit's `move` is its
   budget in the same units. Nothing costing zero means a unit's range always has a
   ceiling, whatever the map looks like. */
export const STEP = 2;

/* What the barren ground does to an army crossing it. `cost` overrides STEP, per unit
   kind; `toll` is paid by the owner for every such tile a unit enters, whatever the
   unit. Anything not listed costs STEP and nothing else. */
export const TERRAIN_MOVE = {
  mountain: { cost: { horse: 2 * STEP } },   // broken ground: cavalry at half speed
  plain:    { cost: { horse: STEP / 2 } },   // open going: cavalry at double speed
  desert:   { toll: { fish: 1 } },           // every unit needs water to cross
};

/* Units. `either` is a choice of one resource from the list, on top of `cost`.
   Every attack deals exactly 1 damage whatever the attacker is.

   `domain`  where the unit may stand: land units never touch water, boats never touch land.
   `range`   [min, max] distance in tiles it may strike, or null for a civilian that
             cannot fight at all. A boat's [2, 2] means it cannot hit anything adjacent,
             which is exactly what makes closing on it the counter.
   `perTown` a cap: at most this many of the kind per town the player holds.
   `trades`  standing on a resource tile adds 1 to that resource whenever it is rolled. */
export const UNITS = {
  foot:  { label: "Foot soldier", short: "F", move: STEP, lives: 2, domain: "land", range: [1, 1],
           cost: { wool: 1, wood: 1 }, either: null, home: "town" },
  horse: { label: "Horseman",     short: "H", move: 2 * STEP, lives: 2, domain: "land", range: [1, 1],
           cost: { wool: 2, wood: 1 }, either: null, home: "town" },
  /* The merchant is the whole economy: production is otherwise flat at 1 per roll, and
     a merchant parked on a resource tile adds 1 more of it. Civilians cannot fight, die
     to a single hit, and are capped at one per town — so income is bought with territory
     you have to defend rather than compounding on its own. */
  merchant:{ label: "Merchant",   short: "M", move: STEP, lives: 1, domain: "land", range: null,
           cost: { wool: 1, wheat: 1, fish: 1 }, either: null, home: "town",
           perTown: 1, trades: true },
  /* Artillery: outranges everything but cannot fire close in, so it needs infantry to
     screen it. Damage is permanent — a cannon has no way to repair — but a wounded one
     can still be pulled back, unlike a wounded soldier. */
  cannon:{ label: "Cannon",       short: "C", move: STEP, lives: 2, domain: "land",  range: [2, 3],
           cost: { ore: 2 }, either: null, home: "town",
           movesInjured: true, noRevive: true },
  /* Boats launch from a port and must return to one to recover. They keep moving while
     injured — rooting them would make reaching a port impossible. */
  boat:  { label: "Boat",         short: "B", move: 2 * STEP, lives: 2, domain: "water", range: [2, 2],
           cost: { wood: 2, wool: 1, ore: 1 }, either: null, home: "port",
           movesInjured: true, reviveAtPort: true },
};

/* Placement rules. Set a minimum to 1 to disable it. */
export const RULES = {
  MIN_TOWN_GAP:  2,   // no two towns within this many tiles
  MIN_FOOTPRINT: 1,   // own tile + ring must be at least this many tiles
  MIN_VARIETY:   1,   // ...covering at least this many distinct resources
};
