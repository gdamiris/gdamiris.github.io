/* All game state and rules. No DOM access lives here, which is what lets the
   whole rule set be driven headlessly from tests (and later from netcode). */

import { PLAYERS, DIE_FACES, RULES } from "./config.js";
import { TERRAIN, settleable, isWater, isBlocked } from "./terrain.js";
import { hexDist, neighbours } from "./hex.js";

export const blankHand = () => Object.fromEntries(DIE_FACES.map(f => [f, 0]));

export const game = {
  board: null,
  phase: "idle",            // idle | placing | play
  playerCount: 3,
  towns: new Map(),         // tile id -> player index
  turn: 0,                  // placement cursor
  hands: PLAYERS.map(blankHand),
  turnNo: 0,
  current: 0,               // whose turn it is
  roller: null,             // who rolled the dice currently on screen
  awaiting: false,          // a die still needs choosing
  dice: [null, null],
  keptIndex: null,
  notice: "",               // transient feedback for the status line
  varietyReq: RULES.MIN_VARIETY,
  events: [],               // newest-first log, rendered by the panel
};

export const emit = html => { game.events.unshift(html); game.events.length = Math.min(game.events.length, 80); };

/* ---------- geography helpers ---------- */
export const around = t => neighbours(game.board, t);
export const tileById = id => game.board.tiles[id];
export const townsOf = pi => [...game.towns].filter(([, o]) => o === pi).map(([id]) => tileById(id));
export const footprint = pi => townsOf(pi).flatMap(t => [t, ...around(t)]);

/* A town yields at most 1 of a resource per roll, however many matching tiles it touches. */
export const yieldOf = (pi, res) =>
  townsOf(pi).filter(t => t.terrain === res || around(t).some(n => n.terrain === res)).length;

/* ---------- placement rules ---------- */
export function legalTown(t) {
  if (isBlocked(t) || isWater(t)) return false;
  if (game.towns.has(t.id)) return false;
  for (const id of game.towns.keys()) if (hexDist(t, tileById(id)) < RULES.MIN_TOWN_GAP) return false;
  const foot = [t, ...around(t)];
  if (foot.length < RULES.MIN_FOOTPRINT) return false;
  const kinds = new Set(foot.map(x => x.terrain).filter(x => DIE_FACES.includes(x)));
  return kinds.size >= game.varietyReq;
}

export function whyIllegal(t) {
  if (isWater(t)) return "No towns on water";
  if (isBlocked(t)) return "No towns at sea";
  if (game.towns.has(t.id)) return "Already settled";
  for (const id of game.towns.keys()) if (hexDist(t, tileById(id)) < RULES.MIN_TOWN_GAP) return "Too close to another town";
  if ([t, ...around(t)].length < RULES.MIN_FOOTPRINT) return "Too little land around that tile";
  return `Needs ${game.varietyReq} different resources nearby`;
}

export const legalCount = () => game.board.tiles.filter(legalTown).length;

/* Placement must never dead-end: relax the variety rule rather than stall. */
export function ensureSites() {
  while (legalCount() === 0 && game.varietyReq > 1) {
    game.varietyReq--;
    emit(`No sites left — variety requirement relaxed to ${game.varietyReq}`);
  }
}

/* ---------- lifecycle ---------- */
function clearRound() {
  game.towns = new Map(); game.turn = 0; game.turnNo = 0; game.current = 0;
  game.roller = null; game.awaiting = false; game.dice = [null, null];
  game.keptIndex = null; game.notice = ""; game.varietyReq = RULES.MIN_VARIETY;
  game.hands = PLAYERS.map(blankHand);
}

export function setBoard(board) { game.board = board; game.phase = "idle"; clearRound(); }
export function setPlayers(n)   { game.playerCount = n; game.phase = "idle"; clearRound(); }

export function startGame() {
  clearRound();
  game.phase = "placing";
  ensureSites();
  const sites = legalCount();
  emit(`— new game, ${game.playerCount} players · ${sites} legal sites —`);
  if (sites < game.playerCount) emit(`<span class="bad">Board is too tight for ${game.playerCount} — reroll or size up</span>`);
}

export function resetGame() { clearRound(); game.phase = "idle"; emit("— reset —"); }

/* ---------- actions ---------- */
export function placeTown(t) {
  if (game.phase !== "placing") return false;
  if (!legalTown(t)) { game.notice = whyIllegal(t); return false; }
  game.notice = "";
  game.towns.set(t.id, game.turn);
  emit(`<b style="color:${PLAYERS[game.turn].color}">${PLAYERS[game.turn].name}</b> settles ${TERRAIN[t.terrain].label} at ${t.col},${t.row}`);
  game.turn++;
  if (game.turn >= game.playerCount) {
    game.phase = "play"; game.current = 0; game.turnNo = 1;
    emit(`All towns placed — turn 1, ${PLAYERS[0].name} to roll`);
  } else ensureSites();
  return true;
}

export function rollDice(rand = Math.random) {
  if (game.phase !== "play" || game.awaiting) return false;
  game.dice = [DIE_FACES[Math.floor(rand() * 6)], DIE_FACES[Math.floor(rand() * 6)]];
  game.keptIndex = null; game.awaiting = true; game.roller = game.current; game.notice = "";
  const [a, b] = game.dice;
  emit(`<b>Turn ${game.turnNo}</b> · ${PLAYERS[game.current].name} rolled ${TERRAIN[a].label} + ${TERRAIN[b].label}`);
  if (a === b) { resolveRoll(0); return true; }   // doubles leave no choice
  return true;
}

/* The roller keeps one die; the other resource goes to everyone else. */
export function resolveRoll(keepIdx) {
  if (!game.awaiting) return false;
  if (game.roller === null) game.roller = game.current;
  const mine = game.dice[keepIdx], theirs = game.dice[1 - keepIdx];
  game.keptIndex = keepIdx;

  const parts = [];
  for (let i = 0; i < game.playerCount; i++) {
    const res = i === game.current ? mine : theirs;
    const n = yieldOf(i, res);
    game.hands[i][res] += n;
    if (n) parts.push(`<b style="color:${PLAYERS[i].color}">${PLAYERS[i].name}</b> +${n} ${TERRAIN[res].label}`);
  }
  emit(parts.length ? "→ " + parts.join(", ") : "→ nobody produces");

  game.awaiting = false;
  game.turnNo++;
  game.current = (game.current + 1) % game.playerCount;
  return true;
}

export { settleable };
