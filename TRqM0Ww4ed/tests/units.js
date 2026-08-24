/* Unit rules: recruiting, the action economy, movement, damage and revival.
   Run with: node tests/units.js

   The action economy is the fiddly part — a foot soldier moves OR acts, a horseman may
   spend one of its two steps and still attack, and a unit recruited this turn may march
   but not strike. Anything that can move at all can always move, wounded or fresh. */

import { RESOURCES, UNITS, COSTS, WALL, STEP, RULES, SCORE } from "../src/config.js";
import { settleable, isWater } from "../src/terrain.js";
import { hexDist } from "../src/hex.js";
import { generateBoard } from "../src/generate.js";
import * as G from "../src/game.js";

let failures = 0, total = 0;
const check = (name, cond, detail = "") => {
  total++;
  if (!cond) { failures++; console.log("  FAIL", name, detail); }
};
const section = name => console.log("\n" + name);

/* ---------- fixtures ---------- */

/* Play out the whole snake draft: every player founds TOWNS_AT_START towns, inland and
   as far apart as the board allows. */
function seedTowns(prefer = null) {
  const b = G.game.board;
  const inland = t => t.col > 1 && t.row > 1 && t.col < b.cols - 2 && t.row < b.rows - 2;
  for (let p = 0; p < G.townsToPlace(); p++) {
    const all = b.tiles.filter(t => G.legalTown(t) && inland(t));
    /* some fixtures need towns on ground that actually produces something */
    const liked = prefer ? all.filter(prefer) : [];
    const opts = liked.length ? liked : all;
    const placed = [...G.game.towns.keys()].map(id => b.tiles[id]);
    G.placeTown(placed.length
      ? opts.reduce((best, t) => {
          const d = Math.min(...placed.map(o => hexDist(t, o)));
          return d > best.d ? { t, d } : best;
        }, { t: opts[0], d: -1 }).t
      : opts[Math.floor(opts.length / 2)]);
  }
  seatKings();
}

/* Kings are seated after the draft, one per player, each in their first town. */
function seatKings() {
  while (G.game.phase === "crowning") G.seatKing(G.townsOf(G.game.turn)[0]);
}

const DOUBLES = () => 0.01;
const rich = (pi, v = 99) => RESOURCES.forEach(f => G.game.hands[pi][f] = v);
const hand = pi => ({ ...G.game.hands[pi] });

function fresh(n = 2, prefer = null) {
  G.setBoard(generateBoard("halcyon", 13, 15));
  G.setPlayers(n);
  G.startGame();
  seedTowns(prefer);
  G.rollDice(DOUBLES);
  return G.game.board;
}

/* Recruit and then hand the unit a full turn: a fresh unit may march but not strike, so
   clearing `fresh` is what makes it a veteran for the purposes of a fixture. */
function ready(kind, tile) {
  /* a town does one job a turn now; fixtures muster freely and the rule is tested alone */
  G.game.busy.delete(tile.id);
  const id = G.recruit(kind, tile);
  const u = G.game.units.get(id);
  u.moved = 0; u.acted = false; u.fresh = false;
  return u;
}

/* Drop a unit straight onto a tile, bypassing recruitment, for combat fixtures. */
function place(owner, kind, tile) {
  const id = G.game.nextUnit++;
  const u = { id, owner, kind, tile: tile.id, lives: UNITS[kind].lives,
              moved: 0, acted: false, fresh: false };
  G.game.units.set(id, u);
  return u;
}

const landNear = (t, pred = () => true) =>
  G.around(t).find(n => settleable(n) && !G.unitAt(n.id) && !G.game.towns.has(n.id) && pred(n));

/* ---------- recruiting ---------- */
section("recruiting");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];

  check("cannot afford a unit while broke", G.canAffordUnit(me, "foot") === false);

  /* armies eat: a foot soldier is rations, a horseman is fodder */
  G.game.hands[me] = { wood: 0, wool: 1, fish: 1, wheat: 0, ore: 0 };
  check("wool and fish alone buy a foot soldier", G.canAffordUnit(me, "foot") === true);
  check("no wood is needed", G.game.hands[me].wood === 0);
  check("deer is gone from the game", RESOURCES.includes("deer") === false
    && !("deer" in G.blankHand()));
  G.game.hands[me] = { wood: 9, wool: 1, fish: 0, wheat: 9, ore: 9 };
  check("missing fish blocks a foot soldier", G.canAffordUnit(me, "foot") === false);
  G.game.hands[me] = { wood: 9, wool: 0, fish: 9, wheat: 9, ore: 9 };
  check("missing wool blocks it", G.canAffordUnit(me, "foot") === false);
  G.game.hands[me] = { wood: 0, wool: 1, fish: 0, wheat: 1, ore: 0 };
  check("1 wool is not enough for a horseman", G.canAffordUnit(me, "horse") === false);
  G.game.hands[me].wool = 2;
  check("2 wool and a wheat buy a horseman", G.canAffordUnit(me, "horse") === true);
  G.game.hands[me].wheat = 0;
  check("a horseman without fodder is refused", G.canAffordUnit(me, "horse") === false);

  rich(me);
  const before = hand(me);
  const id = G.recruit("foot", home);
  check("recruiting returns a unit id", typeof id === "number");
  const u = G.game.units.get(id);
  check("the unit stands on the town", u.tile === home.id);
  check("the unit belongs to the recruiter", u.owner === me);
  check("the unit starts at full lives", u.lives === UNITS.foot.lives && !G.injured(u));
  check("wool and fish are spent",
    G.game.hands[me].wool === before.wool - 1 && G.game.hands[me].fish === before.fish - 1);
  check("nothing else is spent on infantry",
    RESOURCES.filter(f => f !== "wool" && f !== "fish")
      .every(f => G.game.hands[me][f] === before[f]));

  /* a fresh unit may march off the tile it was born on, but not strike from it —
     rooting it let a cannon outside retaliation range lock the town forever */
  check("a fresh unit may move at once", G.canMove(u) === true);
  check("but cannot attack until next turn", G.canAttack(u) === false);
  check("it is flagged fresh", u.fresh === true);
  check("one unit to a tile", G.legalRecruit(me, "foot", home) === false);
  check("cannot recruit on an opponent's town", (() => {
    const theirs = [...G.game.towns].find(([, o]) => o !== me);
    return G.legalRecruit(me, "foot", b.tiles[theirs[0]]) === false;
  })());
  check("cannot recruit on open ground",
    G.legalRecruit(me, "foot", b.tiles.find(t => settleable(t) && !G.game.towns.has(t.id))) === false);

  /* the whole point of the change: it can leave the tile it was born on, this turn */
  check("escaping the spawn tile works", (() => {
    const out = [...G.reachable(u).keys()];
    return out.length > 0 && G.moveUnit(u.id, out[0]) === true && u.tile !== home.id;
  })());
  check("and still cannot attack after marching", G.canAttack(u) === false);

  G.endTurn();
  check("cannot recruit outside the build window", G.recruit("foot", home) === false);
}

/* ---------- movement ---------- */
section("movement");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);

  const foot = ready("foot", home);
  const reach = G.reachable(foot);
  /* movement is counted in points: an ordinary tile costs STEP */
  check("a foot soldier reaches 1 tile", [...reach.values()].every(s => s === STEP));
  check("it reaches only neighbours",
    [...reach.keys()].every(id => G.around(home).some(n => n.id === id)));
  check("it never reaches water",
    [...reach.keys()].every(id => !isWater(b.tiles[id])));

  const dest = [...reach.keys()][0];
  check("the move succeeds", G.moveUnit(foot.id, dest) === true);
  check("the unit is on the new tile", foot.tile === dest && G.unitAt(dest) === foot);
  check("the old tile is free", G.unitAt(home.id) === null);
  check("a spent foot soldier cannot move again", G.canMove(foot) === false);
  check("a foot soldier that moved cannot attack", G.canAttack(foot) === false);

  /* horsemen get two steps, and may spend one and still attack */
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check("back to the same player", G.game.current === me);
  const horse = ready("horse", home);
  const far = G.reachable(horse);
  check("a horseman reaches 2 ordinary tiles out",
    [...far.values()].some(s => s === 2 * STEP));
  check("distances are honest",
    [...far].every(([id, s]) => hexDist(b.tiles[id], home) <= s));

  /* use ordinary ground on both hops, so the arithmetic is not at the mercy of
     whichever plains happen to sit beside this fixture's town */
  const ordinary = id => G.stepCost("horse", b.tiles[id].terrain) === STEP;
  const oneStep = [...far].find(([id, s]) => s === STEP && ordinary(id))[0];
  G.moveUnit(horse.id, oneStep);
  check("a horseman may still attack after one ordinary tile", G.canAttack(horse) === true);
  check("and may still take a second", G.canMove(horse) === true);
  /* not back onto home — the recruit check below needs that tile free */
  const twoStep = [...G.reachable(horse).keys()].find(id => id !== home.id && ordinary(id));
  check("a second ordinary tile is available", twoStep !== undefined);
  G.moveUnit(horse.id, twoStep);
  check("after two ordinary tiles it can no longer attack", G.canAttack(horse) === false);
  check("and cannot afford a third", (() => {
    const left = UNITS.horse.move - horse.moved;
    return left < STEP && [...G.reachable(horse).keys()].every(id => !ordinary(id));
  })());

  check("units cannot stack", (() => {
    const other = ready("foot", home);
    return G.moveUnit(other.id, horse.tile) === false;
  })());
}

/* ---------- bridges carry land units over water ---------- */
section("crossing on bridges");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);

  /* a water tile next to the town, with no bridge on it yet */
  const strait = G.around(home).find(isWater);
  check("the fixture town is coastal", !!strait, "need water beside the town");
  if (!strait) throw new Error("no coastal town in fixture");

  const foot = ready("foot", home);
  check("unbridged water is not walkable", G.bridged(strait.id) === false);
  check("and the foot soldier cannot step onto it",
    G.reachable(foot).has(strait.id) === false);

  /* bridge one of that tile's own edges */
  const edge = G.tileEdges(strait).find(id => {
    const e = b.edges[id];
    return e && !G.game.roads.has(id) && G.edgeKinds(e).includes("bridge");
  });
  check("the water tile has a bridgeable edge", edge !== undefined);
  G.game.roads.set(edge, { owner: me, bridge: true });

  check("the tile is now bridged", G.bridged(strait.id) === true);
  check("a foot soldier may step onto it", G.reachable(foot).has(strait.id) === true);
  check("the move actually works", G.moveUnit(foot.id, strait.id) === true);
  check("the soldier is standing on water", isWater(b.tiles[foot.tile]));

  /* a road on that same tile's edge would NOT have done it */
  G.game.roads.set(edge, { owner: me, bridge: false });
  check("a road does not carry anyone over water", G.bridged(strait.id) === false);
  G.game.roads.set(edge, { owner: me, bridge: true });

  /* crossing a one-tile strait: land -> bridged water -> land */
  const far = G.around(strait).find(t => settleable(t) && !G.unitAt(t.id)
    && !G.game.towns.has(t.id) && hexDist(t, home) === 2);
  if (far) {
    G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
    check("the crossing continues to the far shore",
      G.reachable(foot).has(far.id) === true);
    check("and the soldier lands there", G.moveUnit(foot.id, far.id) === true);
  }

  /* an enemy may use your bridge too */
  const raider = place(1 - me, "foot", home);
  G.game.units.delete(raider.id);
  const nearWater = G.around(strait).find(t => settleable(t) && !G.unitAt(t.id));
  if (nearWater) {
    const theirs = place(1 - me, "foot", nearWater);
    check("your bridge carries the enemy as well",
      G.reachable(theirs).has(strait.id) === (G.unitAt(strait.id) === null));
  }

  /* boats are unaffected by bridges */
  check("water is still water for boats", (() => {
    const boat = place(me, "boat", b.tiles.find(t => isWater(t) && !G.unitAt(t.id)));
    return [...G.reachable(boat).keys()].every(id => isWater(b.tiles[id]));
  })());
}

/* ---------- merchants are the whole economy ---------- */
section("merchants");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me, home = G.townsOf(me)[0];
  rich(me);

  check("production is flat without merchants",
    RESOURCES.every(f => G.yieldOf(me, f) === 1));
  check("towns no longer add income", G.townsOf(me).length > 1
    && RESOURCES.every(f => G.yieldOf(me, f) === 1),
    `${G.townsOf(me).length} towns still yield 1 each`);

  /* cost and the one-per-town cap */
  G.game.hands[me] = { wool: 1, wheat: 1, fish: 1, wood: 0, ore: 0 };
  check("wool, wheat and fish buy a merchant", G.canAffordUnit(me, "merchant") === true);
  for (const short of ["wool", "wheat", "fish"]) {
    const keep = G.game.hands[me][short];
    G.game.hands[me][short] = 0;
    check(`missing ${short} blocks it`, G.canAffordUnit(me, "merchant") === false);
    G.game.hands[me][short] = keep;
  }
  check("the cap is one per town", G.capOf(me, "merchant") === G.townsOf(me).length);
  check("soldiers are uncapped", G.capOf(me, "foot") === Infinity);

  rich(me);
  const trader = ready("merchant", home);
  check("the merchant musters on a town", trader.tile === home.id);
  check("a merchant has a single life", trader.lives === 1);

  /* one per town: fill every town, then the next is refused */
  check("under the cap, more are allowed", G.withinCap(me, "merchant") === true);
  for (const t of G.townsOf(me)) if (!G.unitAt(t.id)) ready("merchant", t);
  check("at the cap, no more merchants", G.withinCap(me, "merchant") === false,
    `${G.countOf(me, "merchant")} of ${G.capOf(me, "merchant")}`);
  check("one merchant per town exactly",
    G.countOf(me, "merchant") === G.townsOf(me).length);
  check("recruiting past the cap is refused", (() => {
    const spot = landNear(home);
    return spot ? G.recruit("merchant", spot) === false : true;
  })());
  check("but soldiers are still available", G.withinCap(me, "foot") === true);

  /* a merchant cannot fight, and is not a target-maker */
  check("a merchant has no range", UNITS.merchant.range === null);
  check("and can never attack", G.canAttack(trader) === false);
  check("it reaches nothing", G.targetsOf(trader).length === 0
    && G.wallTargetsOf(trader).length === 0);
  check("attacking with it is refused", (() => {
    const spot = landNear(home);
    if (!spot) return true;
    const victim = place(foe, "foot", spot);
    return G.attackUnit(trader.id, victim.tile) === false;
  })());

  /* Measure the bonus with exactly ONE merchant on the board — the cap test above filled
     every town, and a merchant standing on its own town tile already trades that terrain. */
  for (const u of G.merchantsOf(me)) G.game.units.delete(u.id);
  check("cleared for measurement",
    G.merchantsOf(me).length === 0 && RESOURCES.every(f => G.yieldOf(me, f) === 1));
  const solo = ready("merchant", G.townsOf(me).find(t => !G.unitAt(t.id)));

  const stand = G.around(b.tiles[solo.tile]).find(t => settleable(t) && !G.unitAt(t.id)
    && !G.game.towns.has(t.id) && RESOURCES.includes(t.terrain));
  check("a resource tile is adjacent", !!stand);
  if (stand) {
    const res = stand.terrain;
    const before = G.yieldOf(me, res);
    G.moveUnit(solo.id, stand.id);
    check("the merchant moved onto it", solo.tile === stand.id);
    check("that resource now yields one more", G.yieldOf(me, res) === before + 1);
    check("every other resource is unchanged",
      RESOURCES.filter(f => f !== res).every(f => G.yieldOf(me, f) === 1));
    check("the opponent gains nothing from it",
      RESOURCES.every(f => G.yieldOf(foe, f) === 1));

    /* and it really pays out on a roll: 1 base + 1 from the merchant */
    G.endTurn(); G.rollDice(DOUBLES); G.endTurn();
    const held = G.game.hands[me][res];        // after the intervening roll, not before
    const theirs = G.game.hands[foe][res];
    const face = (RESOURCES.indexOf(res) + 0.5) / (RESOURCES.length + 1);
    G.rollDice(() => face);                    // doubles of the merchant's resource
    check("the roll paid the merchant's bonus",
      G.game.hands[me][res] === held + 2, `${held} -> ${G.game.hands[me][res]}`);
    check("the opponent got only the base 1",
      G.game.hands[foe][res] === theirs + 1, `${theirs} -> ${G.game.hands[foe][res]}`);
  }

  /* barren ground trades nothing */
  const barren = b.tiles.find(t => ["mountain", "plain", "desert"].includes(t.terrain)
    && !G.unitAt(t.id) && !G.game.towns.has(t.id));
  if (barren) {
    const idle = place(me, "merchant", barren);
    check("a merchant on barren ground adds nothing",
      RESOURCES.every(f => G.yieldOf(me, f) === (f === (stand && stand.terrain) ? 2 : 1)));
    G.game.units.delete(idle.id);
  }

  /* one hit kills a merchant */
  check("a single hit kills a merchant", (() => {
    const next = landNear(b.tiles[solo.tile]);
    if (!next) return true;
    const killer = place(foe, "foot", next);
    G.endTurn(); G.rollDice(DOUBLES);
    return G.attackUnit(killer.id, solo.tile) === true
      && G.game.units.has(solo.id) === false;
  })());
  check("and the income goes with it", RESOURCES.every(f => G.yieldOf(me, f) === 1));
}

/* ---------- town life ---------- */
section("town life");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me);
  const mine0 = G.townsOf(me)[0];

  check("an unlinked town is worth its base", G.townMaxLife(mine0) === RULES.TOWN_LIFE,
    `${G.townMaxLife(mine0)}`);
  check("it starts undamaged", G.townLife(mine0) === G.townMaxLife(mine0));
  check("no roads means no links", G.linkedTowns(me, mine0) === 0);
  check("an empty tile has no life", G.townMaxLife(
    b.tiles.find(t => settleable(t) && !G.game.towns.has(t.id))) === 0);

  /* roads between your own towns add life, up to the cap */
  const other = G.townsOf(me).find(t => t.id !== mine0.id);
  const path = [];
  {
    const adj = new Map();
    for (const e of b.edges) {
      if (e.tiles.some(x => G.game.towns.has(x))) continue;
      if (!adj.has(e.a)) adj.set(e.a, []); if (!adj.has(e.b)) adj.set(e.b, []);
      adj.get(e.a).push([e.b, e.id]); adj.get(e.b).push([e.a, e.id]);
    }
    const goal = new Set(b.corners[other.id]), prev = new Map();
    const seen = new Set(b.corners[mine0.id]), q = [...b.corners[mine0.id]];
    while (q.length) {
      const v = q.shift();
      if (goal.has(v)) { for (let u = v; prev.has(u); u = prev.get(u)[0]) path.unshift(prev.get(u)[1]); break; }
      for (const [n, eid] of adj.get(v) || []) {
        if (seen.has(n)) continue; seen.add(n); prev.set(n, [v, eid]); q.push(n);
      }
    }
  }
  check("a route between your towns exists", path.length > 0);
  path.forEach(id => G.game.roads.set(id, { owner: me, bridge: b.edges[id].water }));
  check("the towns are now linked", G.linkedTowns(me, mine0) === 1);
  check("and each is worth one more", G.townMaxLife(mine0) === RULES.TOWN_LIFE + 1);
  check("the link is mutual", G.townMaxLife(other) === RULES.TOWN_LIFE + 1);
  check("an opponent's roads do not count", (() => {
    path.forEach(id => G.game.roads.set(id, { owner: foe, bridge: b.edges[id].water }));
    const n = G.linkedTowns(me, mine0);
    path.forEach(id => G.game.roads.set(id, { owner: me, bridge: b.edges[id].water }));
    return n === 0;
  })());

  /* a fighting garrison adds its remaining lives; a civilian adds nothing */
  check("an empty town defends with its own life alone",
    G.townDefence(mine0) === G.townLife(mine0));
  const guard = place(me, "foot", mine0);
  check("a soldier is a garrison", G.garrisonOf(mine0) === guard);
  check("and adds its lives", G.townDefence(mine0) === G.townLife(mine0) + guard.lives);
  guard.lives = 1;
  check("a wounded garrison adds less", G.townDefence(mine0) === G.townLife(mine0) + 1);
  G.game.units.delete(guard.id);

  const trader = place(me, "merchant", mine0);
  check("a civilian is no garrison", G.garrisonOf(mine0) === null);
  check("and adds nothing", G.townDefence(mine0) === G.townLife(mine0));
  G.game.units.delete(trader.id);
}

/* ---------- storming a town ---------- */
section("storming");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me);
  const target = G.townsOf(foe)[0];
  const post = G.around(target).find(t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id));
  check("a staging tile exists", !!post);
  if (!post) throw new Error("nowhere to attack from");

  const ram = place(me, "foot", post);
  check("the town is a target", G.townTargetsOf(ram).includes(target.id));
  check("your own towns are never targets",
    G.townTargetsOf(ram).every(id => G.game.towns.get(id) !== me));

  const max = G.townMaxLife(target);
  for (let hit = 1; hit <= max; hit++) {
    ram.moved = 0; ram.acted = false;
    check(`blow ${hit} lands`, G.attackUnit(ram.id, target.id) === true);
    if (hit < max) check(`town down to ${max - hit}`, G.townLife(target) === max - hit);
  }
  /* conquered, not destroyed: it stays on the map and stays its owner's */
  check("the town has fallen", G.townFallen(target) === true);
  check("but it is still on the map", G.game.towns.get(target.id) === foe);
  check("its owner keeps the count", G.townsOf(foe).length === RULES.TOWNS_AT_START);
  check("the attacker did not move in", ram.tile === post.id);
  check("it musters nobody now", G.legalRecruit(foe, "foot", target) === false);
  check("and cannot be beaten further", G.townTargetsOf(ram).includes(target.id) === false);
  check("its gates stand open to the enemy", (() => {
    const scout = place(me, "foot", post);
    const ok = G.canStand(scout, target);
    G.game.units.delete(scout.id);
    return ok;
  })(), "an enemy may occupy a conquered town");
  check("a standing town stays closed", (() => {
    const whole = G.townsOf(foe).find(t => !G.townFallen(t));
    if (!whole) return true;
    const scout = place(me, "foot", post);
    const ok = G.canStand(scout, whole) === false;
    G.game.units.delete(scout.id);
    return ok;
  })());

  /* a garrison has to be cleared first */
  const second = G.townsOf(foe)[0];
  if (second) {
    const post2 = G.around(second).find(t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id));
    if (post2) {
      const defender = place(foe, "foot", second);
      const attacker = place(me, "foot", post2);
      check("a garrisoned town is not a town target",
        G.townTargetsOf(attacker).includes(second.id) === false);
      check("but the garrison is a unit target",
        G.targetsOf(attacker).includes(defender));
      const life = G.townLife(second);
      G.attackUnit(attacker.id, second.id);
      check("the blow fell on the garrison", defender.lives === UNITS.foot.lives - 1);
      check("and the town is untouched", G.townLife(second) === life);
    }
  }
}

/* ---------- a wall must fall before the town ---------- */
section("siege order");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me); rich(foe);
  const target = G.townsOf(foe)[0];
  G.game.walls.set(target.id, { owner: foe, lives: 1, repaired: false });

  const post = b.tiles.find(t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id)
    && hexDist(t, target) === 2);
  check("a firing position exists", !!post);
  if (post) {
    const gun = place(me, "cannon", post);
    check("the town is shielded while the wall stands",
      G.townTargetsOf(gun).includes(target.id) === false);
    check("but the wall is a target", G.wallTargetsOf(gun).includes(target.id));
    G.attackUnit(gun.id, target.id);
    check("the wall is breached", G.game.walls.has(target.id) === false);
    check("and the town is now exposed", (() => {
      gun.moved = 0; gun.acted = false;
      return G.townTargetsOf(gun).includes(target.id);
    })());
    const life = G.townLife(target);
    G.attackUnit(gun.id, target.id);
    check("the next shot hits the town", G.townLife(target) === life - 1);
  }
}

/* ---------- rebuilding, and razing a king out of house and home ---------- */
section("rebuilding");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);
  const t = G.townsOf(me)[0];

  check("an unharmed town needs no rebuilding", G.canRepairTown(me, t) === false);
  check("and says so", G.whyNoTownRepair(me, t) === "That town is unharmed");

  /* repairs need hands: a foot soldier or horseman standing in the town */
  G.game.townHurt.set(t.id, 1);
  check("a damaged town with nobody in it cannot be worked on",
    G.canRepairTown(me, t) === false);
  check("and says what it needs",
    G.whyNoTownRepair(me, t) === "Needs a foot soldier or horseman in the town");
  const idle = place(me, "merchant", t);
  check("a merchant is no work crew", G.workCrew(me, t) === null
    && G.canRepairTown(me, t) === false);
  G.game.units.delete(idle.id);
  const gun = place(me, "cannon", t);
  check("nor is a cannon", G.workCrew(me, t) === null && G.canRepairTown(me, t) === false);
  G.game.units.delete(gun.id);
  const crew = place(me, "foot", t);
  check("a foot soldier is", G.workCrew(me, t) === crew);
  G.game.townHurt.delete(t.id);

  G.game.townHurt.set(t.id, 1);
  check("a damaged town shows it", G.townLife(t) === G.townMaxLife(t) - 1);
  G.game.hands[me].wood = 0;
  check("no timber, no rebuilding", G.canRepairTown(me, t) === false);
  check("and it says why",
    G.whyNoTownRepair(me, t) === `Needs ${G.costLabel(COSTS.townRepair)}`);

  G.game.hands[me].wood = 4;
  check("rebuilding works", G.repairTown(t) === true);
  check("a life comes back", G.townLife(t) === G.townMaxLife(t));
  check("it cost timber", G.game.hands[me].wood === 3);
  check("only one course a turn", G.canRepairTown(me, t) === false);
  check("a fully mended town reports itself unharmed",
    G.whyNoTownRepair(me, t) === "That town is unharmed");

  /* the allowance is per turn, so the crew must wait for their next one */
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check("back to the owner", G.game.current === me);
  check("the allowance came back", G.mendedThisTurn(t) === false);

  G.game.townHurt.set(t.id, 2);
  check("a badly damaged town can be worked on", G.repairTown(t) === true);
  check("one life at a time", G.townLife(t) === G.townMaxLife(t) - 1);
  check("and no more this turn", G.canRepairTown(me, t) === false);
  check("which is why it is refused",
    G.whyNoTownRepair(me, t) === "Something there has already been repaired this turn");
  check("a second attempt fails", G.repairTown(t) === false);

  /* the masons are back next turn */
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check("back to the owner", G.game.current === me);
  check("rebuilding is available again", G.canRepairTown(me, t) === true);

  /* a conquered town stays on the map, and keeps its king */
  const seat = b.tiles[G.game.kings.get(me)];
  G.game.townHurt.set(seat.id, G.townMaxLife(seat));
  check("the town is still there", G.game.towns.get(seat.id) === me);
  check("but it has fallen", G.townFallen(seat) === true && G.townLife(seat) === 0);
  check("the king still sits in it", G.game.kings.get(me) === seat.id);
  check("and nobody owes a new one", G.owesKing(me) === false);
}

/* ---------- trade ---------- */
section("trade");
{
  const b = fresh(2, t => RESOURCES.includes(t.terrain));
  const me = G.game.current, foe = 1 - me;
  rich(me);

  const home = G.townsOf(me).find(t => RESOURCES.includes(t.terrain));
  check("a town on producing ground exists", !!home);
  const res = home ? home.terrain : "wood";
  const bare = RESOURCES.find(f => !G.townsOf(me).some(t => t.terrain === f));

  check("a resource you hold no town on trades at base",
    bare ? G.tradeRatio(me, bare) === RULES.TRADE_BASE : true, `${bare}`);
  check("a town on the ground takes one off",
    G.tradeRatio(me, res) === RULES.TRADE_BASE - 1, `${res} at ${G.tradeRatio(me, res)}`);

  /* roads take one more off */
  const other = G.townsOf(me).find(t => t.id !== home.id);
  {
    const adj = new Map();
    for (const e of b.edges) {
      if (e.tiles.some(x => G.game.towns.has(x))) continue;
      if (!adj.has(e.a)) adj.set(e.a, []); if (!adj.has(e.b)) adj.set(e.b, []);
      adj.get(e.a).push([e.b, e.id]); adj.get(e.b).push([e.a, e.id]);
    }
    const goal = new Set(b.corners[other.id]), prev = new Map();
    const seen = new Set(b.corners[home.id]), q = [...b.corners[home.id]];
    while (q.length) { const v = q.shift();
      if (goal.has(v)) { for (let u = v; prev.has(u); u = prev.get(u)[0])
        G.game.roads.set(prev.get(u)[1], { owner: me, bridge: b.edges[prev.get(u)[1]].water }); break; }
      for (const [n, eid] of adj.get(v) || []) { if (seen.has(n)) continue;
        seen.add(n); prev.set(n, [v, eid]); q.push(n); } }
  }
  check("a road link takes another off",
    G.tradeRatio(me, res) === RULES.TRADE_BASE - 2, `${res} at ${G.tradeRatio(me, res)}`);
  check("it never drops below the floor", RESOURCES
    .every(f => G.tradeRatio(me, f) >= RULES.TRADE_FLOOR));

  /* the swap itself */
  const rate = G.tradeRatio(me, res);
  const want = RESOURCES.find(f => f !== res);
  G.game.hands[me][res] = rate - 1;
  check("one short and the trade is refused", G.trade(res, want) === false);
  check("and it says the rate", G.game.notice === `Needs ${rate} ${res} to get 1 ${want}`);

  G.game.hands[me][res] = rate;
  const had = G.game.hands[me][want];
  check("at the rate it goes through", G.trade(res, want) === true);
  check("the given resource is spent", G.game.hands[me][res] === 0);
  check("and one of the wanted comes back", G.game.hands[me][want] === had + 1);
  check("trading a resource for itself is refused", G.trade(want, want) === false);
  check("the opponent's ratio is their own",
    G.tradeRatio(foe, res) === RULES.TRADE_BASE
    || G.townsOf(foe).some(t => t.terrain === res));
}

/* ---------- occupying a conquered town ---------- */
section("occupation");
{
  const b = fresh(2, t => RESOURCES.includes(t.terrain));
  const me = G.game.current, foe = 1 - me;
  rich(me);

  const prize = G.townsOf(foe).find(t => RESOURCES.includes(t.terrain));
  check("the enemy holds producing ground", !!prize);
  if (prize) {
    const res = prize.terrain;
    const theirs0 = G.tradeRatio(foe, res), mine0 = G.tradeRatio(me, res);
    check("its owner trades that resource cheaper", theirs0 < RULES.TRADE_BASE);

    /* beat it down */
    G.game.townHurt.set(prize.id, G.townMaxLife(prize));
    check("the town has fallen", G.townFallen(prize) === true);
    check("its owner loses the discount", G.tradeRatio(foe, res) === RULES.TRADE_BASE);
    check("but nobody else has gained it yet", G.tradeHolder(prize) === null);
    check("and the attacker's ratio is untouched", G.tradeRatio(me, res) === mine0);

    /* walk in */
    const post = G.around(prize).find(t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id));
    if (post) {
      const occupier = place(me, "foot", post);
      check("an enemy may enter it", G.reachable(occupier).has(prize.id) === true);
      G.moveUnit(occupier.id, prize.id);
      check("the occupier is standing in it", occupier.tile === prize.id);
      check("the trade now counts for the occupier", G.tradeHolder(prize) === me);
      check("whose ratio improves", G.tradeRatio(me, res) < mine0,
        `${mine0} -> ${G.tradeRatio(me, res)}`);
      check("while the owner stays at base", G.tradeRatio(foe, res) === RULES.TRADE_BASE);

      /* and the owner can win it back once the occupier is gone */
      G.game.units.delete(occupier.id);
      check("with the town empty nobody holds it", G.tradeHolder(prize) === null);
      const crew = place(foe, "foot", prize);
      check("a returning crew may repair it", G.canRepairTown(foe, prize) === true
        || G.game.hands[foe].wood === 0);
      G.game.hands[foe].wood = 3;
      G.game.current = foe; G.game.rolled = true;
      check("rebuilding works", G.repairTown(prize) === true);
      check("it stands again", G.townFallen(prize) === false);
      check("and its owner has the discount back", G.tradeRatio(foe, res) < RULES.TRADE_BASE);
      G.game.units.delete(crew.id);
    }
  }
}

/* ---------- a town does one job a turn ---------- */
section("one job a turn");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);
  const t = G.townsOf(me).find(x => !G.unitAt(x.id));

  check("a fresh town is free to work", G.townBusy(t) === false);
  const id = G.recruit("foot", t);
  check("mustering works", typeof id === "number");
  check("and spends the town's turn", G.townBusy(t) === true);
  G.game.townHurt.set(t.id, 1);
  check("so it cannot also repair", G.canRepairTown(me, t) === false);
  check("and says why",
    G.whyNoTownRepair(me, t) === "Something there has already been repaired this turn");

  /* the other way round */
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check("the town is free again", G.townBusy(t) === false);
  const crew = G.game.units.get(id);
  crew.tile = t.id;                                  // the garrison is the work crew
  check("repairing works", G.repairTown(t) === true);
  check("and spends the turn", G.townBusy(t) === true);
  const spare = G.townsOf(me).find(x => x.id !== t.id && !G.unitAt(x.id));
  if (spare) check("another town is unaffected", G.townBusy(spare) === false
    && G.legalRecruit(me, "foot", spare) === true);
}


/* ---------- scoring ---------- */
section("scoring");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me);

  check("everyone starts on their towns", G.scoreOf(me) === RULES.TOWNS_AT_START * SCORE.town);
  check("standing points are read off the board",
    G.standingScore(me) === G.townsOf(me).length * SCORE.town);
  check("nothing is banked yet", G.game.earned[me] === 0);
  check("scores lists every player", G.scores().length === 2);
  check("nobody has won", G.game.winner === null && G.game.phase === "play");

  /* a conquered town still scores for its owner — it stays theirs */
  const mine0 = G.townsOf(me)[0];
  const before = G.scoreOf(me);
  G.game.townHurt.set(mine0.id, G.townMaxLife(mine0));
  check("a fallen town still scores for its owner", G.scoreOf(me) === before);
  G.game.townHurt.delete(mine0.id);

  /* ports are standing points too */
  const port = b.tiles.find(t => G.isHarbour(t) && !G.game.ports.has(t.id));
  if (port) {
    const was = G.scoreOf(me);
    G.game.ports.set(port.id, me);
    check("a port is worth a point", G.scoreOf(me) === was + SCORE.port);
    G.game.ports.delete(port.id);
  }

  /* raids pay in batches, not one at a time */
  const runs = SCORE.stealRuns;
  for (let i = 1; i < runs; i++) {
    G.game.steals[me] = i;
    check(`raid ${i} of ${runs} pays nothing yet`, G.game.earned[me] === 0);
  }
  G.game.steals[me] = runs - 1;
  G.game.earned[me] = 0;
}

/* ---------- points that are banked stay banked ---------- */
section("banked points");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me);

  const target = G.townsOf(foe)[0];
  const post = G.around(target).find(t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id));
  if (post) {
    const ram = place(me, "foot", post);
    const max = G.townMaxLife(target), was = G.scoreOf(me);
    for (let hit = 1; hit <= max; hit++) { ram.moved = 0; ram.acted = false; G.attackUnit(ram.id, target.id); }
    check("conquering a town pays", G.scoreOf(me) === was + SCORE.conquest);
    check("and it is banked, not standing", G.game.earned[me] === SCORE.conquest);

    /* the owner rebuilds it; the attacker keeps the point */
    G.game.townHurt.delete(target.id);
    check("the town stands again", G.townFallen(target) === false);
    check("the attacker keeps the point", G.game.earned[me] === SCORE.conquest);
    check("and the owner never lost theirs",
      G.scoreOf(foe) === G.townsOf(foe).length * SCORE.town);
    G.game.units.delete(ram.id);
  }
}

/* ---------- holding pays for endurance ---------- */
section("holding");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me);

  const target = G.townsOf(foe)[0];
  G.game.townHurt.set(target.id, G.townMaxLife(target));
  const holder = place(me, "foot", target);          // walked into the conquered town
  check("the town has fallen", G.townFallen(target) === true);
  check("and an enemy stands in it", G.unitAt(target.id) === holder);

  const start = G.game.earned[me];
  for (let n = 1; n < SCORE.holdTurns; n++) {
    G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
    check(`turn ${n} of ${SCORE.holdTurns} pays nothing yet`, G.game.earned[me] === start);
  }
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check(`holding ${SCORE.holdTurns} turns pays`, G.game.earned[me] === start + SCORE.occupy);

  /* letting go forgets the progress */
  G.game.units.delete(holder.id);
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check("an abandoned hold stops paying", G.game.earned[me] === start + SCORE.occupy);
  check("and its progress is forgotten",
    [...G.game.holds.keys()].every(k => !k.startsWith(`${me}:${target.id}`)));
}

/* ---------- winning ---------- */
section("winning");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);

  check("no winner while nobody is close", G.game.winner === null);
  game_earned_to_target(me);
  function game_earned_to_target(pi) { G.game.earned[pi] = SCORE.target - G.standingScore(pi); }
  check("the score has reached the target", G.scoreOf(me) === SCORE.target);
  check("but nothing is decided mid-turn", G.game.winner === null && G.game.phase === "play");

  G.endTurn();
  check("the winner is declared as the turn closes", G.game.winner === me);
  check("and the game is over", G.game.phase === "over");
  check("the turn did not pass", G.game.current === me);
  check("no more rolling", G.rollDice(DOUBLES) === false);
  check("no more building", G.canBuild() === false);
  check("a second endTurn changes nothing", G.endTurn() === false && G.game.winner === me);
}

/* ---------- kings ---------- */
section("kings");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;

  check("every player seated a king", G.game.kings.size === 2);
  check("a king sits in its owner's town",
    G.game.towns.get(G.game.kings.get(me)) === me);
  check("kingOf finds it", G.kingOf(me).id === G.game.kings.get(me));
  check("kingAt names the owner", G.kingAt(G.game.kings.get(me)) === me);
  check("a town without a king reports none",
    G.kingAt(G.townsOf(me).find(t => t.id !== G.game.kings.get(me)).id) === null);
  check("nobody owes a king", G.owesKing(me) === false && G.game.crown === null);

  /* the multiplayer seam is open for now, and deliberately so */
  check("kings are visible to everyone for testing",
    G.kingVisibleTo(foe, me) === true && G.kingVisibleTo(me, me) === true);

  const other = G.townsOf(me).find(t => t.id !== G.game.kings.get(me));
  check("a king cannot be seated where it already sits",
    G.legalKingSeat(me, G.kingOf(me)) === false);
  check("nor in someone else's town",
    G.legalKingSeat(me, G.townsOf(foe)[0]) === false);
  check("but another of your own towns is fine", G.legalKingSeat(me, other) === true);
}

/* ---------- spies ---------- */
section("spies");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me, home = G.townsOf(me)[0];

  G.game.hands[me] = { wool: 1, wheat: 1, fish: 1, wood: 9, ore: 9 };
  check("1 wool is not enough for a spy", G.canAffordUnit(me, "spy") === false);
  G.game.hands[me].wool = 2;
  check("2 wool, 1 wheat and 1 fish buys one", G.canAffordUnit(me, "spy") === true);

  rich(me);
  const spy = ready("spy", home);
  check("a spy has a single life", spy.lives === 1);
  check("a spy cannot attack", G.canAttack(spy) === false && UNITS.spy.range === null);
  check("a spy is an ordinary visible unit", G.unitAt(spy.tile) === spy);
  check("it is uncapped, unlike a merchant", G.capOf(me, "spy") === Infinity);

  /* three tiles in the clear */
  const clear = G.reachable(spy);
  check("a spy ranges 3 tiles when unobserved",
    [...clear.values()].some(s => s === 3 * STEP), `max ${Math.max(...clear.values())}`);

  /* but one tile once anybody is watching */
  const near = landNear(home);
  check("a watching enemy is findable", !!near);
  if (near) {
    const sentry = place(foe, "foot", near);
    check("the sentry overlooks its neighbours", G.watched(spy, b.tiles[spy.tile]) === true);
    const shy = G.reachable(spy);
    check("the spy is held to one tile",
      [...shy.values()].every(s => s <= UNITS.spy.move)
      && [...shy].every(([id, s]) => !G.watched(spy, b.tiles[id]) || s === UNITS.spy.move));
    check("no watched tile is reachable after moving", (() => {
      const step = [...shy].find(([id]) => !G.watched(spy, b.tiles[id]));
      if (!step) return true;
      G.moveUnit(spy.id, step[0]);
      return [...G.reachable(spy).keys()].every(id => !G.watched(spy, b.tiles[id]));
    })());
    G.game.units.delete(sentry.id);
  }
}

/* ---------- scouting and assassination ---------- */
section("assassination");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me);

  /* put a spy beside the enemy town that holds their king, and beside one that does not */
  const seat = b.tiles[G.game.kings.get(foe)];
  const empty = G.townsOf(foe).find(t => t.id !== seat.id);
  const post = G.around(seat).find(t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id));
  check("a vantage point beside the royal town exists", !!post);
  if (!post) throw new Error("no vantage point");
  const spy = place(me, "spy", post);

  /* a spy obeys the same allowance as everyone else: one tile, then work */
  check("a spy that marched one tile may still work", (() => {
    spy.moved = G.strikeAllowance("spy");
    const ok = G.peekTown(spy.id, seat.id) !== null;
    spy.moved = 0; spy.acted = false;
    return ok;
  })());
  check("a spy that ran further has spent its turn", (() => {
    spy.moved = G.strikeAllowance("spy") + 1;
    const refused = G.assassinate(spy.id, seat.id) === false
      && G.game.notice === "That spy has marched too far to work this turn";
    spy.moved = 0; spy.acted = false;
    return refused;
  })());
  check("nor can it steal after a long march", (() => {
    spy.moved = UNITS.spy.move;
    const refused = G.stealFrom(spy.id, seat.id) === false;
    spy.moved = 0; spy.acted = false;
    return refused;
  })());

  check("the spy sees the town as a target",
    G.spyTargets(spy).some(t => t.id === seat.id));
  check("it does not target your own towns",
    G.spyTargets(spy).every(t => G.game.towns.get(t.id) !== me));

  /* scouting */
  const wheat = G.game.hands[me].wheat;
  check("scouting finds the king", G.peekTown(spy.id, seat.id) === true);
  check("it cost a wheat", G.game.hands[me].wheat === wheat - 1);
  check("and spent the spy's action", spy.acted === true);
  spy.acted = false;
  if (empty) check("a kingless town reports nothing", G.peekTown(spy.id, empty.id) === false);
  spy.acted = false;

  /* assassination */
  G.game.hands[me].wool = 1;
  check("1 wool is not enough to assassinate", G.assassinate(spy.id, seat.id) === false);
  G.game.hands[me].wool = 5;
  if (empty) {
    /* the kingless town may not be adjacent, so either refusal is correct here */
    check("a town without a king yields no assassination",
      G.assassinate(spy.id, empty.id) === false);
    check("and it says why", ["No king in that town", "Stand next to the town first"]
      .includes(G.game.notice), G.game.notice);
  }
  check("the assassination lands", G.assassinate(spy.id, seat.id) === true);
  check("it cost 2 wool", G.game.hands[me].wool === 3);
  check("the king is gone", G.game.kings.has(foe) === false);
  check("the spy survives", G.game.units.has(spy.id));
  check("the victim now owes a king",
    G.owesKing(foe) === true && G.game.crown.from === seat.id);

  /* the victim must re-seat before doing anything, and not in the same town */
  G.endTurn();
  check("it is the victim's turn", G.game.current === foe);
  check("they cannot roll while a king is owed", G.rollDice() === false);
  check("and are told why", G.game.notice === "Seat your king first — click one of your towns");
  check("the ransacked town is refused", G.legalKingSeat(foe, seat) === false);
  check("with a reason", G.whyNoSeat(foe, seat)
    === "Choose a different town from the one that was taken");
  const refuge = G.townsOf(foe).find(t => t.id !== seat.id);
  if (refuge) {
    check("another town takes the king", G.seatKing(refuge) === true);
    check("the debt is settled", G.owesKing(foe) === false && G.game.crown === null);
    check("and play resumes", G.rollDice(DOUBLES) === true);
  }
}

/* ---------- stealing ---------- */
section("stealing");
{
  /* towns on producing ground, since a raid takes what the town's own tile makes */
  const b = fresh(2, t => RESOURCES.includes(t.terrain));
  const me = G.game.current, foe = 1 - me;
  rich(me);

  /* a raid takes the resource the town's own tile makes */
  const rich_town = G.townsOf(foe).find(t => RESOURCES.includes(t.terrain));
  const barren = G.townsOf(foe).find(t => !RESOURCES.includes(t.terrain));
  check("the enemy has a town on resource ground", !!rich_town,
    G.townsOf(foe).map(t => t.terrain).join("/"));

  if (rich_town) {
    const res = rich_town.terrain;
    const post = G.around(rich_town).find(t => settleable(t) && !G.unitAt(t.id)
      && !G.game.towns.has(t.id));
    check("a vantage point exists", !!post);
    if (post) {
      const spy = place(me, "spy", post);

      /* an empty purse yields nothing */
      RESOURCES.forEach(f => G.game.hands[foe][f] = 0);
      check("nothing to steal from an empty purse", G.stealable(spy, rich_town.id) === null);
      const wheat = G.game.hands[me].wheat;
      check("the raid fails", G.stealFrom(spy.id, rich_town.id) === false);
      check("but the wheat is spent anyway", G.game.hands[me].wheat === wheat - 1);
      check("and it says why", G.game.notice === "Nothing in that town's stores to take");
      spy.acted = false;

      /* with stock in hand, the raid lands */
      G.game.hands[foe][res] = 3;
      check("now there is something to take", G.stealable(spy, rich_town.id) === res);
      const mine0 = G.game.hands[me][res], theirs0 = G.game.hands[foe][res];
      const wheat2 = G.game.hands[me].wheat;
      check("the raid succeeds", G.stealFrom(spy.id, rich_town.id) === true);
      check("the thief gains one", G.game.hands[me][res] === mine0 + 1);
      check("the victim loses one", G.game.hands[foe][res] === theirs0 - 1);
      check("it cost a wheat", G.game.hands[me].wheat === wheat2 - 1);
      check("and spent the spy's turn", spy.acted === true);
      check("only that resource moved", RESOURCES
        .filter(f => f !== res && f !== "wheat")
        .every(f => G.game.hands[foe][f] === 0));

      check("a spy that has acted cannot raid again",
        G.stealFrom(spy.id, rich_town.id) === false);
      G.game.units.delete(spy.id);
    }
  }

  /* barren ground makes nothing, so there is nothing to carry off */
  if (barren) {
    const post = G.around(barren).find(t => settleable(t) && !G.unitAt(t.id)
      && !G.game.towns.has(t.id));
    if (post) {
      const spy = place(me, "spy", post);
      rich(foe);
      check("barren ground yields nothing", G.stealable(spy, barren.id) === null,
        `${barren.terrain}`);
      check("the raid comes away empty", G.stealFrom(spy.id, barren.id) === false);
      check("and says the ground is barren",
        G.game.notice === "That town sits on barren ground");
      G.game.units.delete(spy.id);
    }
  }

  /* you cannot rob yourself, and you must be adjacent */
  const own = G.townsOf(me)[0];
  const inside = place(me, "spy", G.around(own).find(t => settleable(t) && !G.unitAt(t.id)
    && !G.game.towns.has(t.id)) || own);
  check("your own town is not a target", G.stealable(inside, own.id) === null);
  check("and raiding it is refused", G.stealFrom(inside.id, own.id) === false);
  const far = G.townsOf(foe).find(t => hexDist(t, b.tiles[inside.tile]) > 1);
  if (far) check("a distant town is out of reach", G.stealFrom(inside.id, far.id) === false);
}

/* ---------- evading ---------- */
section("evading");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me, home = G.townsOf(me)[0];
  rich(me); rich(foe);

  /* Evading needs somewhere to go: a tile beside the spy and further from the attacker.
     Pick a pair that has one, otherwise the rule correctly declines and proves nothing. */
  const free = t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id);
  let post = null, spot = null;
  for (const p of b.tiles.filter(free)) {
    for (const k of G.around(p).filter(free)) {
      if (G.around(p).some(x => free(x) && hexDist(x, k) > hexDist(p, k))) { post = p; spot = k; break; }
    }
    if (post) break;
  }
  check("a spot with a line of retreat exists", !!post && !!spot);
  if (!post) throw new Error("no evadable position on this board");

  const spy = place(foe, "spy", post);
  const killer = place(me, "foot", spot);

  const was = spy.tile, wheat = G.game.hands[foe].wheat, fish = G.game.hands[foe].fish;
  check("the attack resolves", G.attackUnit(killer.id, spy.tile) === true);
  check("the spy took no damage", G.game.units.has(spy.id) && spy.lives === 1);
  check("it slipped to another tile", spy.tile !== was);
  check("further from the attacker",
    hexDist(b.tiles[spy.tile], b.tiles[killer.tile]) > hexDist(b.tiles[was], b.tiles[killer.tile]));
  check("evading cost wheat and fish",
    G.game.hands[foe].wheat === wheat - 1 && G.game.hands[foe].fish === fish - 1);

  /* a spy that cannot pay dies like anything else with one life */
  G.game.hands[foe].wheat = 0;
  killer.moved = 0; killer.acted = false;
  const next = G.around(b.tiles[killer.tile]).find(t => G.unitAt(t.id) === spy);
  if (next) {
    check("a penniless spy is killed outright",
      G.attackUnit(killer.id, spy.tile) === true && G.game.units.has(spy.id) === false);
  }
}

/* ---------- terrain and movement ---------- */
section("terrain movement");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);

  /* the cost table itself, in half-tiles: ordinary ground is STEP */
  check("nothing is ever free", ["mountain", "plain", "desert", "wood", "wheat", "wool", "ore"]
    .every(t => ["foot", "horse", "cannon"].every(k => G.stepCost(k, t) > 0)));
  check("a mountain costs a horseman its whole turn",
    G.stepCost("horse", "mountain") === UNITS.horse.move);
  check("but costs a foot soldier the usual", G.stepCost("foot", "mountain") === STEP);
  check("and costs a cannon the usual", G.stepCost("cannon", "mountain") === STEP);
  check("a plain costs a horseman less than ordinary ground",
    G.stepCost("horse", "plain") < STEP);
  check("but costs a foot soldier the usual", G.stepCost("foot", "plain") === STEP);

  /* the cavalry table, exactly as specified */
  const ord = G.stepCost("horse", "wood"), pln = G.stepCost("horse", "plain"),
        mtn = G.stepCost("horse", "mountain"), B = UNITS.horse.move;
  const fits = n => n <= B;
  check("2 ordinary + 1 plain is allowed", fits(2 * ord + pln));
  check("3 plains is allowed",             fits(3 * pln));
  check("4 plains is allowed",             fits(4 * pln));
  check("1 mountain is allowed",           fits(mtn));
  check("1 mountain + a plain is not",    !fits(mtn + pln));
  check("1 mountain + an ordinary is not", !fits(mtn + ord));
  check("5 plains is not",                !fits(5 * pln));
  check("3 ordinary tiles is not",        !fits(3 * ord));

  /* one ordinary tile is the whole allowance before striking — no unit may cross two
     tiles and fight, however cheap the ground it crossed */
  const allow = G.strikeAllowance("horse");
  check("a horseman may strike after one ordinary tile", allow >= ord);
  check("and after one plain",                           allow >= pln);
  check("but never after two plains",                    allow < 2 * pln);
  check("nor after a plain and an ordinary tile",        allow < pln + ord);
  check("a foot soldier must not have moved at all", G.strikeAllowance("foot") === 0);
  check("nor a cannon",                              G.strikeAllowance("cannon") === 0);
  check("a boat may strike after one water tile",
    G.strikeAllowance("boat") >= STEP && G.strikeAllowance("boat") < 2 * STEP);
  check("ordinary ground costs the same for all",
    ["wood", "wheat", "wool", "ore", "desert"].every(t =>
      ["foot", "horse", "cannon"].every(k => G.stepCost(k, t) === STEP)));
  check("only the desert charges a toll",
    JSON.stringify(G.stepToll("desert")) === JSON.stringify({ fish: 1 })
    && G.stepToll("plain") === null && G.stepToll("mountain") === null
    && G.stepToll("wood") === null);

  /* a mountain is out of reach for a 1-move unit only if it costs more than 1 */
  const at = (t, kind) => {
    const id = G.game.nextUnit++;
    const u = { id, owner: me, kind, tile: t.id, lives: 2, moved: 0, acted: false };
    G.game.units.set(id, u); return u;
  };
  const nextTo = (terrain, pred = () => true) => {
    for (const t of b.tiles) {
      if (!settleable(t) || G.game.towns.has(t.id) || G.unitAt(t.id)) continue;
      const n = G.around(t).find(x => x.terrain === terrain && !G.unitAt(x.id)
        && !G.game.towns.has(x.id));
      if (n && pred(t, n)) return [t, n];
    }
    return [null, null];
  };

  const [mSpot, mountain] = nextTo("mountain");
  check("a mountain fixture exists", !!mountain);
  if (mountain) {
    const horse = at(mSpot, "horse");            // move 2
    const foot = at(b.tiles.find(t => settleable(t) && !G.unitAt(t.id)
      && !G.game.towns.has(t.id) && G.around(t).some(x => x.id === mountain.id)) || mSpot, "foot");
    check("a horseman entering a mountain spends its whole turn",
      G.reachable(horse).get(mountain.id) === UNITS.horse.move);
    G.game.units.delete(horse.id);
    G.game.units.delete(foot.id);

    const walker = at(mSpot, "foot");
    check("a foot soldier enters it for the usual",
      G.reachable(walker).get(mountain.id) === STEP);
    G.game.units.delete(walker.id);
  }

  /* plains cost a horseman nothing */
  const [pSpot, plain] = nextTo("plain");
  check("a plain fixture exists", !!plain);
  if (plain) {
    const horse = at(pSpot, "horse");
    const plainCost = G.stepCost("horse", "plain");
    check("a plain costs a horseman less than ordinary ground",
      G.reachable(horse).get(plain.id) === plainCost && plainCost < STEP);
    check("riding it spends exactly that", (() => {
      G.moveUnit(horse.id, plain.id);
      return horse.tile === plain.id && horse.moved === plainCost;
    })());
    check("so the horseman may still move afterwards", G.canMove(horse) === true);
    check("and may still attack afterwards", G.canAttack(horse) === true);
    check("a horseman's range is bounded even over plains", (() => {
      const most = Math.floor(UNITS.horse.move / G.stepCost("horse", "plain"));
      return most === 4 && [...G.reachable(horse).values()].every(s => s <= UNITS.horse.move);
    })());
    G.game.units.delete(horse.id);

    const walker = at(pSpot, "foot");
    check("a plain costs a foot soldier the usual",
      G.reachable(walker).get(plain.id) === STEP);
    G.game.units.delete(walker.id);
  }

  /* the desert charges a fish per unit that crosses it */
  const [dSpot, desert] = nextTo("desert");
  check("a desert fixture exists", !!desert);
  if (desert) {
    const walker = at(dSpot, "foot");
    G.game.hands[me].fish = 0;
    check("no fish, no desert", G.reachable(walker).has(desert.id) === false);
    check("the move is refused", G.moveUnit(walker.id, desert.id) === false);

    G.game.hands[me].fish = 3;
    check("with fish the desert opens", G.reachable(walker).has(desert.id) === true);
    check("the plan names the toll",
      JSON.stringify(G.movePlan(walker).get(desert.id).toll) === JSON.stringify({ fish: 1 }));
    check("crossing works", G.moveUnit(walker.id, desert.id) === true);
    check("and costs exactly one fish", G.game.hands[me].fish === 2);
    check("the desert still costs one ordinary step", walker.moved === STEP);
    G.game.units.delete(walker.id);

    /* the toll is per unit, so a second unit pays again */
    const other = at(dSpot, "foot");
    check("a second unit pays its own fish", (() => {
      const before = G.game.hands[me].fish;
      G.moveUnit(other.id, desert.id);
      return G.game.hands[me].fish === before - 1;
    })());
    G.game.units.delete(other.id);
  }
}

/* ---------- blocking ---------- */
section("blocking");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);
  const foot = ready("foot", home);

  const block = landNear(home);
  const enemy = place(1 - me, "foot", block);
  check("an occupied tile is unreachable", G.reachable(foot).has(block.id) === false);

  G.game.units.delete(enemy.id);
  check("removing the blocker opens it again", G.reachable(foot).has(block.id) === true);

  /* enemy towns are closed to units */
  const theirs = b.tiles[[...G.game.towns].find(([, o]) => o !== me)[0]];
  const scout = place(me, "horse", landNear(theirs) || theirs);
  if (scout.tile !== theirs.id) {
    check("units cannot enter an enemy town", G.reachable(scout).has(theirs.id) === false);
  }
  check("units may stand on their own town", (() => {
    G.game.units.delete(foot.id);          // the town tile is still holding the recruit
    const spot = landNear(home);
    if (!spot) return true;
    const back = place(me, "foot", spot);
    return G.reachable(back).has(home.id) === true;
  })());
}

/* ---------- combat, injury and revival ---------- */
section("combat");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);

  const spot = landNear(home);
  const attacker = place(me, "foot", home);
  const victim = place(1 - me, "horse", spot);

  check("adjacent enemies are visible", G.targetsOf(attacker).includes(victim));
  check("the attack lands", G.attackUnit(attacker.id, spot.id) === true);
  check("damage is exactly 1", victim.lives === UNITS.horse.lives - 1);
  check("the victim is now injured", G.injured(victim) === true);
  check("the victim survives the first hit", G.game.units.has(victim.id));
  check("attacking ends the attacker's turn", attacker.acted === true);
  check("a spent attacker cannot attack again", G.canAttack(attacker) === false);
  check("a spent attacker cannot move", G.canMove(attacker) === false);

  check("attacking a friend is refused", (() => {
    const a = landNear(home, n => n.id !== spot.id);
    if (!a) return true;
    const friend = place(me, "foot", a);
    const bTile = landNear(a, n => n.id !== spot.id && n.id !== home.id);
    if (!bTile) return true;
    const second = place(me, "foot", bTile);
    return G.attackUnit(second.id, friend.tile) === false;
  })());

  check("attacking an empty tile is refused",
    G.attackUnit(attacker.id, b.tiles.find(t => settleable(t) && !G.unitAt(t.id)).id) === false);

  /* an injured unit is rooted but can still fight or recover */
  G.endTurn(); G.rollDice(DOUBLES);
  check("it is the victim's turn", G.game.current === victim.owner);
  check("an injured unit may still retreat", G.canMove(victim) === true);
  check("an injured unit may still attack", G.canAttack(victim) === true);

  /* repairs are paid for in fish */
  G.game.hands[victim.owner].fish = 0;
  check("no fish, no repair", G.canRevive(victim) === false);
  check("and it says why",
    G.whyNoRevive(victim) === `Needs ${G.costLabel(COSTS.revive)}`);
  G.game.hands[victim.owner].fish = 3;
  check("an injured unit may revive", G.canRevive(victim) === true);
  check("reviving works", G.reviveUnit(victim.id) === true);
  check("the repair cost a fish", G.game.hands[victim.owner].fish === 2);
  check("revival restores full lives", victim.lives === UNITS.horse.lives);
  check("a revived unit is no longer injured", G.injured(victim) === false);
  check("reviving spends the turn", victim.acted === true && G.canAttack(victim) === false);
  check("a healthy unit cannot revive", G.canRevive(victim) === false);

  /* two hits kill */
  G.endTurn(); G.rollDice(DOUBLES);
  check("back to the attacker's side", G.game.current === me);
  attacker.moved = 0; attacker.acted = false;
  G.attackUnit(attacker.id, victim.tile);
  check("the second wound injures again", victim.lives === UNITS.horse.lives - 1);
  attacker.moved = 0; attacker.acted = false;
  G.attackUnit(attacker.id, victim.tile);
  check("two hits kill", G.game.units.has(victim.id) === false);
  check("the tile is free once the unit dies", G.unitAt(victim.tile) === null);
}

/* ---------- the turn refreshes units ---------- */
section("turn refresh");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);
  const foot = ready("foot", home);
  G.moveUnit(foot.id, [...G.reachable(foot).keys()][0]);
  check("the unit is spent", G.canMove(foot) === false);

  G.endTurn(); G.rollDice(DOUBLES);
  check("an opponent cannot order your unit", G.moveUnit(foot.id, home.id) === false);
  check("your unit stays spent on their turn", foot.moved > 0);

  G.endTurn(); G.rollDice(DOUBLES);
  check("your own turn refreshes it", G.canMove(foot) === true && foot.moved === 0);
  check("units survive across turns", G.game.units.has(foot.id));

  /* a new board wipes the armies */
  G.setBoard(generateBoard("other", 13, 15));
  check("a new board clears units", G.game.units.size === 0);
  check("unit ids restart", G.game.nextUnit === 1);
}

/* ---------- ports ---------- */
section("ports");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);

  const net = G.networkVerts(me);
  const reaches = t => b.corners[t.id].some(c => net.has(c));

  check("a port must be on water",
    b.tiles.filter(settleable).every(t => G.legalPort(me, t) === false));
  check("open ocean is not a harbour",
    b.tiles.filter(t => isWater(t) && !G.around(t).some(settleable))
      .every(t => G.isHarbour(t) === false && G.legalPort(me, t) === false));
  check("a harbour is water touching land",
    b.tiles.filter(G.isHarbour).every(t => isWater(t) && G.around(t).some(settleable)));
  check("a port must be reachable",
    b.tiles.filter(t => G.isHarbour(t) && !reaches(t))
      .every(t => G.legalPort(me, t) === false));
  check("unreachable ports say so", (() => {
    const t = b.tiles.find(x => G.isHarbour(x) && !reaches(x));
    return !t || G.whyPortIllegal(me, t) === "Your network does not reach that tile";
  })());
  check("land tiles say why", (() => {
    const t = b.tiles.find(settleable);
    return G.whyPortIllegal(me, t) === "Ports go on water";
  })());

  /* sail out far enough that a coastal tile comes into reach */
  let builds = 0;
  while (builds < 12 && !b.tiles.some(t => G.legalPort(me, t))) {
    const e = b.edges.find(x => G.legalEdge(me, x.id));
    if (!e) break;
    G.buildEdge(e.id); builds++;
  }
  const sites = b.tiles.filter(t => G.legalPort(me, t));
  check("roads bring a harbour into reach", sites.length > 0, `after ${builds} builds`);
  check("every site is water touching land", sites.every(G.isHarbour));

  const site = sites[0], before = hand(me);
  check("the port is built", G.buildPort(site) === true);
  check("it belongs to its builder", G.game.ports.get(site.id) === me);
  check("the port stands on water", isWater(site));
  check("wood, ore and wheat are paid", Object.entries(COSTS.port)
    .every(([k, n]) => G.game.hands[me][k] === before[k] - n));
  check("no other resource is spent", RESOURCES.filter(f => !(f in COSTS.port))
    .every(f => G.game.hands[me][f] === before[f]));
  check("the same tile cannot take two ports", G.buildPort(site) === false);
  check("a port is not a town", G.game.towns.has(site.id) === false);
  check("a port does not block its own edges",
    G.tileEdges(site).some(id => G.legalEdge(me, id) || G.game.roads.has(id)));

  G.game.hands[me].wheat = 0;
  check("no wheat, no port", b.tiles.every(t => G.legalPort(me, t) === false));

  /* a port built on a fish tile works the shallows it stands in */
  rich(me);
  const onFish = b.tiles.filter(t => G.legalPort(me, t) && t.terrain === "fish")[0];
  const onSea = b.tiles.filter(t => G.legalPort(me, t) && t.terrain === "sea")[0];
  check("a deep-water port earns nothing", (() => {
    if (!onSea) return true;
    const before = G.yieldOf(me, "fish");
    G.buildPort(onSea);
    return G.yieldOf(me, "fish") === before;
  })());
  check("a port on a fish tile lands an extra fish", (() => {
    if (!onFish) return true;
    const before = G.yieldOf(me, "fish");
    G.buildPort(onFish);
    return G.yieldOf(me, "fish") === before + 1;
  })(), onFish ? "" : "(no reachable fish tile in this fixture)");
  check("and only fish", onFish
    ? RESOURCES.filter(f => f !== "fish").every(f => G.yieldOf(me, f) === 1) : true);
}

/* ---------- boats ---------- */
section("boats");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);

  /* reach the coast and open a port */
  let builds = 0;
  while (builds < 12 && !b.tiles.some(t => G.legalPort(me, t))) {
    const e = b.edges.find(x => G.legalEdge(me, x.id));
    if (!e) break;
    G.buildEdge(e.id); builds++;
  }
  const port = b.tiles.filter(t => G.legalPort(me, t))[0];
  check("a port site was found", !!port);
  if (!port) throw new Error("no port site");

  check("no port, no boat", G.game.board.tiles
    .filter(isWater).every(t => G.legalRecruit(me, "boat", t) === false));
  G.buildPort(port);

  check("boats launch from the port tile itself",
    G.legalRecruit(me, "boat", port) === true);
  check("boats cannot launch on land",
    b.tiles.filter(settleable).every(t => G.legalRecruit(me, "boat", t) === false));
  check("boats cannot launch on water that is not a port", b.tiles
    .filter(t => isWater(t) && !G.game.ports.has(t.id))
    .every(t => G.legalRecruit(me, "boat", t) === false));

  const before = hand(me);
  const boat = ready("boat", port);
  check("the boat exists", !!boat && boat.kind === "boat");
  check("every part of the hull is paid for", Object.entries(UNITS.boat.cost)
    .every(([k, n]) => G.game.hands[me][k] === before[k] - n));
  check("a crew has to be fed", "fish" in UNITS.boat.cost
    && G.game.hands[me].fish === before.fish - 1);
  check("no wheat goes into a boat", G.game.hands[me].wheat === before.wheat);

  /* boats sail on water, never onto land */
  const sea = G.reachable(boat);
  check("a boat reaches 2 tiles", [...sea.values()].some(s => s === 2 * STEP));
  check("a boat stays on water", [...sea.keys()].every(id => isWater(b.tiles[id])));
  check("a boat never reaches land", [...sea.keys()].every(id => !settleable(b.tiles[id])));

  /* range: exactly 2, never adjacent */
  const adj = G.around(b.tiles[boat.tile]).find(t => isWater(t) && !G.unitAt(t.id));
  const near = place(1 - me, "boat", adj);
  check("an adjacent enemy is out of range", G.inRange(boat, b.tiles[near.tile]) === false);
  check("adjacent enemies are not targets", G.targetsOf(boat).includes(near) === false);
  check("attacking adjacent is refused", G.attackUnit(boat.id, near.tile) === false);
  check("the refused shot cost nothing", boat.acted === false && near.lives === UNITS.boat.lives);

  const two = b.tiles.find(t => hexDist(t, b.tiles[boat.tile]) === 2 && !G.unitAt(t.id));
  const far = place(1 - me, "foot", two);
  check("an enemy at 2 is in range", G.inRange(boat, two) === true);
  check("boats can hit land units", settleable(two) ? G.targetsOf(boat).includes(far) : true);
  check("the shot lands", G.attackUnit(boat.id, two.id) === true);
  check("it deals 1 damage", far.lives === UNITS.foot.lives - 1);

  /* land units can hit an adjacent boat back */
  const marine = place(1 - me, "foot", G.around(b.tiles[boat.tile]).find(t => settleable(t) && !G.unitAt(t.id)) || two);
  if (marine.tile !== two.id) {
    G.endTurn(); G.rollDice(DOUBLES);
    check("a land unit may strike an adjacent boat",
      G.attackUnit(marine.id, boat.tile) === true);
    check("the boat takes the hit", boat.lives === UNITS.boat.lives - 1);
    boat.moved = 0; boat.acted = false;
    check("a wounded boat can still sail", G.canMove(boat) === true);
    check("and a wounded boat can still shoot", G.canAttack(boat) === true);
  }
}

/* ---------- boats repair only at a port ---------- */
section("boat repair");
{
  const b = fresh(2);
  const me = G.game.current;
  rich(me);
  let builds = 0;
  while (builds < 12 && !b.tiles.some(t => G.legalPort(me, t))) {
    const e = b.edges.find(x => G.legalEdge(me, x.id));
    if (!e) break;
    G.buildEdge(e.id); builds++;
  }
  const port = b.tiles.filter(t => G.legalPort(me, t))[0];
  if (!port) throw new Error("no port site");
  G.buildPort(port);

  const boat = ready("boat", port);
  boat.lives = 1;
  check("the boat is injured", G.injured(boat) === true);
  check("an injured boat is sitting in its port", G.atPort(boat) === true);

  /* a hull is planked back up with wood, not fed with fish */
  check("a boat repairs with wood",
    JSON.stringify(G.repairCost(boat)) === JSON.stringify({ wood: 1 }));
  check("a land unit still repairs with fish", (() => {
    const foot = place(me, "foot", G.around(port).find(t => settleable(t) && !G.unitAt(t.id)));
    return JSON.stringify(G.repairCost(foot)) === JSON.stringify(COSTS.revive);
  })());
  G.game.hands[me].wood = 0; G.game.hands[me].fish = 9;
  check("fish does not mend a hull", G.canRevive(boat) === false);
  check("and it says what is needed",
    G.whyNoRevive(boat) === `Needs ${G.costLabel({ wood: 1 })}`);
  G.game.hands[me].wood = 3;
  check("it may revive at the port", G.canRevive(boat) === true);
  const timber = G.game.hands[me].wood, fishHeld = G.game.hands[me].fish;
  check("reviving restores it", G.reviveUnit(boat.id) === true && boat.lives === UNITS.boat.lives);
  check("the repair cost a wood, not a fish",
    G.game.hands[me].wood === timber - 1 && G.game.hands[me].fish === fishHeld);

  /* sail away, then it may not repair */
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  const away = [...G.reachable(boat).keys()].find(id => G.game.ports.get(id) !== me);
  check("open water exists away from the port", away !== undefined);
  if (away !== undefined) {
    G.moveUnit(boat.id, away);
    boat.lives = 1; boat.moved = 0; boat.acted = false;
    check("away from port it is not at a port", G.atPort(boat) === false);
    check("it cannot repair at sea", G.canRevive(boat) === false);
    check("reviving at sea is refused", G.reviveUnit(boat.id) === false);
    check("an injured boat may still sail", G.canMove(boat) === true);
    check("an injured land unit may retreat too", (() => {
      const foot = place(me, "foot", b.tiles.find(t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id)));
      foot.lives = 1;
      return G.canMove(foot) === true;
    })());
  }
}

/* ---------- blockade ---------- */
section("blockade");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me);
  let builds = 0;
  while (builds < 12 && !b.tiles.some(t => G.legalPort(me, t))) {
    const e = b.edges.find(x => G.legalEdge(me, x.id));
    if (!e) break;
    G.buildEdge(e.id); builds++;
  }
  const port = b.tiles.filter(t => G.legalPort(me, t))[0];
  if (!port) throw new Error("no port site");
  G.buildPort(port);

  check("an open port offers a berth", G.hasBerth(me, "boat") === true);
  check("an open port is not blockaded", G.blockaders(me).length === 0);

  /* an enemy boat sails into the harbour */
  const raider = place(foe, "boat", G.around(port).find(t => isWater(t) && !G.unitAt(t.id)) || port);
  if (raider.tile !== port.id) {
    check("an enemy boat may enter your port", G.reachable(raider).has(port.id) === true,
      "ports are open water, unlike towns");
    G.game.units.delete(raider.id);
  }
  const siege = place(foe, "boat", port);

  /* only boats may sit in a harbour: no marching column can shut a port down */
  check("a land unit can never enter a port", (() => {
    const shore = G.around(port).find(t => settleable(t) && !G.unitAt(t.id)
      && !G.game.towns.has(t.id));
    if (!shore) return true;
    const marine = place(foe, "foot", shore);
    /* bridge the port tile so the only thing stopping him is the harbour itself */
    const edge = G.tileEdges(port).find(id => b.edges[id] && !G.game.roads.has(id)
      && G.edgeKinds(b.edges[id]).includes("bridge"));
    if (edge !== undefined) G.game.roads.set(edge, { owner: foe, bridge: true });
    const barred = G.reachable(marine).has(port.id) === false;
    const bridgedNow = G.bridged(port.id);
    G.game.units.delete(marine.id);
    if (edge !== undefined) G.game.roads.delete(edge);
    return barred && bridgedNow;      // bridged, and still refused
  })(), "a bridged port tile must still refuse infantry");

  check("the port is blockaded", G.blockaders(me).length === 1);
  check("no berth while blockaded", G.hasBerth(me, "boat") === false);
  check("launching is refused", G.legalRecruit(me, "boat", port) === false);
  check("the refusal names the blockade", (() => {
    G.recruit("boat", port);
    return G.game.notice === "That port is blockaded";
  })());

  /* the blockader cannot use your harbour as its own */
  siege.lives = 1;
  check("the raider cannot repair in your port", G.atPort(siege) === false);
  check("and reviving there is refused", (() => {
    G.endTurn(); G.rollDice(DOUBLES);
    siege.moved = 0; siege.acted = false;
    return G.canRevive(siege) === false && G.reviveUnit(siege.id) === false;
  })());

  /* your own injured boat cannot get home while the tile is occupied */
  G.endTurn(); G.rollDice(DOUBLES);
  const mine = place(me, "boat", G.around(port).find(t => isWater(t) && !G.unitAt(t.id)));
  mine.lives = 1;
  check("your boat cannot enter its own blockaded port",
    G.reachable(mine).has(port.id) === false);
  check("and so cannot repair", G.canRevive(mine) === false);

  /* break the siege and the port works again */
  G.game.units.delete(siege.id);
  check("lifting the blockade restores the berth", G.hasBerth(me, "boat") === true);
  check("and the port is clear", G.blockaders(me).length === 0);
  check("your boat can sail home again", G.reachable(mine).has(port.id) === true);
  G.moveUnit(mine.id, port.id);
  mine.moved = 0; mine.acted = false;
  check("and repair once berthed", G.atPort(mine) === true && G.canRevive(mine) === true);

  /* towns stay closed to enemies, unlike ports */
  const foot = place(foe, "foot", G.around(G.townsOf(me)[0]).find(t => settleable(t) && !G.unitAt(t.id)));
  check("enemy towns remain closed",
    G.reachable(foot).has(G.townsOf(me)[0].id) === false);
}

/* ---------- cannon ---------- */
section("cannon");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me, home = G.townsOf(me)[0];

  /* a siege piece: 2 ore + 2 wood, dearer than the horseman that counters it */
  G.game.hands[me] = { wood: 2, wool: 0, fish: 0, wheat: 0, ore: 1 };
  check("1 ore is not enough", G.canAffordUnit(me, "cannon") === false);
  G.game.hands[me] = { wood: 1, wool: 0, fish: 0, wheat: 0, ore: 2 };
  check("1 wood is not enough", G.canAffordUnit(me, "cannon") === false);
  G.game.hands[me] = { wood: 2, wool: 0, fish: 0, wheat: 0, ore: 2 };
  check("2 ore and 2 wood buy a cannon", G.canAffordUnit(me, "cannon") === true);
  check("a cannon needs no wool, wheat or fish",
    ["wool", "wheat", "fish"].every(f => G.game.hands[me][f] === 0));
  check("its counter is cheaper than it is", (() => {
    const sum = c => Object.values(c).reduce((a, n) => a + n, 0);
    return sum(UNITS.horse.cost) < sum(UNITS.cannon.cost);
  })(), "a horseman must cost less than the gun it closes on");

  const before = hand(me);
  const gun = ready("cannon", home);
  check("the cannon musters on a town", gun.tile === home.id);
  check("ore and wood are spent", G.game.hands[me].ore === before.ore - 2
    && G.game.hands[me].wood === before.wood - 2);
  check("nothing else is spent",
    ["wool", "wheat", "fish"].every(f => G.game.hands[me][f] === before[f]));

  /* range 2 to 3: never adjacent, never 4 out */
  check("the range band is 2 to 3", G.rangeLabel("cannon") === "2–3");
  const at = d => b.tiles.find(t => hexDist(t, b.tiles[gun.tile]) === d && !G.unitAt(t.id)
    && !G.game.towns.has(t.id));
  const adj = at(1), two = at(2), three = at(3), four = at(4);
  check("adjacent is out of range", G.inRange(gun, adj) === false);
  check("2 tiles is in range", G.inRange(gun, two) === true);
  check("3 tiles is in range", G.inRange(gun, three) === true);
  check("4 tiles is out of range", G.inRange(gun, four) === false);

  const close = place(foe, "foot", adj);
  check("an adjacent enemy is not a target", G.targetsOf(gun).includes(close) === false);
  check("firing on an adjacent enemy is refused", G.attackUnit(gun.id, adj.id) === false);
  check("the refusal explains the band", G.game.notice === "That unit strikes at 2–3 tiles");
  check("the refused shot cost nothing", gun.acted === false && close.lives === UNITS.foot.lives);

  const far = place(foe, "horse", three);
  check("an enemy at 3 is a target", G.targetsOf(gun).includes(far) === true);
  check("the shot lands", G.attackUnit(gun.id, three.id) === true);
  check("it deals the standard 1 damage", far.lives === UNITS.horse.lives - 1);
  check("firing ends the cannon's turn", gun.acted === true);

  /* moving means it cannot fire, exactly like a foot soldier */
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check("the cannon refreshed", G.canMove(gun) === true && G.canAttack(gun) === true);
  check("a cannon moves 1 tile", [...G.reachable(gun).values()].every(s => s === STEP));
  G.moveUnit(gun.id, [...G.reachable(gun).keys()][0]);
  check("a cannon that moved cannot fire", G.canAttack(gun) === false);
}

/* ---------- a cannon never repairs, but can retreat ---------- */
section("cannon damage");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);
  const gun = ready("cannon", home);
  gun.lives = 1;

  check("the cannon is injured", G.injured(gun) === true);
  check("it can never revive", G.canRevive(gun) === false);
  check("reviving is refused outright", G.reviveUnit(gun.id) === false);
  check("but a wounded cannon may still move", G.canMove(gun) === true);
  check("and may still fire", G.canAttack(gun) === true);
  check("a wounded foot soldier may withdraw as well", (() => {
    const foot = place(me, "foot", G.around(home).find(t => settleable(t) && !G.unitAt(t.id)));
    foot.lives = 1;
    return G.canMove(foot) === true;
  })());

  const away = [...G.reachable(gun).keys()][0];
  check("it retreats", G.moveUnit(gun.id, away) === true && gun.tile === away);
  check("and is still injured after retreating", G.injured(gun) === true);
}

/* ---------- cannons shell boats ---------- */
section("cannon versus boat");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me;
  rich(me);

  /* find a land tile with water 2 or 3 tiles away, and put a gun on it */
  let gunTile = null, seaTile = null;
  for (const t of b.tiles) {
    if (!settleable(t) || G.game.towns.has(t.id) || G.unitAt(t.id)) continue;
    const target = b.tiles.find(w => isWater(w) && !G.unitAt(w.id)
      && [2, 3].includes(hexDist(w, t)));
    if (target) { gunTile = t; seaTile = target; break; }
  }
  check("a coastal firing position exists", !!gunTile && !!seaTile);

  if (gunTile) {
    const gun = place(me, "cannon", gunTile);
    const target = place(foe, "boat", seaTile);
    check("a land cannon can target a boat at sea", G.targetsOf(gun).includes(target));
    check("the shell lands", G.attackUnit(gun.id, seaTile.id) === true);
    check("the boat is damaged", target.lives === UNITS.boat.lives - 1);
    check("a cannon stays on land", [...G.reachable(gun).keys()]
      .every(id => settleable(b.tiles[id])));
  }
}

/* ---------- walls ---------- */
section("walls");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me, home = G.townsOf(me)[0];

  G.game.hands[me] = { wood: 1, wool: 0, fish: 0, wheat: 0, ore: 2 };
  check("1 wood is not enough", G.legalWall(me, home) === false);
  G.game.hands[me].wood = 2;
  check("2 ore and 2 wood build a wall", G.legalWall(me, home) === true);

  check("walls need a town", (() => {
    const open = b.tiles.find(t => settleable(t) && !G.game.towns.has(t.id));
    return G.legalWall(me, open) === false
      && G.whyWallIllegal(me, open) === "Walls go around a town";
  })());
  check("you cannot wall someone else's town", (() => {
    const theirs = b.tiles[[...G.game.towns].find(([, o]) => o !== me)[0]];
    return G.legalWall(me, theirs) === false
      && G.whyWallIllegal(me, theirs) === "That is not your town";
  })());

  const before = hand(me);
  check("the wall goes up", G.buildWall(home) === true);
  check("ore and wood are paid", Object.entries(COSTS.wall)
    .every(([k, n]) => G.game.hands[me][k] === before[k] - n));
  check("a new wall has 4 lives", G.wallAt(home.id).lives === WALL.lives);
  check("it belongs to its builder", G.wallAt(home.id).owner === me);
  check("the tile is sheltered", G.sheltered(home.id) === true);
  rich(me);
  check("a town cannot be walled twice", G.buildWall(home) === false);
  check("and it says why", G.game.notice === "Already walled");
}

/* ---------- only siege weapons touch a wall ---------- */
section("wall under siege");
{
  const b = fresh(2);
  const me = G.game.current, foe = 1 - me, home = G.townsOf(me)[0];
  rich(me);
  G.buildWall(home);
  const garrison = ready("foot", home);

  /* infantry: cannot hurt the wall, cannot reach what is behind it */
  const spot = landNear(home);
  const raider = place(foe, "foot", spot);
  check("a sheltered unit is not a target", G.targetsOf(raider).includes(garrison) === false);
  check("infantry cannot batter a wall", G.wallTargetsOf(raider).length === 0);

  G.endTurn(); G.rollDice(DOUBLES);
  check("it is the raider's turn", G.game.current === foe);
  check("infantry attacking a walled tile is refused",
    G.attackUnit(raider.id, home.id) === false);
  check("the refusal names the wall",
    G.game.notice === "A foot soldier cannot breach a wall");
  check("the garrison is untouched", garrison.lives === UNITS.foot.lives);
  check("the wall is untouched", G.wallAt(home.id).lives === WALL.lives);

  /* but the garrison can still shoot out */
  G.endTurn(); G.rollDice(DOUBLES);
  check("back to the defender", G.game.current === me);
  garrison.moved = 0; garrison.acted = false;
  check("a sheltered unit can still attack out",
    G.canAttack(garrison) === true && G.targetsOf(garrison).includes(raider) === true);
  check("and the shot lands", G.attackUnit(garrison.id, raider.tile) === true);
  check("the raider takes damage", raider.lives === UNITS.foot.lives - 1);

  /* a cannon can batter it down: 4 hits */
  const spot3 = b.tiles.find(t => settleable(t) && hexDist(t, home) === 3 && !G.unitAt(t.id));
  check("a firing position at 3 exists", !!spot3);
  const gun = place(foe, "cannon", spot3);
  check("a cannon sees the wall", G.wallTargetsOf(gun).includes(home.id) === true);
  check("but still not the garrison", G.targetsOf(gun).includes(garrison) === false);

  G.endTurn(); G.rollDice(DOUBLES);              // the gun only fires on its owner's turn
  check("it is the besieger's turn", G.game.current === foe);

  for (let hit = 1; hit <= WALL.lives; hit++) {
    gun.moved = 0; gun.acted = false;
    check(`hit ${hit} lands`, G.attackUnit(gun.id, home.id) === true);
    if (hit < WALL.lives) {
      check(`wall down to ${WALL.lives - hit}`, G.wallAt(home.id).lives === WALL.lives - hit);
      check("still sheltered", G.sheltered(home.id) === true);
    }
  }
  check("four hits breach the wall", G.wallAt(home.id) === null);
  check("the tile is no longer sheltered", G.sheltered(home.id) === false);
  check("the garrison is exposed again", G.targetsOf(gun).includes(garrison) === true);

  gun.moved = 0; gun.acted = false;
  check("and can now be shot", G.attackUnit(gun.id, home.id) === true);
  check("the garrison takes the hit", garrison.lives === UNITS.foot.lives - 1);
}

/* ---------- masonry: one course a turn ---------- */
section("wall repair");
{
  const b = fresh(2);
  const me = G.game.current, home = G.townsOf(me)[0];
  rich(me);
  G.buildWall(home);
  const w = G.wallAt(home.id);
  const crew = place(me, "foot", home);          // repairs need hands now

  check("an intact wall needs no repair", G.canRepairWall(me, home) === false);
  check("and it says so", G.whyNoWallRepair(me, home) === "That wall is intact");

  w.lives = 1;
  G.game.hands[me].ore = 0;
  check("no ore, no repair", G.canRepairWall(me, home) === false);
  check("and it says why", G.whyNoWallRepair(me, home) === `Needs ${G.costLabel(WALL.repair)}`);

  G.game.hands[me].ore = 5;
  check("repair is available", G.canRepairWall(me, home) === true);
  check("repairing works", G.repairWall(home) === true);
  check("one life is restored", w.lives === 2);
  check("one ore is spent", G.game.hands[me].ore === 4);
  check("only one repair per turn", G.canRepairWall(me, home) === false);
  check("a second repair is refused", G.repairWall(home) === false);
  check("and it says why",
    G.game.notice === "Something there has already been repaired this turn");
  /* the allowance is shared: having mended the wall, the masonry must wait too */
  G.game.townHurt.set(home.id, 1);
  check("the town cannot also be rebuilt this turn", G.canRepairTown(me, home) === false);
  G.game.townHurt.delete(home.id);
  check("and without a crew nothing can be repaired at all", (() => {
    G.game.units.delete(crew.id);
    const no = G.canRepairWall(me, home) === false;
    G.game.units.set(crew.id, crew);
    return no;
  })());

  /* next turn the masons are back */
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check("back to the wall's owner", G.game.current === me);
  check("repair is available again", G.canRepairWall(me, home) === true);
  G.repairWall(home);
  check("and restores another life", w.lives === 3);

  /* never past full */
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  G.repairWall(home);
  check("a wall reaches full strength", w.lives === WALL.lives);
  G.endTurn(); G.rollDice(DOUBLES); G.endTurn(); G.rollDice(DOUBLES);
  check("and never goes past it", G.canRepairWall(me, home) === false);
  check("repair beyond full is refused", G.repairWall(home) === false);
}

console.log(failures
  ? `\n${failures} FAILURES out of ${total} checks`
  : `\nall ${total} checks passed`);
process.exit(failures ? 1 : 0);
