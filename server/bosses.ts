// Boss lairs: discovery, the lair view, and (from stage 2) challenges and loot.
import { armyPower } from "../shared/battle.js";
import { BOSSES, BOSS_TIERS, bossArmy } from "../shared/rules.js";
import { FOG_CELL, FOG_W, REALMS, SIGHT } from "../shared/world.js";
import { lairs } from "./bounties";
import { db, feed, type Player } from "./db";
import { GameError, exploredBytes } from "./players";

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

void now;
