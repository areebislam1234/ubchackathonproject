// Boss lairs: discovery, the lair view, challenges and loot.
import crypto from "node:crypto";
import { armyPower, simulate } from "../shared/battle.js";
import { mulberry32 } from "../shared/rng.js";
import { BOSSES, BOSS_TIERS, RELICS, UNIT_KEYS, bossArmy, rollLoot } from "../shared/rules.js";
import { FOG_CELL, FOG_W, REALMS, SIGHT } from "../shared/world.js";
import { lairs } from "./bounties";
import { db, feed, type BattleRecord, type Player } from "./db";
import { GameError, addGold, award, boostsOf, exploredBytes, inventory } from "./players";

const now = () => Date.now();
export const lairById = new Map(lairs.map((l) => [l.id, l]));

/** The player's boss record, created on first use so old saves need no migration. */
export function bossState(p: Player) {
  p.bosses ??= { discovered: [], cooldowns: {}, kills: {} };
  return p.bosses;
}

export function lairView(p: Player, id: string) {
  const l = lairById.get(id);
  if (!l) throw new GameError("No such lair.", 404);
  const boss = (BOSSES as any)[l.boss];
  const tier = (BOSS_TIERS as any)[boss.tier];
  const army = bossArmy(l.boss);
  const st = bossState(p);
  return {
    id: l.id,
    name: boss.name,
    lore: boss.lore,
    tier: boss.tier,
    tierName: tier.name,
    color: tier.color,
    look: boss.look,
    tint: boss.tint,
    scale: tier.look.scale,
    realm: l.realm,
    realmName: REALMS.find((r) => r.id === l.realm)?.name,
    intel: boss.intel,
    minKeep: tier.minKeep,
    cooldownMin: tier.cooldownMin,
    x: l.x,
    y: l.y,
    power: armyPower(army.units, army.levels, army.towers, army.champions),
    army: { units: army.units, levels: army.levels, towers: army.towers, champion: army.champions[0] },
    readyAt: st.cooldowns[l.id] ?? 0,
    kills: st.kills[l.id] ?? 0,
  };
}

/** Lairs the player has found. Undiscovered lairs are never sent. */
export function lairsFor(p: Player) {
  const st = bossState(p);
  return st.discovered.filter((id) => lairById.has(id)).map((id) => lairView(p, id));
}

/** Lairs now in sight or in explored land that the player hadn't found yet. */
export function discoverLairs(p: Player, pos: { x: number; y: number } | null) {
  const st = bossState(p);
  const explored = exploredBytes(p);
  const found: string[] = [];
  for (const l of lairs) {
    if (st.discovered.includes(l.id)) continue;
    const near = pos && Math.abs(pos.x - l.x) <= SIGHT && Math.abs(pos.y - l.y) <= SIGHT;
    const cell = Math.floor(l.y / FOG_CELL) * FOG_W + Math.floor(l.x / FOG_CELL);
    if (near || explored[cell] === 1) {
      st.discovered.push(l.id);
      found.push(l.id);
      const boss = (BOSSES as any)[l.boss];
      if (boss.tier === "legendary") feed({ kind: "boss", text: `${p.name} found the lair of ${boss.name}`, player: p.id });
    }
  }
  if (found.length) db.save();
  return found;
}

// ── Challenges ────────────────────────────────────────────────────────
/** How close (in tiles) you must stand to challenge; big bosses can be fought from a little further. */
const reachFor = (tier: string) => 4 + ((BOSS_TIERS as any)[tier].look.scale - 1) * 1.5;
const CLAIMS_KEPT = 50;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Fight a boss. Everything between the checks and the rewards is synchronous, so two requests
 * arriving together can't both pass the cooldown check. Each request carries a client-made id:
 * a retried or duplicated request gets the stored result back instead of a second fight.
 */
export function challenge(p: Player, id: string, units: Record<string, number>, requestId: unknown, opts: { forceIntel?: string | null } = {}) {
  const rid = typeof requestId === "string" && REQUEST_ID.test(requestId) ? requestId : null;
  if (!rid) throw new GameError("Missing request id.");
  p.bossClaims ??= {};
  const prev = p.bossClaims[rid];
  if (prev) return prev.response;

  const st = bossState(p);
  const l = lairById.get(id);
  if (!l || !st.discovered.includes(id)) throw new GameError("You haven't found that lair yet.", 404);
  const boss = (BOSSES as any)[l.boss];
  const tier = (BOSS_TIERS as any)[boss.tier];
  if (!p.pos || Math.hypot(p.pos.x - l.x, p.pos.y - l.y) > reachFor(boss.tier)) throw new GameError(`Walk up to ${boss.name}'s lair to challenge it.`);
  const readyAt = st.cooldowns[id] ?? 0;
  if (readyAt > now()) throw new GameError(`${boss.name} has retreated to lick its wounds. It returns in ${Math.ceil((readyAt - now()) / 60000)} min.`, 429);
  const sent: Record<string, number> = {};
  for (const k of UNIT_KEYS) {
    const n = Math.max(0, Math.floor(Number(units?.[k] ?? 0) || 0));
    if (n > (p.army[k] ?? 0)) throw new GameError(`You only have ${p.army[k] ?? 0} ${k}.`);
    if (n) sent[k] = n;
  }
  if (!Object.keys(sent).length) throw new GameError("Send at least one unit.");

  const army = bossArmy(l.boss);
  const seed = crypto.randomBytes(4).readUInt32LE(0);
  const boosts = boostsOf(p);
  const result = simulate({ attacker: { units: sent, levels: p.unitLevels, boosts }, defender: army, seed });
  const rec: BattleRecord = {
    id: `F-${++db.data.meta.battleSeq}`,
    bounty: `lair:${id}`,
    boss: id,
    at: now(),
    seed,
    attacker: { id: p.id, name: p.name, units: sent, levels: { ...p.unitLevels }, ...(boosts ? { boosts } : {}) },
    defender: { id: `boss:${id}`, name: boss.name, units: army.units, levels: army.levels, towers: army.towers, champions: army.champions },
    result,
  };
  db.data.battles[rec.id] = rec;
  for (const [k, n] of Object.entries(result.lost)) p.army[k] = Math.max(0, (p.army[k] ?? 0) - (n as number));
  p.lastCombatAt = now();
  p.stats.battles++;
  st.cooldowns[id] = now() + tier.cooldownMin * 60_000; // win or lose: no instant retries
  const win = result.winner === "attacker";
  let loot = null;
  if (win) {
    p.stats.wins++;
    award(p, "first-blood");
    if (p.stats.wins >= 10) award(p, "warlord");
    st.kills[id] = (st.kills[id] ?? 0) + 1;
    award(p, "boss-slayer");
    if (boss.tier === "legendary") award(p, "giant-killer");
    loot = grantLoot(p, l.boss, seed, opts.forceIntel ?? null);
    feed({ kind: "boss", text: `${p.name} defeated ${boss.name} (${tier.name})`, player: p.id });
  }
  const response = { battle: rec, win, loot, lair: lairView(p, id) };
  p.bossClaims[rid] = { at: now(), response };
  const keys = Object.keys(p.bossClaims);
  if (keys.length > CLAIMS_KEPT) for (const k of keys.sort((a, b) => p.bossClaims![a].at - p.bossClaims![b].at).slice(0, keys.length - CLAIMS_KEPT)) delete p.bossClaims[k];
  db.save();
  return response;
}

/** Roll and pay a boss's loot. Server-side only; the roll is seeded from the battle. */
function grantLoot(p: Player, bossKey: string, seed: number, forceIntel: string | null) {
  const boss = (BOSSES as any)[bossKey];
  const inv = inventory(p);
  const loot = rollLoot(boss.tier, mulberry32((seed ^ 0x10075eed) >>> 0), { forceIntel, owned: inv.relics });
  const goldLanded = addGold(p, loot.gold);
  for (const [k, n] of Object.entries(loot.materials)) inv.materials[k] = (inv.materials[k] ?? 0) + (n as number);
  for (const [k, n] of Object.entries(loot.manuals)) inv.manuals[k] = (inv.manuals[k] ?? 0) + (n as number);
  inv.scrolls += loot.scrolls;
  if (loot.relic) {
    inv.relics[loot.relic] = { at: now(), from: bossKey };
    feed({ kind: "boss", text: `${p.name} claimed the ${(RELICS as any)[loot.relic].name} from ${boss.name}`, player: p.id });
    if (Object.keys(inv.relics).length >= 3) award(p, "relic-hunter");
  }
  return { ...loot, goldLanded };
}
