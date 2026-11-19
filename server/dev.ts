// Dev tools for demos: edit your own warlord and steer the world. Off when DEV_TOOLS=off.
import { BADGES, BUILDINGS, START, UNIT_KEYS } from "../shared/rules.js";
import { FOG_H, FOG_W } from "../shared/world.js";
import { db, type Player } from "./db";
import { GameError, award } from "./players";
import { discover, world } from "./bounties";

const clamp = (v: unknown, lo: number, hi: number) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) throw new GameError("Numbers only.");
  return Math.max(lo, Math.min(hi, n));
};

/** Set any of: gold, crystals, trophies, buildings{}, army{}, unitLevels{}. */
export function setPlayer(p: Player, body: any) {
  if (body.gold !== undefined) p.gold = clamp(body.gold, 0, 10_000_000);
  if (body.crystals !== undefined) p.crystals = clamp(body.crystals, 0, 10_000_000);
  if (body.trophies !== undefined) p.trophies = clamp(body.trophies, 0, 10_000_000);
  for (const [k, v] of Object.entries(body.buildings ?? {})) {
    const def = (BUILDINGS as any)[k];
    if (def) p.buildings[k] = clamp(v, 1, def.max);
  }
  for (const [k, v] of Object.entries(body.army ?? {})) if (UNIT_KEYS.includes(k)) p.army[k] = clamp(v, 0, 999);
  for (const [k, v] of Object.entries(body.unitLevels ?? {})) if (UNIT_KEYS.includes(k)) p.unitLevels[k] = clamp(v, 1, 5);
  db.save();
}

/** Explore the whole map, find every bounty and attune every waystone. */
export function revealAll(p: Player) {
  p.explored = Buffer.alloc(FOG_W * FOG_H, 1).toString("base64");
  p.attuned = world.towns.map((t) => t.name);
  discover(p, p.pos);
  db.save();
}

export function clearCombat(p: Player) {
  p.lastCombatAt = 0;
  db.save();
}

export function grantBadge(p: Player, badge: string) {
  if (!(badge in BADGES)) throw new GameError("Unknown badge.");
  award(p, badge);
}

/** Back to a brand-new warlord (keeps the account, wallet, fortress plot and badges). */
export function resetProgress(p: Player) {
  p.gold = START.gold;
  p.crystals = START.crystals;
  p.trophies = 0;
  p.buildings = { ...START.buildings };
  p.army = { ...START.army };
  p.unitLevels = { ...START.unitLevels };
  p.lastCombatAt = 0;
  db.save();
}
