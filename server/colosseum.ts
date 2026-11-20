// The Colosseum: 1v1 duels for Might on a live Gemini market.
//
// A warlord issues a challenge: an army, a stake of Might, and a call (YES/NO + confidence) on an
// open Gemini market. Another warlord accepts with their own army and call on the same market.
// The armies fight at once in the deterministic battle simulator; the winner takes the steel half
// of the pot. The foresight half waits for Gemini to settle the market and goes to the
// better-calibrated call (lower Brier score). A tie splits it.
//
// Odds receipts: each call is committed on Solana the moment it's made, as a memo holding a
// SHA-256 of (duel, player, market, side, confidence, Gemini price, time, salt). The details stay
// hidden until the fight, then they're revealed so anyone can recompute the hash and check the
// call (and the odds it was made at) were fixed before the fight. When the duel settles, the full
// result is sealed in one more memo. The QuickNode Stream marks each receipt confirmed.
import crypto from "node:crypto";
import { armyPower, simulate } from "../shared/battle.js";
import { mulberry32, strSeed } from "../shared/rng.js";
import { COLOSSEUM, UNIT_KEYS, brier, duelPot, sidePriceBps } from "../shared/rules.js";
import { contractPricesBps, isOpen } from "../gemini/client";
import { gemini } from "./bounties";
import { env, explorerTx } from "./config";
import { db, feed, type BattleRecord, type Duel, type DuelSide, type Player, type Receipt } from "./db";
import { oddsSeries, WINDOWS } from "./odds";
import { attackFormation } from "./bounties";
import { GameError, award, boostsOf, vigorOf } from "./players";
import * as chain from "./chain/onchain";
import { runBattle, stamp, verifyAgainstChain, type Decision } from "./chain/arbiter";

const potKeys = (d: Duel) => [`duel:${d.id}:c`, `duel:${d.id}:r`];

const MEMO = "stakeclash:v1";
const now = () => Date.now();
const rnd = mulberry32((Date.now() ^ 0xc0105eed) >>> 0);
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

type ReceiptFn = (r: Receipt) => void;
let postReceipt: ReceiptFn = () => {};
/** index.ts wires this to the Solana memo sender (kept as a hook to avoid an import cycle). */
export const onReceipt = (fn: ReceiptFn) => (postReceipt = fn);

const duels = () => (db.data.duels ??= {});
const stats = (p: Player) => (p.colosseum ??= { duels: 0, steelWins: 0, foresightWins: 0, mightWon: 0 });

export const commitOf = (d: { id: string }, playerId: string, market: string, c: Omit<DuelSide["call"], "commit">) =>
  crypto.createHash("sha256").update(`${MEMO}|${d.id}|${playerId}|${market}|${c.side}|${c.confBps}|${c.priceBps}|${c.at}|${c.salt}`).digest("hex");

// ── Idempotency: a retried request gets the stored answer, never a second duel ─────────────────
function remembered(p: Player, requestId: unknown) {
  const rid = typeof requestId === "string" && REQUEST_ID.test(requestId) ? requestId : null;
  if (!rid) throw new GameError("Missing request id.");
  return { rid, prev: stats(p).claims?.[rid]?.response };
}
function remember<T>(p: Player, rid: string, response: T): T {
  const s = stats(p);
  s.claims ??= {};
  s.claims[rid] = { at: now(), response };
  const keys = Object.keys(s.claims);
  if (keys.length > 40) for (const k of keys.sort((a, b) => s.claims![a].at - s.claims![b].at).slice(0, keys.length - 40)) delete s.claims[k];
  return response;
}

// ── Inputs ────────────────────────────────────────────────────────────
function pickUnits(p: Player, units: unknown) {
  const sent: Record<string, number> = {};
  for (const k of UNIT_KEYS) {
    const n = Math.max(0, Math.floor(Number((units as any)?.[k] ?? 0) || 0));
    if (n > (p.army[k] ?? 0)) throw new GameError(`You only have ${p.army[k] ?? 0} ${k}.`);
    if (n) sent[k] = n;
  }
  if (!Object.keys(sent).length) throw new GameError("Send at least one unit into the arena.");
  return sent;
}

function pickCall(side: unknown, confBps: unknown) {
  if (side !== "yes" && side !== "no") throw new GameError("Pick YES or NO.");
  const conf = Math.round(Number(confBps));
  if (!(conf >= COLOSSEUM.minConfBps && conf <= COLOSSEUM.maxConfBps)) throw new GameError("Confidence must be between 50% and 99%.");
  return { side: side as "yes" | "no", confBps: conf };
}

/** The market's live Gemini quote. Throws if it isn't open and priced right now. */
async function liveQuote(market: string) {
  const found = await gemini.findContract(market);
  if (!found || !isOpen(found.contract)) throw new GameError("That market isn't open on Gemini right now.");
  const q = contractPricesBps(found.contract);
  if (q.bestBidBps === null || q.bestAskBps === null) throw new GameError("No price from Gemini right now. Try again in a moment.");
  const label = (found.contract.label ?? "").trim();
  const title = found.event.title ?? found.event.ticker;
  const question = !label || label.length < 14 || /^(yes|no)$/i.test(label) ? `${title}${label ? `: ${label}` : ""}` : label;
  return { bid: q.bestBidBps, ask: q.bestAskBps, question, eventTitle: title, category: found.event.category ?? "", expiry: found.contract.expiryDate ?? found.event.expiryDate ?? null };
}

function sideFor(d: Duel, p: Player, units: Record<string, number>, call: { side: "yes" | "no"; confBps: number }, priceBps: number): DuelSide {
  const formation = attackFormation(p, units, {});
  const boosts = boostsOf(p);
  const vigor = vigorOf(p);
  const c = { ...call, priceBps, at: now(), salt: crypto.randomBytes(8).toString("hex") };
  const commit = commitOf(d, p.id, d.market, c);
  return {
    playerId: p.id,
    name: p.name,
    bot: !!p.bot,
    ...(p.wallet?.address ? { wallet: p.wallet.address } : {}),
    units,
    levels: { ...p.unitLevels },
    ...(boosts ? { boosts } : {}),
    ...(vigor ? { vigor } : {}),
    formation,
    power: armyPower(units, p.unitLevels),
    call: { ...c, commit },
    receipt: { memo: `${MEMO}:call:${d.id}:${p.id}:${commit}`, status: "sending" },
  };
}

// ── Challenge, accept, cancel ─────────────────────────────────────────
export async function issueChallenge(p: Player, body: any) {
  const { rid, prev } = remembered(p, body?.requestId);
  if (prev) return prev;
  const units = pickUnits(p, body?.units);
  const call = pickCall(body?.side, body?.confBps);
  const stake = Math.max(0, Math.floor(Number(body?.stake) || 0));
  if (stake > COLOSSEUM.maxStake) throw new GameError(`The most you can stake is ${COLOSSEUM.maxStake} Might.`);
  if (stake > (p.might ?? 0)) throw new GameError(`You have ${p.might ?? 0} Might. Earn more from realized yield in the Treasury (T), or duel for glory with a stake of 0.`);
  const mineOpen = Object.values(duels()).filter((d) => d.status === "open" && d.challenger.playerId === p.id);
  if (mineOpen.length >= COLOSSEUM.openPerPlayer) throw new GameError(`You already have ${COLOSSEUM.openPerPlayer} open challenges. Cancel one or wait for a rival.`);
  const market = String(body?.market ?? "");
  const q = await liveQuote(market);
  // re-check after the await: another request may have spent the Might meanwhile
  const again = remembered(p, rid);
  if (again.prev) return again.prev;
  if (stake > (p.might ?? 0)) throw new GameError(`You have ${p.might ?? 0} Might.`);

  const seq = (db.data.meta.duelSeq = (db.data.meta.duelSeq ?? 0) + 1);
  const d: Duel = {
    id: `D-${String(seq).padStart(4, "0")}`,
    createdAt: now(),
    status: "open",
    stake,
    market,
    question: q.question,
    eventTitle: q.eventTitle,
    category: q.category,
    expiry: q.expiry,
    practice: env.geminiMode === "mock",
    challenger: null as unknown as DuelSide,
    botAt: env.bots ? now() + COLOSSEUM.botAcceptSec * 1000 : undefined,
  };
  d.challenger = sideFor(d, p, units, call, sidePriceBps(call.side, q.bid, q.ask));
  p.might = (p.might ?? 0) - stake; // held in escrow until the duel is fought or cancelled
  chain.onStake(p, potKeys(d)[0], stake, `duel:${d.id}`);
  duels()[d.id] = d;
  feed({ kind: "duel", text: `${p.name} laid down a Colosseum challenge: ${stake ? `${stake} Might` : "for glory"} on “${d.question}”`, duel: d.id, player: p.id });
  db.save();
  postReceipt(d.challenger.receipt!);
  return remember(p, rid, { duel: duelView(d, p), might: p.might });
}

export async function acceptChallenge(p: Player, id: string, body: any) {
  const { rid, prev } = remembered(p, body?.requestId);
  if (prev) return prev;
  const d = duels()[id];
  if (!d) throw new GameError("No such duel.", 404);
  if (d.challenger.playerId === p.id) throw new GameError("You can't accept your own challenge.");
  if (d.status !== "open") throw new GameError("Someone already answered this challenge.");
  const units = pickUnits(p, body?.units);
  const call = pickCall(body?.side, body?.confBps);
  if (d.stake > (p.might ?? 0)) throw new GameError(`This duel needs ${d.stake} Might and you have ${p.might ?? 0}.`);
  const q = await liveQuote(d.market);
  const again = remembered(p, rid);
  if (again.prev) return again.prev;
  if (d.status !== "open") throw new GameError("Someone already answered this challenge.");
  if (d.stake > (p.might ?? 0)) throw new GameError(`This duel needs ${d.stake} Might.`);
  p.might = (p.might ?? 0) - d.stake;
  chain.onStake(p, potKeys(d)[1], d.stake, `duel:${d.id}`);
  d.rival = sideFor(d, p, units, call, sidePriceBps(call.side, q.bid, q.ask));
  postReceipt(d.rival.receipt!);
  // the chain decides the fight; while it does, nobody else can answer this challenge
  d.status = "fighting";
  return runBattle(
    duelInput(d),
    (dec) => {
      const rec = fight(d, dec);
      p.lastCombatAt = now();
      return remember(p, rid, { duel: duelView(d, p), battle: rec, might: p.might });
    },
    {
      lockPlayer: p,
      onCancel: () => {
        // the chain never decided: give the stake back and reopen the challenge
        d.status = "open";
        d.rival = undefined;
        p.might = (p.might ?? 0) + d.stake;
        chain.onRelease(potKeys(d)[1], p, d.stake, 0, `duel:${d.id}:cancel`);
        db.save();
      },
    },
  );
}

/** The duel as the program sees it: the rival attacks, the challenger defends. */
function duelInput(d: Duel) {
  const a = d.rival!;
  const c = d.challenger;
  const side = (x: DuelSide, towers?: number) => ({ id: x.playerId, name: x.name, units: x.units, levels: x.levels, ...(x.boosts ? { boosts: x.boosts } : {}), ...(x.vigor ? { vigor: x.vigor } : {}), ...(towers !== undefined ? { towers } : {}), formation: x.formation });
  return { kind: "duel" as const, context: `duel:${d.id}`, attacker: side(a) as any, defender: side(c, 0) as any, atkPlayer: db.data.players[a.playerId] ?? null, defPlayer: db.data.players[c.playerId] ?? null };
}

export function cancelChallenge(p: Player, id: string) {
  const d = duels()[id];
  if (!d || d.challenger.playerId !== p.id) throw new GameError("No such challenge of yours.", 404);
  if (d.status !== "open") throw new GameError("This duel has already been fought.");
  d.status = "cancelled";
  p.might = (p.might ?? 0) + d.stake;
  chain.onRelease(potKeys(d)[0], p, d.stake, 0, `duel:${d.id}:cancel`);
  db.save();
  return { duel: duelView(d, p), might: p.might };
}

// ── The fight (steel) ─────────────────────────────────────────────────
function fight(d: Duel, dec?: Decision): BattleRecord {
  const a = d.rival!;
  const c = d.challenger;
  const seed = dec?.seed ?? crypto.randomBytes(4).readUInt32LE(0);
  // the program fights with each player's on-chain profile levels
  if (dec?.levels?.attacker) a.levels = dec.levels.attacker;
  if (dec?.levels?.defender) c.levels = dec.levels.defender;
  // duels made before formations existed keep the original engine
  const engine = a.formation && c.formation ? 2 : 1;
  const af = engine === 2 ? { formation: a.formation } : {};
  const cf = engine === 2 ? { formation: c.formation } : {};
  const result = simulate({
    engine,
    attacker: { units: a.units, levels: a.levels, boosts: a.boosts, vigor: a.vigor, ...af },
    defender: { units: c.units, levels: c.levels, towers: 0, boosts: c.boosts, vigor: c.vigor, ...cf },
    seed,
  });
  const rec: BattleRecord = {
    id: `F-${++db.data.meta.battleSeq}`,
    ...(engine === 2 ? { engine: 2 as const } : {}),
    bounty: `duel:${d.id}`,
    at: now(),
    seed,
    attacker: { id: a.playerId, name: a.name, units: a.units, levels: a.levels, ...(a.boosts ? { boosts: a.boosts } : {}), ...(a.vigor ? { vigor: a.vigor } : {}), ...af },
    defender: { id: c.playerId, name: c.name, units: c.units, levels: c.levels, towers: 0, ...(c.boosts ? { boosts: c.boosts } : {}), ...(c.vigor ? { vigor: c.vigor } : {}), ...cf },
    result,
  };
  if (dec) {
    stamp(rec, dec);
    verifyAgainstChain(rec);
  }
  db.data.battles[rec.id] = rec;
  // Arena fights are to first blood: no units are lost.
  const split = duelPot(d.stake);
  const winner = result.winner === "attacker" ? a : c;
  const loser = winner === a ? c : a;
  d.battle = rec.id;
  d.steel = { winner: winner.playerId, pot: split.steel, at: now() };
  d.burned = split.burned;
  d.status = "fought";
  winner.payout = (winner.payout ?? 0) + split.steel;
  pay(winner.playerId, split.steel, "steel");
  chain.releaseFromPot(potKeys(d), db.data.players[winner.playerId] ?? null, split.steel, split.burned, `duel:${d.id}:steel`);
  chain.onBattle(rec, "duel");
  for (const s of [a, c]) {
    const pl = db.data.players[s.playerId];
    if (pl && !pl.bot) stats(pl).duels++;
  }
  const wp = db.data.players[winner.playerId];
  if (wp && !wp.bot) award(wp, "gladiator");
  feed({ kind: "duel", text: `Colosseum: ${winner.name} defeated ${loser.name}${split.steel ? ` and took ${split.steel} Might` : ""}. The foresight half waits for Gemini.`, duel: d.id, player: winner.playerId });
  db.save();
  return rec;
}

function pay(playerId: string, might: number, kind: "steel" | "foresight") {
  const pl = db.data.players[playerId];
  if (!pl || pl.bot || might <= 0) return;
  pl.might = (pl.might ?? 0) + might;
  const s = stats(pl);
  s.mightWon += might;
  if (kind === "steel") s.steelWins++;
  else s.foresightWins++;
}

// ── Settlement (foresight) ────────────────────────────────────────────
export function settleDuel(d: Duel, outcome: "yes" | "no") {
  if (d.status !== "fought" || !d.rival) return;
  const a = d.challenger;
  const b = d.rival;
  a.brier = Math.round(brier(a.call.side, a.call.confBps, outcome) * 10000) / 10000;
  b.brier = Math.round(brier(b.call.side, b.call.confBps, outcome) * 10000) / 10000;
  const pot = duelPot(d.stake).foresight;
  let winner: string;
  if (a.brier === b.brier) {
    winner = "split";
    const half = Math.floor(pot / 2);
    a.payout = (a.payout ?? 0) + half;
    b.payout = (b.payout ?? 0) + (pot - half);
    pay(a.playerId, half, "foresight");
    pay(b.playerId, pot - half, "foresight");
    chain.releaseFromPot(potKeys(d), db.data.players[a.playerId] ?? null, half, 0, `duel:${d.id}:foresight`);
    chain.releaseFromPot(potKeys(d), db.data.players[b.playerId] ?? null, pot - half, 0, `duel:${d.id}:foresight`);
  } else {
    const w = a.brier < b.brier ? a : b;
    winner = w.playerId;
    w.payout = (w.payout ?? 0) + pot;
    pay(w.playerId, pot, "foresight");
    chain.releaseFromPot(potKeys(d), db.data.players[w.playerId] ?? null, pot, 0, `duel:${d.id}:foresight`);
  }
  d.foresight = { winner, pot, outcome, at: now() };
  d.status = "settled";
  d.settledAt = now();
  d.hash = resultHash(d);
  d.seal = { memo: `${MEMO}:duel:${d.id}:${d.hash}`, status: "sending" };
  const who = winner === "split" ? "Both calls were equally good: the foresight half is split" : `${(winner === a.playerId ? a : b).name} made the better call and takes ${pot} Might`;
  feed({ kind: "duel", text: `Colosseum ${d.id}: Gemini settled ${outcome.toUpperCase()}. ${who}.`, duel: d.id });
  db.save();
  postReceipt(d.seal);
}

/** Everything that decided the duel, hashed for the on-chain seal. */
export function resultHash(d: Duel) {
  const side = (s: DuelSide) => [s.playerId, s.call.side, s.call.confBps, s.call.priceBps, s.call.at, s.call.salt, s.call.commit, s.payout ?? 0];
  const rec = d.battle ? db.data.battles[d.battle] : null;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ duel: d.id, market: d.market, stake: d.stake, outcome: d.foresight?.outcome, challenger: side(d.challenger), rival: d.rival ? side(d.rival) : null, battle: rec ? [rec.seed, rec.result.winner] : null }))
    .digest("hex");
}

// ── Rival warlords ────────────────────────────────────────────────────
/** A bot steps in: an army close to the challenger's strength, and a call from its trading style. */
function botAccept(d: Duel) {
  const bots = Object.values(db.data.players).filter((p) => p.bot);
  if (!bots.length) return false;
  const bot = bots[Math.floor(rnd() * bots.length)];
  const base = { ...bot.army };
  const basePower = Math.max(1, armyPower(base, bot.unitLevels));
  const target = d.challenger.power * (0.8 + rnd() * 0.4);
  const scale = Math.max(0.3, target / basePower);
  const units: Record<string, number> = {};
  for (const k of UNIT_KEYS) if (base[k]) units[k] = Math.max(1, Math.round(base[k] * scale));
  const style = botStyle(bot);
  const hist = oddsSeries(d.market, WINDOWS["1h"], 4);
  const move = hist.changeBps ?? 0;
  const mid = hist.nowBps ?? 5000;
  // momentum traders follow the last hour's move; contrarians fade it; with no move, both lean to the favourite
  let side: "yes" | "no" = move === 0 ? (mid >= 5000 ? "yes" : "no") : (move > 0) === (style === "momentum") ? "yes" : "no";
  if (rnd() < 0.15) side = side === "yes" ? "no" : "yes";
  const confBps = 5500 + Math.floor(rnd() * 2500);
  // priced off the latest recorded mid with a 1¢ half-spread (the challenger's price if there's no history)
  const priceBps = hist.nowBps !== null ? sidePriceBps(side, Math.max(0, hist.nowBps - 100), Math.min(10000, hist.nowBps + 100)) : d.challenger.call.priceBps;
  d.rival = sideFor(d, bot, units, { side, confBps }, priceBps);
  d.rival.bot = true;
  postReceipt(d.rival.receipt!);
  d.status = "fighting";
  const run = runBattle(duelInput(d), (dec) => fight(d, dec), {
    onCancel: () => {
      d.status = "open";
      d.rival = undefined;
      d.botAt = now() + COLOSSEUM.botAcceptSec * 1000;
      db.save();
    },
  });
  if (run instanceof Promise) run.catch(() => {});
  return true;
}
export const botStyle = (bot: { id: string }) => (strSeed(bot.id) % 2 ? "momentum" : "contrarian");

// ── The loop ──────────────────────────────────────────────────────────
let lastSettle = 0;
let busy = false;
export async function colosseumTick(force = false) {
  for (const d of Object.values(duels())) if (d.status === "open" && d.botAt && now() >= d.botAt) botAccept(d);
  const every = env.geminiMode === "mock" ? 4000 : 30000;
  if ((!force && now() - lastSettle < every) || busy) return;
  busy = true;
  try {
    await settleFought();
  } finally {
    busy = false;
  }
}
async function settleFought() {
  lastSettle = now();
  const fought = Object.values(duels()).filter((d) => d.status === "fought");
  const byMarket = new Map<string, Duel[]>();
  for (const d of fought) byMarket.set(d.market, [...(byMarket.get(d.market) ?? []), d]);
  for (const [market, list] of byMarket) {
    try {
      const side = await gemini.settlement(market);
      if (side) for (const d of list) settleDuel(d, side);
    } catch (e) {
      console.error("colosseum settlement:", (e as Error).message);
    }
  }
}

/** Dev tools: a rival accepts the player's open challenges right now. */
export function devBotAccept(p: Player) {
  let n = 0;
  for (const d of Object.values(duels())) if (d.status === "open" && d.challenger.playerId === p.id && botAccept(d)) n++;
  return n;
}

// ── Stream confirmations ──────────────────────────────────────────────
/** Called for each Fortune Front memo the QuickNode Stream delivers. */
export function applyDuelMemo(kind: string, parts: string[], signature: string, slot: number) {
  if (kind === "call") {
    const [id, playerId, commit] = parts;
    const d = duels()[id];
    const s = d ? [d.challenger, d.rival].find((x) => x?.playerId === playerId) : null;
    if (!d || !s?.receipt) return;
    s.receipt.status = "onchain";
    s.receipt.signature = signature;
    s.receipt.verified = commit === s.call.commit && commit === commitOf(d, s.playerId, d.market, s.call);
    if (!s.bot) feed({ kind: "chain", text: `Solana: ${s.name}'s call in ${d.id} is committed on-chain (slot ${slot})`, signature, duel: d.id, player: s.playerId });
  } else if (kind === "duel") {
    const [id, hash] = parts;
    const d = duels()[id];
    if (!d?.seal) return;
    d.seal.status = "onchain";
    d.seal.signature = signature;
    d.seal.verified = hash === d.hash && hash === resultHash(d);
    feed({ kind: "chain", text: `Solana: Colosseum ${d.id} result sealed (slot ${slot})`, signature, duel: d.id });
  }
  db.save();
}

// ── Views ─────────────────────────────────────────────────────────────
const receiptView = (r?: Receipt) => (r ? { status: r.status, signature: r.signature ?? null, explorer: r.signature ? explorerTx(r.signature) : null, verified: r.verified ?? null, memo: r.memo, error: r.error ?? null } : null);

function sideView(d: Duel, s: DuelSide, viewer: Player | null) {
  const reveal = d.status !== "open" || viewer?.id === s.playerId; // calls stay sealed until the fight
  return {
    playerId: s.playerId,
    name: s.name,
    bot: s.bot,
    style: s.bot ? botStyle({ id: s.playerId }) : null,
    wallet: s.wallet ?? null,
    units: s.units,
    levels: s.levels,
    power: s.power,
    commit: s.call.commit,
    committedAt: s.call.at,
    call: reveal ? { side: s.call.side, confBps: s.call.confBps, priceBps: s.call.priceBps, at: s.call.at, salt: s.call.salt } : null,
    receipt: receiptView(s.receipt),
    brier: s.brier ?? null,
    payout: s.payout ?? 0,
  };
}

export function duelView(d: Duel, viewer: Player | null) {
  const split = duelPot(d.stake);
  return {
    id: d.id,
    createdAt: d.createdAt,
    status: d.status,
    stake: d.stake,
    pot: split,
    market: d.market,
    question: d.question,
    eventTitle: d.eventTitle,
    category: d.category,
    expiry: d.expiry,
    practice: d.practice,
    botAt: d.status === "open" ? (d.botAt ?? null) : null,
    challenger: sideView(d, d.challenger, viewer),
    rival: d.rival ? sideView(d, d.rival, viewer) : null,
    battle: d.battle ?? null,
    steel: d.steel ?? null,
    foresight: d.foresight ?? null,
    hash: d.hash ?? null,
    seal: receiptView(d.seal),
    mine: !!viewer && (d.challenger.playerId === viewer.id || d.rival?.playerId === viewer.id),
  };
}

export function colosseumView(p: Player) {
  const all = Object.values(duels()).sort((a, b) => b.createdAt - a.createdAt);
  const board = Object.values(db.data.players)
    .filter((x) => !x.bot && x.colosseum?.duels)
    .map((x) => ({ name: x.name, duels: x.colosseum!.duels, steelWins: x.colosseum!.steelWins, foresightWins: x.colosseum!.foresightWins, mightWon: x.colosseum!.mightWon, me: x.id === p.id }))
    .sort((a, b) => b.mightWon - a.mightWon || b.steelWins - a.steelWins)
    .slice(0, 10);
  return {
    config: COLOSSEUM,
    might: p.might ?? 0,
    stats: stats(p),
    open: all.filter((d) => d.status === "open").slice(0, 30).map((d) => duelView(d, p)),
    mine: all.filter((d) => d.challenger.playerId === p.id || d.rival?.playerId === p.id).slice(0, 25).map((d) => duelView(d, p)),
    recent: all.filter((d) => d.status === "fought" || d.status === "settled").slice(0, 10).map((d) => duelView(d, p)),
    board,
    now: now(),
  };
}

export function duelById(p: Player, id: string) {
  const d = duels()[id];
  if (!d) throw new GameError("No such duel.", 404);
  return duelView(d, p);
}
