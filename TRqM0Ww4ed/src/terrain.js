/* The terrain table and the predicates that read it.
   `kind` drives road passability; `water` additionally forbids towns. */

export const TERRAIN = {
  wood:     { label: "Wood",     color: "var(--wood)",     ink: "#CBE0CC", kind: "resource" },
  wheat:    { label: "Wheat",    color: "var(--wheat)",    ink: "#4A3708", kind: "resource" },
  wool:     { label: "Wool",     color: "var(--wool)",     ink: "#3A4636", kind: "resource" },
  ore:      { label: "Ore",      color: "var(--ore)",      ink: "#212D38", kind: "resource" },
  fish:     { label: "Fish",     color: "var(--fish)",     ink: "#8FCBD8", kind: "resource", water: true },
  desert:   { label: "Desert",   color: "var(--desert)",   ink: "#5A4520", kind: "barren" },
  plain:    { label: "Plain",    color: "var(--plain)",    ink: "#DDE6CE", kind: "barren" },
  mountain: { label: "Mountain", color: "var(--mountain)", ink: "#C3CCD6", kind: "barren" },
  sea:      { label: "Sea",      color: "var(--sea)",      ink: "#1D5069", kind: "blocked", water: true },
};

/* The wild is a die face, not a terrain — no tile ever carries it. */
export const WILD_FACE = { label: "Wild", color: "var(--brass)", ink: "#12202B", kind: "wild" };
export const faceSpec  = f => TERRAIN[f] || WILD_FACE;

export const spec       = t => TERRAIN[t.terrain];
export const isWater    = t => !!spec(t).water;
export const isBlocked  = t => spec(t).kind === "blocked";
export const isResource = t => spec(t).kind === "resource";
export const passable   = t => !isBlocked(t);              // roads may cross shallows
export const settleable = t => passable(t) && !isWater(t); // towns may not
