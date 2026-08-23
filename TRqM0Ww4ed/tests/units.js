/* Unit rules: recruiting, the action economy, movement, damage and revival.
   Run with: node tests/units.js

   The action economy is the fiddly part — a foot soldier moves OR acts, a horseman may
   spend one of its two steps and still attack, and an injured unit cannot move at all. */

import { DIE_FACES, UNITS, COSTS } from "../src/config.js";
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

function seedTowns(n) {
  const b = G.game.board;
  const inland = t => t.col > 1 && t.row > 1 && t.col < b.cols - 2 && t.row < b.rows - 2;
  for (let p = 0; p < n; p++) {
    const opts = b.tiles.filter(t => G.legalTown(t) && inland(t));
    const placed = [...G.game.towns.keys()].map(id => b.tiles[id]);
    G.placeTown(placed.length
      ? opts.reduce((best, t) => {
          const d = Math.min(...placed.map(o => hexDist(t, o)));
          return d > best.d ? { t, d } : best;
        }, { t: opts[0], d: -1 }).t
      : opts[Math.floor(opts.length / 2)]);
  }
}

const DOUBLES = () => 0.01;
const rich = (pi, v = 99) => DIE_FACES.forEach(f => G.game.hands[pi][f] = v);
const hand = pi => ({ ...G.game.hands[pi] });

function fresh(n = 2) {
  G.setBoard(generateBoard("halcyon", 13, 15));
  G.setPlayers(n);
  G.startGame();
  seedTowns(n);
  G.rollDice(DOUBLES);
  return G.game.board;
}

/* Recruit and then hand the unit its turn, since a fresh unit is spent on arrival. */
function ready(kind, tile) {
  const id = G.recruit(kind, tile);
  const u = G.game.units.get(id);
  u.moved = 0; u.acted = false;
  return u;
}

/* Drop a unit straight onto a tile, bypassing recruitment, for combat fixtures. */
function place(owner, kind, tile) {
  const id = G.game.nextUnit++;
  const u = { id, owner, kind, tile: tile.id, lives: UNITS[kind].lives, moved: 0, acted: false };
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

  /* the either-cost really is a choice: wool + wood + one of fish|deer */
  G.game.hands[me] = { wood: 1, wool: 1, fish: 1, deer: 0, wheat: 0, ore: 0 };
  check("fish satisfies the either-cost", G.canAffordUnit(me, "foot") === true);
  G.game.hands[me] = { wood: 1, wool: 1, fish: 0, deer: 1, wheat: 0, ore: 0 };
  check("deer satisfies the either-cost", G.canAffordUnit(me, "foot") === true);
  G.game.hands[me] = { wood: 1, wool: 1, fish: 0, deer: 0, wheat: 0, ore: 0 };
  check("neither fish nor deer blocks it", G.canAffordUnit(me, "foot") === false);
  G.game.hands[me] = { wood: 0, wool: 1, fish: 1, deer: 1, wheat: 0, ore: 0 };
  check("missing wood blocks it", G.canAffordUnit(me, "foot") === false);
  G.game.hands[me] = { wood: 1, wool: 1, fish: 1, deer: 1, wheat: 0, ore: 0 };
  check("1 wool is not enough for a horseman", G.canAffordUnit(me, "horse") === false);
  G.game.hands[me].wool = 2;
  check("2 wool buys a horseman", G.canAffordUnit(me, "horse") === true);

  /* recruiting spends exactly one either-resource, and the larger stock is taken */
  rich(me);
  G.game.hands[me].deer = 5; G.game.hands[me].fish = 1;
  const before = hand(me);
  const id = G.recruit("foot", home);
  check("recruiting returns a unit id", typeof id === "number");
  const u = G.game.units.get(id);
  check("the unit stands on the town", u.tile === home.id);
  check("the unit belongs to the recruiter", u.owner === me);
  check("the unit starts at full lives", u.lives === UNITS.foot.lives && !G.injured(u));
  check("wool and wood are spent",
    G.game.hands[me].wool === before.wool - 1 && G.game.hands[me].wood === before.wood - 1);
  check("exactly one either-resource is spent",
    G.game.hands[me].deer === before.deer - 1 && G.game.hands[me].fish === before.fish);
  check("wheat and ore are untouched",
    G.game.hands[me].wheat === before.wheat && G.game.hands[me].ore === before.ore);

  check("a fresh unit cannot act this turn",
    G.canMove(u) === false && G.canAttack(u) === false);
  check("one unit to a tile", G.legalRecruit(me, "foot", home) === false);
  check("cannot recruit on an opponent's town", (() => {
    const theirs = [...G.game.towns].find(([, o]) => o !== me);
    return G.legalRecruit(me, "foot", b.tiles[theirs[0]]) === false;
  })());
  check("cannot recruit on open ground",
    G.legalRecruit(me, "foot", b.tiles.find(t => settleable(t) && !G.game.towns.has(t.id))) === false);

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
  check("a foot soldier reaches 1 tile", [...reach.values()].every(s => s === 1));
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
  check("a horseman reaches 2 tiles out", [...far.values()].some(s => s === 2));
  check("distances are honest", [...far].every(([id, s]) => hexDist(b.tiles[id], home) <= s));

  const oneStep = [...far].find(([, s]) => s === 1)[0];
  G.moveUnit(horse.id, oneStep);
  check("a horseman may still attack after one step", G.canAttack(horse) === true);
  check("and may still take its second step", G.canMove(horse) === true);
  /* not back onto home — the recruit check below needs that tile free */
  const twoStep = [...G.reachable(horse).keys()].find(id => id !== home.id);
  G.moveUnit(horse.id, twoStep);
  check("after two steps it is spent", G.canMove(horse) === false);
  check("and can no longer attack", G.canAttack(horse) === false);

  check("units cannot stack", (() => {
    const other = ready("foot", home);
    return G.moveUnit(other.id, horse.tile) === false;
  })());
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
  check("an injured unit cannot move", G.canMove(victim) === false);
  check("an injured unit may still attack", G.canAttack(victim) === true);
  check("an injured unit may revive", G.canRevive(victim) === true);
  check("reviving works", G.reviveUnit(victim.id) === true);
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
  check("no other resource is spent", DIE_FACES.filter(f => !(f in COSTS.port))
    .every(f => G.game.hands[me][f] === before[f]));
  check("the same tile cannot take two ports", G.buildPort(site) === false);
  check("a port is not a town", G.game.towns.has(site.id) === false);
  check("a port does not block its own edges",
    G.tileEdges(site).some(id => G.legalEdge(me, id) || G.game.roads.has(id)));

  G.game.hands[me].wheat = 0;
  check("no wheat, no port", b.tiles.every(t => G.legalPort(me, t) === false));
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
  check("wood, wool and ore are paid", Object.entries(UNITS.boat.cost)
    .every(([k, n]) => G.game.hands[me][k] === before[k] - n));
  check("no fish is spent on a boat", G.game.hands[me].fish === before.fish);

  /* boats sail on water, never onto land */
  const sea = G.reachable(boat);
  check("a boat reaches 2 tiles", [...sea.values()].some(s => s === 2));
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
  check("it may revive at the port", G.canRevive(boat) === true);
  check("reviving restores it", G.reviveUnit(boat.id) === true && boat.lives === UNITS.boat.lives);

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
    check("an injured land unit may not move", (() => {
      const foot = place(me, "foot", b.tiles.find(t => settleable(t) && !G.unitAt(t.id) && !G.game.towns.has(t.id)));
      foot.lives = 1;
      return G.canMove(foot) === false;
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

console.log(failures
  ? `\n${failures} FAILURES out of ${total} checks`
  : `\nall ${total} checks passed`);
process.exit(failures ? 1 : 0);
