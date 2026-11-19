// Game rules shared by the server (authoritative) and the browser (previews).

// ── Army ──────────────────────────────────────────────────────────────
export const UNITS = {
  infantry: { name: "Infantry", role: "Spear wall. Cheap, sturdy, beats Cavalry.", hp: 110, dmg: 12, range: 1.3, speed: 1.0, cooldown: 10, housing: 1, cost: 10, unlock: 1 },
  archer: { name: "Archers", role: "Ranged volleys. Shreds Infantry from behind the line.", hp: 65, dmg: 11, range: 6, speed: 1.0, cooldown: 12, housing: 1, cost: 14, unlock: 1 },
  tank: { name: "Tanks", role: "Heavy shieldguard. Soaks arrows, holds the front.", hp: 320, dmg: 9, range: 1.3, speed: 0.65, cooldown: 11, housing: 3, cost: 35, unlock: 2 },
  cavalry: { name: "Cavalry", role: "Fast flankers. Crush Archers and Siege.", hp: 150, dmg: 17, range: 1.4, speed: 1.9, cooldown: 10, housing: 2, cost: 25, unlock: 3 },
  siege: { name: "Siege", role: "Catapults. Slow, splash damage, wreck Tanks and towers.", hp: 120, dmg: 38, range: 8, speed: 0.5, cooldown: 26, housing: 4, cost: 45, unlock: 4, splash: 1.6 },
};
export const UNIT_KEYS = Object.keys(UNITS);
/** Damage multipliers: attacker → target. */
export const COUNTERS = {
  infantry: { cavalry: 1.7 },
  archer: { infantry: 1.5, tank: 0.5 },
  cavalry: { archer: 1.8, siege: 1.8 },
  siege: { tank: 2.2, tower: 2.5 },
  tank: {},
  tower: { cavalry: 1.2 },
};
export const TOWER = { hp: 260, dmg: 13, range: 7, cooldown: 13 };
export const unitMult = (level) => 1 + 0.12 * (Math.max(1, level) - 1);

// ── Fortress ──────────────────────────────────────────────────────────
export const BUILDINGS = {
  keep: { name: "Keep", desc: "Your fortress. Other buildings can rise at most one level above it. Upgrading it takes Crystals, which come only from well-calibrated predictions.", max: 5 },
  barracks: { name: "Barracks", desc: "Unlocks unit types and sets how big your army can be.", max: 5 },
  training: { name: "Training Grounds", desc: "Sets the highest level your units can train to. Each unit level adds 12% HP and damage.", max: 5 },
  vault: { name: "Vault", desc: "Stores gold. Gold above capacity is lost.", max: 5 },
  towers: { name: "Watchtowers", desc: "Archer towers that defend you when rivals attack you inside a bounty.", max: 5 },
  trophy: { name: "Trophy Room", desc: "Badges, bounty placements and the collectibles minted to your Solana wallet.", max: 1 },
};
export function upgradeCost(building, level) {
  // cost to go from `level` to `level + 1`
  switch (building) {
    case "keep":
      return { gold: 300 * level, crystals: 40 * level };
    case "barracks":
      return { gold: 150 * level };
    case "training":
      return { gold: 180 * level };
    case "vault":
      return { gold: 120 * level };
    case "towers":
      return { gold: 160 * level };
    default:
      return null;
  }
}
export const armyCapacity = (barracks) => 12 + 6 * (barracks - 1);
export const vaultCapacity = (vault) => 1500 + 1000 * (vault - 1);
export const unitUpgradeCost = (unit, level) => UNITS[unit].cost * 8 * level;
export const unlockedUnits = (barracks) => UNIT_KEYS.filter((k) => UNITS[k].unlock <= barracks);
export const housingOf = (army) => UNIT_KEYS.reduce((s, k) => s + (army[k] ?? 0) * UNITS[k].housing, 0);

export const START = {
  gold: 500,
  crystals: 0,
  buildings: { keep: 1, barracks: 1, training: 1, vault: 1, towers: 1, trophy: 1 },
  army: { infantry: 6, archer: 4, tank: 0, cavalry: 0, siege: 0 },
  unitLevels: { infantry: 1, archer: 1, tank: 1, cavalry: 1, siege: 1 },
};

// ── Bounties ──────────────────────────────────────────────────────────
// Placement index: 0 = 1st, 1 = 2nd, 2 = 3rd, 3 = everyone else.
export const TIERS = {
  common: { name: "Common", entry: 40, maxPlayers: 8, minKeep: 1, gold: [220, 130, 80, 30], stake: [200, 120, 80, 0], trophies: [30, 20, 10, 3], guardian: 1 },
  rare: { name: "Rare", entry: 90, maxPlayers: 10, minKeep: 1, gold: [420, 260, 160, 50], stake: [350, 220, 140, 0], trophies: [45, 30, 15, 4], guardian: 2 },
  epic: { name: "Epic", entry: 160, maxPlayers: 12, minKeep: 2, gold: [700, 420, 260, 80], stake: [600, 360, 240, 0], trophies: [70, 45, 25, 6], guardian: 3 },
};
export const FEATURED_BONUS = 1.5;
export const ATTACKS_PER_BOUNTY = 3;
export const DEFENSE_POINTS = 60;
export const placeIndex = (rank) => Math.min(3, rank - 1);
export function rewardsFor(tier, rank, featured = false) {
  const t = TIERS[tier];
  const i = placeIndex(rank);
  const m = featured ? FEATURED_BONUS : 1;
  return { gold: Math.round(t.gold[i] * m), stakeCap: Math.round(t.stake[i] * m), trophies: t.trophies[i] };
}

/** NPC guardian army for a tier (used when a bounty has nobody else to fight). */
export function guardianArmy(tier) {
  const g = TIERS[tier].guardian;
  return {
    units: { infantry: 3 + 2 * g, archer: 2 + 2 * g, tank: g - 1, cavalry: g > 2 ? 2 : 0, siege: 0 },
    levels: { infantry: g, archer: g, tank: g, cavalry: g, siege: 1 },
    towers: g,
  };
}

// ── Predictions ───────────────────────────────────────────────────────
/** Price (bps) to buy a side, from the YES bid/ask. */
export function sidePriceBps(side, yesBidBps, yesAskBps) {
  return side === "yes" ? yesAskBps : 10000 - yesBidBps;
}
export const payoutFor = (stake, priceBps) => Math.floor((stake * 10000) / Math.max(1, priceBps));
/** Brier score (0 best, 1 worst) of a confidence in the chosen side. */
export function brier(side, confBps, outcome) {
  const pYes = side === "yes" ? confBps / 10000 : 1 - confBps / 10000;
  const o = outcome === "yes" ? 1 : 0;
  return (pYes - o) * (pYes - o);
}
/** Crystals for a settled call: only honest, accurate confidence earns them. */
export const crystalsFor = (b) => Math.max(0, Math.round((0.25 - b) * 240));

// ── Achievements → Solana collectibles ────────────────────────────────
export const BADGES = {
  "first-blood": { name: "First Blood", desc: "Win your first battle.", icon: "swords" },
  champion: { name: "Bounty Champion", desc: "Finish 1st in a bounty.", icon: "crown" },
  oracle: { name: "Oracle", desc: "Make a correct prediction.", icon: "eye" },
  "called-it": { name: "Called It", desc: "Be right with 80%+ confidence.", icon: "star" },
  cartographer: { name: "Cartographer", desc: "Discover 10 bounties.", icon: "map" },
  warlord: { name: "Warlord", desc: "Win 10 battles.", icon: "shield" },
  stronghold: { name: "Stronghold", desc: "Raise your Keep to level 3.", icon: "castle" },
};
export const BADGE_IDS = Object.keys(BADGES);

export const BOT_NAMES = [
  "Sir Slippage",
  "Baroness Basis",
  "Count Theta",
  "Duke Delta",
  "Lady Liquidity",
  "Margin Mae",
  "The Arbiter",
  "Old Man Vega",
  "Captain Spread",
  "Dame Drawdown",
  "Lord Leverage",
  "Brother Beta",
];
