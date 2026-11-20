// The bounty director: turns live Gemini markets into blind bounties on the world map, runs the
// competition (entries, attacks, rival warlords, leaderboard), pays out by placement, reveals the
// question, takes predictions, and settles them when Gemini settles the market.
import crypto from "node:crypto";
import { armyPower, simulate } from "../shared/battle.js";
import { mulberry32, strSeed } from "../shared/rng.js";
import {
  ATTACKS_PER_BOUNTY,
  BOT_NAMES,
  autoFormation,
  formationArmy,
  DEFENSE_POINTS,
  TIERS,
  UNIT_KEYS,
  brier,
  crystalsFor,
  guardianArmy,
  housingOf,
  payoutFor,
  rewardsFor,
  sidePriceBps,
} from "../shared/rules.js";
import { FOG_CELL, FOG_W, REALMS, SIGHT, T, generateWorld, isDecal, pickBountySite, placeBossLairs, realmForMarket } from "../shared/world.js";
import { BOSSES } from "../shared/rules.js";
import { GeminiClient, contractPricesBps, type MarketSummary } from "../gemini/client";
import { env } from "./config";
import { db, feed, type BattleRecord, type Bounty, type Entry, type Player } from "./db";
import { COMBAT_MS, GameError, addGold, award, boostsOf, exploredBytes, fieldFormation, newPlayer, relicFx, vigorOf } from "./players";

export const world = generateWorld();
/** Fixed boss lairs (same on every server and browser for this world seed). */
export const lairs = placeBossLairs(world, BOSSES);
export const gemini = new GeminiClient();

type SealFn = (b: Bounty) => void;
let sealHook: SealFn = () => {};
export const onSeal = (fn: SealFn) => (sealHook = fn);

const rnd = mulberry32((Date.now() & 0xffffffff) >>> 0);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const now = () => Date.now();

// ── Views ─────────────────────────────────────────────────────────────
const RECENT_MS = 15 * 60_000;
function visibleBounties() {
  return Object.values(db.data.bounties).filter((b) => b.status !== "resolved" || now() - (b.resolvedAt ?? 0) < RECENT_MS);
}

export function rumorOf(b: Bounty) {
  const r = mulberry32(strSeed(b.id));
  return { x: Math.round(b.x + (r() - 0.5) * 18), y: Math.round(b.y + (r() - 0.5) * 18), r: 15 };
}

function isDiscovered(p: Player, b: Bounty, explored = exploredBytes(p)) {
  if (p.discovered.includes(b.id)) return true;
  const cell = Math.floor(b.y / FOG_CELL) * FOG_W + Math.floor(b.x / FOG_CELL);
  return explored[cell] === 1;
}

function leaderboard(b: Bounty) {
  return Object.values(b.entries)
    .sort((a, c) => c.score - a.score || a.joinedAt - c.joinedAt)
    .map((e, i) => ({ rank: i + 1, playerId: e.playerId, name: e.name, bot: e.bot, score: e.score, attacks: e.attacks, defense: e.defense }));
}

/** Map pins: exact for discovered bounties, a rumour circle for the rest. */
export function mapFor(p: Player) {
  const explored = exploredBytes(p);
  return visibleBounties().map((b) => {
    const base = { id: b.id, tier: b.tier, featured: b.featured, hot: !!b.hot, realm: b.realm, status: b.status, startsAt: b.startsAt, endsAt: b.endsAt, participants: Object.keys(b.entries).length, maxPlayers: TIERS[b.tier].maxPlayers, entered: !!b.entries[p.id] };
    if (isDiscovered(p, b, explored) || b.entries[p.id]) return { ...base, discovered: true, x: b.x, y: b.y };
    return { ...base, discovered: false, rumor: rumorOf(b) };
  });
}

export function bountyFor(p: Player, id: string) {
  const b = db.data.bounties[id];
  if (!b) throw new GameError("No such bounty.", 404);
  const t = TIERS[b.tier];
  const entry = b.entries[p.id];
  const lb = leaderboard(b);
  const me = lb.find((r) => r.playerId === p.id);
  const revealed = (b.status === "revealed" || b.status === "resolved") && !!entry;
  const myRank = b.results?.ranking.find((r) => r.playerId === p.id);
  const preds = Object.values(b.predictions);
  return {
    id: b.id,
    tier: b.tier,
    tierName: t.name,
    featured: b.featured,
    realm: b.realm,
    realmName: REALMS.find((r) => r.id === b.realm)?.name,
    category: b.wildcard ? "wildcard" : REALMS.find((r) => r.id === b.realm)?.category,
    wildcard: !!b.wildcard,
    x: b.x,
    y: b.y,
    status: b.status,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    now: now(),
    participants: lb.length,
    maxPlayers: t.maxPlayers,
    entryFee: t.entry,
    minKeep: t.minKeep,
    attacksPerPlayer: ATTACKS_PER_BOUNTY,
    rewards: [1, 2, 3, 4].map((rank) => ({ rank, ...rewardsFor(b.tier, rank, b.featured) })),
    leaderboard: lb.slice(0, 12),
    you: entry ? { entered: true, attacksLeft: ATTACKS_PER_BOUNTY - entry.attacks, score: entry.score, rank: me?.rank, defense: entry.defense } : { entered: false },
    results: b.results ? { ranking: b.results.ranking.slice(0, 12), hash: b.results.hash, seal: b.results.seal, you: myRank ?? null } : null,
    // The question stays sealed until the competition ends, and only entrants see it.
    question: revealed ? b.question : null,
    eventTitle: revealed ? b.eventTitle : null,
    market: revealed ? b.market : null,
    expiry: revealed ? b.expiry : null,
    quote: revealed ? b.quote ?? null : null,
    outcome: revealed ? b.outcome ?? null : null,
    prediction: b.predictions[p.id] ?? null,
    crowd: revealed
      ? {
          count: preds.length,
          yes: preds.filter((x) => x.side === "yes").length,
          no: preds.filter((x) => x.side === "no").length,
          recent: preds.slice(-8).map((x) => ({ name: x.name, side: x.side, confBps: x.confBps, stake: x.stake })),
        }
      : null,
  };
}

// ── Spawning ──────────────────────────────────────────────────────────
let marketCache: { at: number; list: MarketSummary[] } = { at: 0, list: [] };
export async function openMarkets() {
  if (now() - marketCache.at < 8000) return marketCache.list;
  const list = (await gemini.openMarkets()).filter((m) => m.bestBidBps !== null && m.bestAskBps !== null && m.bestAskBps > 0 && m.bestBidBps < 10000);
  marketCache = { at: now(), list };
  return list;
}

function questionText(m: MarketSummary) {
  const label = (m.label ?? "").trim();
  if (!label || label.length < 14 || /^(yes|no)$/i.test(label)) return `${m.eventTitle}${label ? `: ${label}` : ""}`;
  return label;
}

/** Everything that blocks a new camp: live bounties and players' fortresses. */
function takenSpots() {
  const spots = visibleBounties().map((b) => ({ x: b.x, y: b.y }));
  for (const p of Object.values(db.data.players)) if (p.home) spots.push(p.home);
  for (const l of lairs) spots.push({ x: l.x, y: l.y });
  return spots;
}

/**
 * Spawn one bounty in a realm. Prefers an unused market of that realm's category, then shares a
 * market already running elsewhere in the same category; only if Gemini has nothing at all for
 * that category does it use any market, marked as a wildcard so the realm hint stays honest.
 */
function spawnIn(realm: string, markets: MarketSummary[], { activeNow, first = false, tier: forceTier, featured }: { activeNow: boolean; first?: boolean; tier?: Bounty["tier"]; featured?: boolean }) {
  const open = Object.values(db.data.bounties).filter((b) => b.status !== "resolved");
  const used = new Set(open.map((b) => b.market));
  const inCat = markets.filter((m) => realmForMarket(m.category, `${m.eventTitle} ${m.label}`) === realm);
  const sameRealmMarkets = new Set(open.filter((b) => b.realm === realm).map((b) => b.market));
  let pool = inCat.filter((m) => !used.has(m.market));
  if (!pool.length) pool = inCat.filter((m) => !sameRealmMarkets.has(m.market));
  if (!pool.length) pool = inCat;
  let wildcard = false;
  if (!pool.length) {
    pool = markets.filter((m) => !used.has(m.market));
    if (!pool.length) pool = markets;
    wildcard = true;
  }
  if (!pool.length) return null;
  const m = pool[Math.floor(rnd() * pool.length)];
  const site = pickBountySite(world, realm, takenSpots(), rnd);
  if (!site) return null;
  const roll = rnd();
  const tier: Bounty["tier"] = forceTier ?? (roll < 0.55 ? "common" : roll < 0.87 ? "rare" : "epic");
  const seq = ++db.data.meta.bountySeq;
  const startsAt = activeNow ? now() : now() + Math.round(env.bountyUpcomingSec * 1000 * (0.4 + rnd()));
  const endsAt = startsAt + Math.round(env.bountyActiveSec * 1000 * (first ? 0.5 + rnd() : 0.85 + rnd() * 0.3));
  const b: Bounty = {
    id: `B-${String(seq).padStart(4, "0")}`,
    seq,
    tier,
    featured: featured ?? rnd() < 0.16,
    realm,
    x: site.x,
    y: site.y,
    market: m.market,
    eventTicker: m.eventTicker,
    question: questionText(m),
    eventTitle: m.eventTitle,
    category: m.category ?? "",
    expiry: m.expiry,
    createdAt: now(),
    startsAt,
    endsAt,
    status: activeNow ? "active" : "upcoming",
    entries: {},
    predictions: {},
    quote: { bidBps: m.bestBidBps, askBps: m.bestAskBps, at: now() },
    wildcard,
  };
  db.data.bounties[b.id] = b;
  if (b.featured) feed({ kind: "spawn", text: `A featured ${TIERS[tier].name} bounty appeared in ${REALMS.find((r) => r.id === realm)?.name}`, bounty: b.id });
  return b;
}

async function spawnBounties(first = false) {
  let markets: MarketSummary[];
  try {
    markets = await openMarkets();
  } catch (e) {
    console.error("gemini:", (e as Error).message);
    return;
  }
  if (!markets.length) return;
  const live = () => Object.values(db.data.bounties).filter((b) => b.status === "upcoming" || b.status === "active");
  // 1. Every realm always has a bounty you can fight in right now.
  for (const r of REALMS) {
    const here = live().filter((b) => b.realm === r.id);
    if (here.some((b) => b.status === "active")) continue;
    const queued = here.sort((a, b) => a.startsAt - b.startsAt)[0];
    if (queued) {
      // start the next one in line early, keeping a full battle window
      queued.status = "active";
      queued.endsAt = Math.max(queued.endsAt - (queued.startsAt - now()), now() + env.bountyActiveSec * 500);
      queued.startsAt = now();
    } else spawnIn(r.id, markets, { activeNow: true, first });
  }
  // 2. Top up to the target, spreading new bounties across the realms with the fewest.
  const want = env.bountyTarget - live().length;
  for (let k = 0; k < (first ? want : Math.min(want, 2)); k++) {
    const counts = REALMS.map((r) => ({ id: r.id, n: live().filter((b) => b.realm === r.id).length + rnd() * 0.5 }));
    counts.sort((a, b) => a.n - b.n);
    spawnIn(counts[0].id, markets, { activeNow: false, first });
  }
  db.save();
}

/**
 * A market moved sharply (see server/odds.ts): spawn a featured bounty around it in its realm, active
 * now. Its question stays sealed like any other. Skipped if a live bounty already uses that market.
 */
export function spawnHot(market: string, realm: string) {
  const live = Object.values(db.data.bounties).some((b) => b.status !== "resolved" && b.market === market);
  const m = marketCache.list.find((x) => x.market === market);
  if (live || !m || !REALMS.some((r) => r.id === realm)) return false;
  const b = spawnIn(realm, [m], { activeNow: true, featured: true });
  if (!b) return false;
  b.hot = true;
  db.save();
  return true;
}

// ── Home bases ────────────────────────────────────────────────────────
/** Give a player a fortress plot in the Crownlands, near Kingsmarket. */
export function assignHome(p: Player) {
  if (p.home || p.bot) return p.home;
  const cap = world.towns.find((t) => t.realm === "crownlands")!;
  const taken = takenSpots();
  const { W, terrain, objects, walk, reachable } = world;
  for (let attempt = 0; attempt < 6000; attempt++) {
    const ring = 9 + Math.floor(attempt / 300) * 3;
    const ang = rnd() * Math.PI * 2;
    const x = Math.round(cap.x + Math.cos(ang) * (ring + rnd() * 6));
    const y = Math.round(cap.y + Math.sin(ang) * (ring + rnd() * 6));
    if (x < 4 || y < 4 || x >= W - 4 || y >= world.H - 4) continue;
    let ok = true;
    for (let dy = -1; dy <= 2 && ok; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const j = (y + dy) * W + x + dx;
        const t = terrain[j];
        if (!walk[j] || !reachable[j] || t === T.ROAD || t === T.TOWN || t === T.BRIDGE || t === T.MOUNTAIN || (objects[j] && !isDecal(objects[j]))) ok = false;
      }
    if (!ok || taken.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) < 6)) continue;
    p.home = { x, y };
    db.save();
    return p.home;
  }
  p.home = { x: cap.x, y: cap.y + 1 };
  return p.home;
}

/** Recall home: refused while your troops are still fighting. */
export function recall(p: Player) {
  const left = (p.lastCombatAt ?? 0) + COMBAT_MS - now();
  if (left > 0) throw new GameError(`You're still in combat. You can recall home in ${Math.ceil(left / 1000)}s.`);
  const home = assignHome(p)!;
  p.pos = { x: home.x, y: home.y + 2 };
  db.save();
  return { x: home.x, y: home.y + 2 };
}

// ── Competition ───────────────────────────────────────────────────────
export function enter(p: Player, id: string) {
  const b = db.data.bounties[id];
  if (!b) throw new GameError("No such bounty.", 404);
  const t = TIERS[b.tier];
  if (b.status !== "upcoming" && b.status !== "active") throw new GameError("This bounty is closed to new entries.");
  if (b.entries[p.id]) throw new GameError("You're already in this bounty.");
  if (Object.keys(b.entries).length >= t.maxPlayers) throw new GameError("This bounty is full.");
  if (p.buildings.keep < t.minKeep) throw new GameError(`${t.name} bounties need a level ${t.minKeep} Keep.`);
  if (housingOf(p.army) <= 0) throw new GameError("Train some units first: you need an army to compete.");
  if (p.gold < t.entry) throw new GameError(`Entry costs ${t.entry} gold.`);
  p.gold -= t.entry;
  b.entries[p.id] = snapshotEntry(p);
  p.stats.bountiesEntered++;
  feed({ kind: "enter", text: `${p.name} entered ${b.id}`, bounty: b.id, player: p.id });
  db.save();
  return bountyFor(p, id);
}

function snapshotEntry(p: Player): Entry {
  return { playerId: p.id, name: p.name, bot: !!p.bot, joinedAt: now(), score: 0, attacks: 0, defense: 0, best: 0, army: { ...p.army }, levels: { ...p.unitLevels }, towers: p.buildings.towers + relicFx(p).towers, boosts: boostsOf(p), vigor: vigorOf(p), formation: fieldFormation(p) };
}

export function opponents(p: Player, id: string) {
  const b = db.data.bounties[id];
  if (!b) throw new GameError("No such bounty.", 404);
  const g = guardianArmy(b.tier);
  const list = Object.values(b.entries)
    .filter((e) => e.playerId !== p.id)
    .map((e) => ({ id: e.playerId, name: e.name, bot: e.bot, score: e.score, power: armyPower(e.army, e.levels, e.towers), army: e.army, towers: e.towers }));
  return [{ id: "guardian", name: `${b.id} Guardian`, bot: true, guardian: true, score: null, power: armyPower(g.units, g.levels, g.towers), army: g.units, towers: g.towers }, ...list];
}

const LOOT = { common: 40, rare: 70, epic: 110 };

export function attack(p: Player, id: string, opponentId: string, units: Record<string, number>, plan: { formation?: unknown; preset?: unknown; order?: unknown; abilities?: unknown } = {}) {
  const b = db.data.bounties[id];
  if (!b) throw new GameError("No such bounty.", 404);
  if (b.status !== "active") throw new GameError(b.status === "upcoming" ? "The bounty hasn't started yet." : "This bounty's battles are over.");
  const entry = b.entries[p.id];
  if (!entry) throw new GameError("Enter the bounty first.");
  if (entry.attacks >= ATTACKS_PER_BOUNTY) throw new GameError(`You've used all ${ATTACKS_PER_BOUNTY} attacks in this bounty.`);
  const formation = attackFormation(p, units, plan);
  const sent = formationArmy(formation);
  const rec = fight(b, { id: p.id, name: p.name, units: sent, levels: p.unitLevels, boosts: boostsOf(p), vigor: vigorOf(p), formation }, opponentId);
  p.lastCombatAt = now();
  // casualties come out of your army
  for (const [k, n] of Object.entries(rec.result.lost)) p.army[k] = Math.max(0, (p.army[k] ?? 0) - n);
  const loot = Math.round((LOOT[b.tier] * rec.result.destruction) / 100) * (b.featured ? 1.5 : 1);
  addGold(p, Math.round(loot));
  p.stats.battles++;
  if (rec.result.winner === "attacker") {
    p.stats.wins++;
    award(p, "first-blood");
    if (p.stats.wins >= 10) award(p, "warlord");
  }
  db.save();
  return { battle: rec, loot: Math.round(loot), bounty: bountyFor(p, id) };
}

/**
 * The formation for an attack: a full formation from the client, a preset/order for this fight, or
 * the player's saved formation. An older client sending only `units` gets them auto-placed.
 */
export function attackFormation(p: Player, units: Record<string, number> | undefined, plan: { formation?: unknown; preset?: unknown; order?: unknown; abilities?: unknown }) {
  if (!plan.formation && units && Object.keys(units).length && !plan.preset) {
    const sent: Record<string, number> = {};
    for (const k of UNIT_KEYS) {
      const n = Math.max(0, Math.floor(Number(units[k] ?? 0) || 0));
      if (n > (p.army[k] ?? 0)) throw new GameError(`You only have ${p.army[k] ?? 0} ${k}.`);
      if (n) sent[k] = n;
    }
    if (!Object.keys(sent).length) throw new GameError("Send at least one unit.");
    const base = fieldFormation(p, { order: plan.order, abilities: plan.abilities });
    const f = autoFormation(sent, base.preset ?? "shieldwall", base.order);
    return base.abilities ? { ...f, abilities: base.abilities } : f;
  }
  const f = fieldFormation(p, plan);
  if (!f.slots.some(Boolean)) throw new GameError("Train some units first.");
  return f;
}

const GUARDIAN_PRESET = { common: "shieldwall", rare: "ranged", epic: "assault" } as const;

/** Run one attack inside a bounty and update scores. Used by players and bots. */
function fight(b: Bounty, atk: { id: string; name: string; units: Record<string, number>; levels: Record<string, number>; boosts?: Record<string, number>; vigor?: Record<string, number>; formation?: any }, opponentId: string): BattleRecord {
  const entry = b.entries[atk.id];
  let defender: BattleRecord["defender"];
  const defEntry = opponentId !== "guardian" ? b.entries[opponentId] : null;
  if (opponentId === "guardian") {
    const g = guardianArmy(b.tier);
    defender = { id: "guardian", name: `${b.id} Guardian`, units: g.units, levels: g.levels, towers: g.towers, guardian: true, formation: autoFormation(g.units, GUARDIAN_PRESET[b.tier]) };
  } else {
    if (!defEntry) throw new GameError("That rival isn't in this bounty.");
    if (opponentId === atk.id) throw new GameError("You can't attack yourself.");
    defender = { id: defEntry.playerId, name: defEntry.name, units: defEntry.army, levels: defEntry.levels, towers: defEntry.towers, ...(defEntry.boosts ? { boosts: defEntry.boosts } : {}), ...(defEntry.vigor ? { vigor: defEntry.vigor } : {}), formation: defEntry.formation ?? autoFormation(defEntry.army, "shieldwall") };
  }
  const seed = crypto.randomBytes(4).readUInt32LE(0);
  const atkFormation = atk.formation ?? autoFormation(atk.units, "shieldwall");
  const result = simulate({ engine: 2, attacker: { units: atk.units, levels: atk.levels, boosts: atk.boosts, vigor: atk.vigor, formation: atkFormation }, defender, seed });
  entry.attacks++;
  entry.score += result.score;
  entry.best = Math.max(entry.best, result.score);
  if (defEntry && result.winner === "defender") {
    defEntry.defense += DEFENSE_POINTS;
    defEntry.score += DEFENSE_POINTS;
  }
  const rec: BattleRecord = { id: `F-${++db.data.meta.battleSeq}`, engine: 2, bounty: b.id, at: now(), seed, attacker: { id: atk.id, name: atk.name, units: atk.units, levels: atk.levels, ...(atk.boosts ? { boosts: atk.boosts } : {}), ...(atk.vigor ? { vigor: atk.vigor } : {}), formation: atkFormation }, defender, result };
  db.data.battles[rec.id] = rec;
  const verb = result.winner === "attacker" ? "crushed" : "was repelled by";
  feed({ kind: "battle", text: `${atk.name} ${verb} ${defender.name} in ${b.id} (+${result.score})`, bounty: b.id, player: atk.id });
  return rec;
}

export function battle(id: string) {
  const r = db.data.battles[id];
  if (!r) throw new GameError("No such battle.", 404);
  return r;
}

// ── Finishing a bounty ────────────────────────────────────────────────
function finalize(b: Bounty) {
  const lb = leaderboard(b);
  const ranking = lb.map((r) => {
    const rw = rewardsFor(b.tier, r.rank, b.featured);
    return { playerId: r.playerId, name: r.name, bot: r.bot, score: r.score, rank: r.rank, ...rw };
  });
  for (const r of ranking) {
    const p = db.data.players[r.playerId];
    if (!p || p.bot) continue;
    addGold(p, r.gold);
    p.trophies += r.trophies;
    p.history.push({ bounty: b.id, rank: r.rank, of: ranking.length, score: r.score, at: now() });
    if (r.rank === 1) {
      p.stats.bountiesWon++;
      award(p, "champion");
    }
  }
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ bounty: b.id, market: b.market, ranking: ranking.map((r) => [r.playerId, r.score, r.rank]) }))
    .digest("hex");
  b.results = { ranking, finalizedAt: now(), hash };
  b.status = "revealed";
  b.revealQuote = b.quote ? { bidBps: b.quote.bidBps, askBps: b.quote.askBps } : undefined;
  const top = ranking[0];
  feed({ kind: "reveal", text: top ? `${b.id} is over: ${top.name} took 1st. Entrants can now open the sealed question.` : `${b.id} ended with no entrants.`, bounty: b.id });
  db.save();
  sealHook(b);
  botPredictions(b);
}

export function predict(p: Player, id: string, side: string, confBps: number, stake: number) {
  const b = db.data.bounties[id];
  if (!b) throw new GameError("No such bounty.", 404);
  if (b.status !== "revealed") throw new GameError(b.status === "resolved" ? "This market has settled." : "Predictions open when the competition ends.");
  if (!b.entries[p.id]) throw new GameError("Only players who competed in this bounty can call its question.");
  if (b.predictions[p.id]) throw new GameError("You've already made your call.");
  if (side !== "yes" && side !== "no") throw new GameError("Pick YES or NO.");
  const conf = Math.round(Number(confBps));
  if (!(conf >= 5000 && conf <= 9900)) throw new GameError("Confidence must be between 50% and 99%.");
  const cap = b.results?.ranking.find((r) => r.playerId === p.id)?.stakeCap ?? 0;
  const s = Math.max(0, Math.floor(Number(stake) || 0));
  if (s > cap) throw new GameError(cap ? `Your placement lets you stake up to ${cap} gold.` : "Only the top 3 can stake gold. You can still make a free call.");
  if (s > p.gold) throw new GameError(`You only have ${p.gold} gold.`);
  const q = b.quote;
  if (!q || q.bidBps === null || q.askBps === null) throw new GameError("No price from Gemini right now. Try again in a moment.");
  const priceBps = sidePriceBps(side, q.bidBps, q.askBps);
  p.gold -= s;
  b.predictions[p.id] = { playerId: p.id, name: p.name, bot: !!p.bot, side, confBps: conf, stake: s, priceBps, at: now() };
  p.stats.predictions++;
  feed({ kind: "predict", text: `${p.name} made a call on ${b.id}${s ? ` and staked ${s} gold` : ""}`, bounty: b.id, player: p.id });
  db.save();
  return bountyFor(p, id);
}

function resolve(b: Bounty, outcome: "yes" | "no") {
  b.outcome = outcome;
  b.status = "resolved";
  b.resolvedAt = now();
  for (const pr of Object.values(b.predictions)) {
    const p = db.data.players[pr.playerId];
    pr.correct = pr.side === outcome;
    pr.payout = pr.correct ? payoutFor(pr.stake, pr.priceBps) : 0;
    pr.brier = Math.round(brier(pr.side, pr.confBps, outcome) * 10000) / 10000;
    pr.crystals = crystalsFor(pr.brier);
    if (!p || p.bot) continue;
    addGold(p, pr.payout);
    p.crystals += pr.crystals;
    p.stats.crystalsEarned += pr.crystals;
    if (pr.correct) {
      p.stats.correct++;
      award(p, "oracle");
      if (pr.confBps >= 8000) award(p, "called-it");
    }
  }
  feed({ kind: "settle", text: `Gemini settled ${b.id}'s market: ${outcome.toUpperCase()}`, bounty: b.id });
  db.save();
}

// ── Rival warlords (bots) ─────────────────────────────────────────────
function bots(): Player[] {
  const list = Object.values(db.data.players).filter((p) => p.bot);
  if (list.length >= BOT_NAMES.length) return list;
  for (const name of BOT_NAMES.slice(list.length)) {
    const p = newPlayer(name, { bot: true });
    const lvl = 1 + Math.floor(rnd() * 3);
    p.buildings = { keep: lvl + 1, barracks: lvl + 1, training: lvl, vault: 3, towers: lvl, trophy: 1 };
    p.army = { infantry: 4 + Math.floor(rnd() * 6), archer: 3 + Math.floor(rnd() * 5), tank: lvl > 1 ? Math.floor(rnd() * 3) : 0, cavalry: lvl > 2 ? Math.floor(rnd() * 3) : 0, siege: 0 };
    p.unitLevels = { infantry: lvl, archer: lvl, tank: lvl, cavalry: lvl, siege: 1 };
    p.trophies = Math.floor(rnd() * 200);
    list.push(p);
  }
  db.save();
  return list;
}

function runBots(b: Bounty) {
  if (!env.bots) return;
  const t = TIERS[b.tier];
  const count = Object.keys(b.entries).length;
  const window = b.endsAt - b.startsAt;
  if (count < Math.ceil(t.maxPlayers * 0.6) && rnd() < 0.18) {
    const free = bots().filter((x) => !b.entries[x.id] && x.buildings.keep >= t.minKeep);
    if (free.length) {
      const bot = pick(free);
      const e = snapshotEntry(bot);
      const from = Math.max(now(), b.startsAt);
      e.botPlan = Array.from({ length: ATTACKS_PER_BOUNTY }, () => from + rnd() * Math.max(5000, b.endsAt - from - 4000)).sort((a, c) => a - c);
      b.entries[bot.id] = e;
    }
  }
  if (b.status !== "active") return;
  for (const e of Object.values(b.entries)) {
    if (!e.bot || !e.botPlan?.length || e.botPlan[0] > now() || e.attacks >= ATTACKS_PER_BOUNTY) continue;
    e.botPlan.shift();
    const rivals = Object.values(b.entries).filter((x) => x.playerId !== e.playerId);
    const humans = rivals.filter((x) => !x.bot);
    const target = humans.length && rnd() < 0.5 ? pick(humans) : rivals.length && rnd() < 0.7 ? pick(rivals) : null;
    const rec = fight(b, { id: e.playerId, name: e.name, units: e.army, levels: e.levels, formation: e.formation }, target?.playerId ?? "guardian");
    if (target && !target.bot && rec.result.winner === "defender") feed({ kind: "defend", text: `${target.name} held off ${e.name} in ${b.id} (+${DEFENSE_POINTS} defense)`, bounty: b.id, player: target.playerId });
    void window;
  }
}

function botPredictions(b: Bounty) {
  const q = b.quote;
  if (!q || q.bidBps === null || q.askBps === null) return;
  const mid = (q.bidBps + q.askBps) / 2 / 10000;
  for (const r of b.results?.ranking ?? []) {
    if (!r.bot || b.predictions[r.playerId] || rnd() < 0.25) continue;
    const yes = rnd() < mid;
    const side = yes ? "yes" : "no";
    const confBps = 5500 + Math.floor(rnd() * 3500);
    const stake = r.stakeCap ? Math.floor(r.stakeCap * (0.3 + rnd() * 0.6)) : 0;
    b.predictions[r.playerId] = { playerId: r.playerId, name: r.name, bot: true, side, confBps, stake, priceBps: sidePriceBps(side, q.bidBps, q.askBps), at: now() };
  }
}

// ── The loop ──────────────────────────────────────────────────────────
let lastQuote = 0;
let lastSettle = 0;
async function refreshQuotes() {
  const live = Object.values(db.data.bounties).filter((b) => b.status !== "resolved");
  if (!live.length) return;
  try {
    const events = await gemini.activeEvents(4000);
    const bySymbol = new Map<string, any>();
    for (const e of events) for (const c of e.contracts ?? []) bySymbol.set(c.instrumentSymbol, c);
    for (const b of live) {
      const c = bySymbol.get(b.market);
      if (!c) continue;
      const p = contractPricesBps(c);
      b.quote = { bidBps: p.bestBidBps, askBps: p.bestAskBps, at: now() };
    }
  } catch (e) {
    console.error("gemini quotes:", (e as Error).message);
  }
}

async function checkSettlements() {
  for (const b of Object.values(db.data.bounties).filter((x) => x.status === "revealed")) {
    try {
      const side = await gemini.settlement(b.market);
      if (side) resolve(b, side);
    } catch (e) {
      console.error("gemini settlement:", (e as Error).message);
    }
  }
}

let ticking = false;
let booted = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!booted) {
      bots();
      await spawnBounties(true);
      booted = true;
    }
    for (const b of Object.values(db.data.bounties)) {
      if (b.status === "upcoming" && now() >= b.startsAt) {
        b.status = "active";
        db.save();
      }
      if (b.status === "upcoming" || b.status === "active") runBots(b);
      if (b.status === "active" && now() >= b.endsAt) finalize(b);
    }
    await spawnBounties();
    const quoteEvery = env.geminiMode === "mock" ? 3000 : 15000;
    if (now() - lastQuote > quoteEvery) {
      lastQuote = now();
      await refreshQuotes();
    }
    const settleEvery = env.geminiMode === "mock" ? 4000 : 30000;
    if (now() - lastSettle > settleEvery) {
      lastSettle = now();
      await checkSettlements();
    }
  } finally {
    ticking = false;
  }
}

// ── Exploration ───────────────────────────────────────────────────────
/** Bounties the player can now see (within sight, or in explored land) that they hadn't found yet. */
export function discover(p: Player, pos: { x: number; y: number } | null) {
  const explored = exploredBytes(p);
  const found: string[] = [];
  for (const b of visibleBounties()) {
    if (p.discovered.includes(b.id)) continue;
    const near = pos && Math.abs(pos.x - b.x) <= SIGHT && Math.abs(pos.y - b.y) <= SIGHT;
    if (near || isDiscovered(p, b, explored)) {
      p.discovered.push(b.id);
      p.stats.discovered++;
      found.push(b.id);
    }
  }
  if (p.discovered.length > 400) p.discovered = p.discovered.slice(-400);
  if (p.stats.discovered >= 10) award(p, "cartographer");
  if (found.length) db.save();
  return found;
}

// ── Dev controls (mock Gemini only) ───────────────────────────────────
export function devEnd(id: string) {
  const b = db.data.bounties[id];
  if (!b) throw new GameError("No such bounty.", 404);
  if (b.status === "upcoming") b.startsAt = now();
  b.status = "active";
  b.endsAt = now();
  finalize(b);
  return b;
}
/** Dev: spawn a bounty in a realm right now. */
export async function devSpawn(realm: string, tier?: Bounty["tier"], active = true, featured?: boolean) {
  if (!REALMS.some((r) => r.id === realm)) throw new GameError("Unknown realm.");
  if (tier && !(tier in TIERS)) throw new GameError("Unknown tier.");
  const b = spawnIn(realm, await openMarkets(), { activeNow: active, tier, featured });
  if (!b) throw new GameError("No room or no market for a bounty there right now.");
  db.save();
  return b;
}

/** Dev: every live bounty with its real position (and question), for demo prep. */
export function devList() {
  return Object.values(db.data.bounties)
    .filter((b) => b.status !== "resolved" || now() - (b.resolvedAt ?? 0) < RECENT_MS)
    .sort((a, b) => a.seq - b.seq)
    .map((b) => ({ id: b.id, tier: b.tier, featured: b.featured, realm: b.realm, x: b.x, y: b.y, status: b.status, startsAt: b.startsAt, endsAt: b.endsAt, participants: Object.keys(b.entries).length, question: b.question }));
}

export function devStart(id: string) {
  const b = db.data.bounties[id];
  if (!b) throw new GameError("No such bounty.", 404);
  if (b.status !== "upcoming") throw new GameError("Only upcoming bounties can be started early.");
  b.startsAt = now();
  b.status = "active";
  db.save();
  return b;
}
export function globalLeaderboard() {
  return Object.values(db.data.players)
    .sort((a, b) => b.trophies - a.trophies)
    .slice(0, 20)
    .map((p, i) => ({ rank: i + 1, name: p.name, bot: !!p.bot, trophies: p.trophies, keep: p.buildings.keep, wins: p.stats.bountiesWon }));
}
