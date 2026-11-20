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
  archer: { infantry: 1.5, tank: 0.5, boss: 0.8 },
  cavalry: { archer: 1.8, siege: 1.8 },
  siege: { tank: 2.2, tower: 2.5, boss: 1.6 },
  tank: { boss: 1.5 },
  tower: { cavalry: 1.2 },
  boss: {},
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

// ── Boss lairs ────────────────────────────────────────────────────────
// Bosses live at fixed lairs on the world map. Every number that decides how hard they are and
// what they drop is here, so balance can be tuned without touching the server.
export const BOSS_TIER_KEYS = ["common", "rare", "epic", "legendary"];
export const BOSS_TIERS = {
  common: {
    name: "Common",
    color: "#a3a3b3",
    minKeep: 1, // a hint shown to players, not a gate
    cooldownMin: 5, // per player, after every attempt
    look: { scale: 1, aura: null },
    champion: { hp: 520, dmg: 18 },
    escort: { units: { infantry: 3, archer: 2, tank: 0, cavalry: 0, siege: 0 }, level: 1, towers: 0 },
    loot: { relic: 0 },
    intel: { chance: 0.1, rarity: { common: 1 } },
  },
  rare: {
    name: "Rare",
    color: "#4f8ee0",
    minKeep: 2,
    cooldownMin: 15,
    look: { scale: 1.5, aura: "#7ba8f2" },
    champion: { hp: 1000, dmg: 25 },
    escort: { units: { infantry: 4, archer: 4, tank: 1, cavalry: 0, siege: 0 }, level: 2, towers: 1 },
    loot: { relic: 0 },
    intel: { chance: 0.25, rarity: { common: 0.6, rare: 0.4 } },
  },
  epic: {
    name: "Epic",
    color: "#8f52d4",
    minKeep: 3,
    cooldownMin: 30,
    look: { scale: 2, aura: "#c49bf2" },
    champion: { hp: 2600, dmg: 42 },
    escort: { units: { infantry: 6, archer: 5, tank: 2, cavalry: 2, siege: 0 }, level: 3, towers: 1 },
    loot: { relic: 0.1 },
    intel: { chance: 0.45, rarity: { common: 0.2, rare: 0.5, epic: 0.3 } },
  },
  legendary: {
    name: "Legendary",
    color: "#f6c33b",
    minKeep: 4,
    cooldownMin: 60,
    look: { scale: 3, aura: "#e23c3c" },
    champion: { hp: 4300, dmg: 60 },
    escort: { units: { infantry: 5, archer: 4, tank: 2, cavalry: 2, siege: 0 }, level: 4, towers: 1 },
    loot: { relic: 0.25 },
    intel: { chance: 0.7, rarity: { rare: 0.3, epic: 0.45, legendary: 0.25 } },
  },
};

/** How each kind of boss fights. Multiplies the tier's champion stats; range and splash are in tiles. */
export const BOSS_LOOKS = {
  ogre: { hp: 1, dmg: 1.15, range: 1.6, speed: 0.8, cooldown: 14, splash: 0 },
  golem: { hp: 1.35, dmg: 0.85, range: 1.6, speed: 0.55, cooldown: 16, splash: 0.8 },
  wyrm: { hp: 1.1, dmg: 0.9, range: 5, speed: 0.7, cooldown: 18, splash: 1.5 },
  lich: { hp: 0.8, dmg: 1, range: 6.5, speed: 0.6, cooldown: 15, splash: 1 },
  titan: { hp: 1.2, dmg: 1.05, range: 1.8, speed: 0.7, cooldown: 15, splash: 1.2 },
  yeti: { hp: 0.95, dmg: 1, range: 1.5, speed: 1.3, cooldown: 11, splash: 0 },
};

/** Intel categories. Each boss's realm decides which kind of intelligence it can drop. */
export const INTEL_CATEGORIES = {
  sports: { name: "Sports", icon: "trophy" },
  crypto: { name: "Crypto", icon: "bolt" },
  economics: { name: "Economics", icon: "coin" },
  general: { name: "General", icon: "scroll" },
};
export const INTEL_RARITIES = ["common", "rare", "epic", "legendary"];
const REALM_INTEL = {
  crownlands: { category: "general", topic: "Politics" },
  frostpeaks: { category: "general", topic: "Weather" },
  ironvein: { category: "crypto", topic: "Crypto" },
  goldmarsh: { category: "economics", topic: "Economics" },
  sunscar: { category: "general", topic: "Commodities" },
  arena: { category: "sports", topic: "Sports" },
  whisperwood: { category: "general", topic: "Culture" },
};

// tint: palette swaps applied to the base look, so bosses sharing a body still look distinct.
const defBoss = (name, tier, realm, look, lore, tint = null, mods = {}) => ({ name, tier, realm, look, lore, tint, mods, intel: REALM_INTEL[realm] });
export const BOSSES = {
  "gravel-king": defBoss("Gravel King Brunt", "common", "crownlands", "ogre", "Claims every road toll in the Crownlands. Nobody remembers voting for him."),
  "malvek": defBoss("Usurper Malvek", "rare", "crownlands", "ogre", "Took a throne by recount and kept it by club.", "royal"),
  "hollow-regent": defBoss("The Hollow Regent", "epic", "crownlands", "lich", "A crown with nobody inside it, still issuing decrees.", "royal"),
  "rimefang": defBoss("Rimefang", "common", "frostpeaks", "yeti", "Hunts whatever the forecast missed."),
  "matron-hail": defBoss("Matron Hailstorm", "rare", "frostpeaks", "yeti", "Her moods arrive three days before the weather does.", "storm"),
  "glacier-wyrm": defBoss("The Glacier Wyrm", "epic", "frostpeaks", "wyrm", "Its breath turns whole valleys into January.", "frost"),
  "slag-golem": defBoss("Slag Golem", "common", "ironvein", "golem", "Built from the scrap of a thousand failed miners."),
  "gasfee-golem": defBoss("The Gas-Fee Golem", "rare", "ironvein", "golem", "Charges you for every step you take toward it.", "ember"),
  "hashforge-colossus": defBoss("The Hashforge Colossus", "legendary", "ironvein", "golem", "Woken by the hum of the deepest rigs. Every blow it lands is final.", "molten"),
  "bog-mudd": defBoss("Bog Ogre Mudd", "common", "goldmarsh", "ogre", "Sits on the marsh's only dry coin pile.", "bog"),
  "inflation-lich": defBoss("The Inflation Lich", "rare", "goldmarsh", "lich", "Each spell costs a little more than the last.", "gold"),
  "ledger-wyrm": defBoss("The Ledger Wyrm", "legendary", "goldmarsh", "wyrm", "Coiled around the oldest treasury in the realm. It never forgets a debt.", "gold"),
  "dune-kesh": defBoss("Dune Titan Kesh", "common", "sunscar", "titan", "Guards a well that has not had water in years."),
  "crude-baron": defBoss("The Crude Baron", "rare", "sunscar", "titan", "Prices everything in barrels, including your life.", "oil"),
  "sandstorm-wyrm": defBoss("The Sandstorm Wyrm", "epic", "sunscar", "wyrm", "Swims through the dunes. You only see it when it wants you to.", "sand"),
  "pit-brawler": defBoss("Pit Brawler Goro", "common", "arena", "ogre", "Lost his first fight. Has not lost one since.", "arena"),
  "the-undefeated": defBoss("The Undefeated", "rare", "arena", "titan", "Twenty seasons, no losses, one very large trophy room.", "arena"),
  "grand-champion": defBoss("The Grand Champion", "legendary", "arena", "titan", "Every crowd in the Arena Plains chants one name. It is not yours.", "champion"),
  "lantern-wisp": defBoss("Lantern Wisp", "common", "whisperwood", "lich", "Leads travellers off the trail and into the charts.", "wisp"),
  "thornwitch": defBoss("The Thornwitch", "rare", "whisperwood", "lich", "Reviews every hero who passes. The reviews are harsh.", "thorn"),
  "elder-treant": defBoss("The Elder Treant", "epic", "whisperwood", "golem", "Older than the forest's oldest story, and tired of hearing it.", "wood"),
};
export const BOSS_KEYS = Object.keys(BOSSES);

/** The full combat setup for a boss: its escort army, levels, towers and the champion itself. */
export function bossArmy(key) {
  const boss = BOSSES[key];
  const t = BOSS_TIERS[boss.tier];
  const L = BOSS_LOOKS[boss.look];
  const m = boss.mods ?? {};
  const lvl = t.escort.level;
  return {
    units: { ...t.escort.units },
    levels: Object.fromEntries(UNIT_KEYS.map((k) => [k, lvl])),
    towers: t.escort.towers,
    champions: [
      {
        look: key, // sprite id: boss_<key>_<frame>
        hp: Math.round(t.champion.hp * L.hp * (m.hp ?? 1)),
        dmg: Math.round(t.champion.dmg * L.dmg * (m.dmg ?? 1)),
        range: L.range,
        speed: L.speed,
        cooldown: L.cooldown,
        splash: L.splash,
      },
    ],
  };
}

// ── Army upgrades ─────────────────────────────────────────────────────
// Two tracks make troops stronger on top of unit levels:
//   Mastery (major): bought with the upgrade currency that realized investment yield converts into.
//   Drills (minor): earned by defeating bosses. Capped at a quarter of Mastery, so fighting bosses
//   is always worth it but can never replace investing.
export const MASTERY = { perRank: 0.03, maxRank: 20 }; // +3% HP and damage per rank, up to +60%
export const DRILLS = {
  perPoint: 0.005, // +0.5% HP and damage per point on one unit type
  maxPerUnit: 30, // up to +15% per unit type
  dailyCap: 12, // points a warlord can earn from bosses per day (UTC)
  perTier: { common: 1, rare: 2, epic: 4, legendary: 8 },
};
/** HP / damage bonus fraction from drill points on one unit type. */
export const drillBonus = (points) => Math.min(DRILLS.maxPerUnit, Math.max(0, points ?? 0)) * DRILLS.perPoint;

// ── Loot ──────────────────────────────────────────────────────────────
export const MATERIALS = {
  timber: { name: "Timber", desc: "Seasoned beams for walls and halls." },
  stone: { name: "Cut Stone", desc: "Dressed blocks for keeps and towers." },
  iron: { name: "Iron Ingots", desc: "Bands, hinges and arrowheads." },
};
export const MATERIAL_KEYS = Object.keys(MATERIALS);
/** Each material spent takes this much gold off a building upgrade, up to MATERIAL_MAX_SHARE of it. */
export const MATERIAL_GOLD_VALUE = 20;
export const MATERIAL_MAX_SHARE = 0.5;

/** Permanent passive bonuses. `minTier` is the weakest boss tier that can drop it. */
export const RELICS = {
  "gravel-crown": { name: "Crown of the Gravel King", desc: "+1 Watchtower when rivals attack you.", minTier: "rare", effect: { towers: 1 } },
  "ledger-scale": { name: "Ledger Scale", desc: "+5% Vault capacity.", minTier: "rare", effect: { vault: 0.05 } },
  "hashforge-ember": { name: "Hashforge Ember", desc: "+5% Siege damage.", minTier: "rare", effect: { dmg: { siege: 0.05 } } },
  "rime-horn": { name: "Rimefang's Horn", desc: "+5% Cavalry damage.", minTier: "rare", effect: { dmg: { cavalry: 0.05 } } },
  "thorn-quiver": { name: "Thornwitch Quiver", desc: "+5% Archer damage.", minTier: "rare", effect: { dmg: { archer: 0.05 } } },
  "arena-belt": { name: "Champion's Belt", desc: "+5% Infantry damage.", minTier: "epic", effect: { dmg: { infantry: 0.05 } } },
  "dune-plate": { name: "Dune Titan Plate", desc: "+5% Tank damage.", minTier: "epic", effect: { dmg: { tank: 0.05 } } },
  "regent-seal": { name: "Seal of the Hollow Regent", desc: "+10% Vault capacity.", minTier: "epic", effect: { vault: 0.1 } },
  "wyrm-heart": { name: "Wyrm Heart", desc: "+5% damage for every unit.", minTier: "legendary", effect: { dmg: { all: 0.05 } } },
  "colossus-core": { name: "Colossus Core", desc: "+2 Watchtowers when rivals attack you.", minTier: "legendary", effect: { towers: 2 } },
};
export const RELIC_KEYS = Object.keys(RELICS);

/** Combined passive bonuses of the relics a player owns. */
export function relicEffects(relics = {}) {
  const fx = { vault: 0, towers: 0, dmg: {} };
  for (const id of Object.keys(relics ?? {})) {
    const e = RELICS[id]?.effect;
    if (!e) continue;
    fx.vault += e.vault ?? 0;
    fx.towers += e.towers ?? 0;
    for (const [k, v] of Object.entries(e.dmg ?? {})) fx.dmg[k] = (fx.dmg[k] ?? 0) + v;
  }
  return fx;
}
/** Vault capacity including relic bonuses. */
export const vaultCapWith = (vault, fx) => Math.round(vaultCapacity(vault) * (1 + (fx?.vault ?? 0)));
/** How many materials an upgrade can use and the gold they save. */
export function materialDiscount(goldCost, have) {
  const max = Math.floor(((goldCost ?? 0) * MATERIAL_MAX_SHARE) / MATERIAL_GOLD_VALUE);
  const use = Math.max(0, Math.min(max, have ?? 0));
  return { materials: use, gold: use * MATERIAL_GOLD_VALUE };
}

const tierIndex = (t) => BOSS_TIER_KEYS.indexOf(t);
function weighted(rnd, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [k, w] of entries) if ((r -= w) < 0) return k;
  return entries[entries.length - 1]?.[0];
}

/**
 * Roll a boss's loot: drill points (a minor army upgrade), sometimes a relic, sometimes an
 * intelligence report. Bosses give no gold or items. Pure: the same rnd sequence gives the same loot.
 * `owned` relics are skipped so a relic drop is always something new (no relic if all are owned).
 * `forceIntel` (dev tools) guarantees an intel drop of that rarity.
 * @param {string} tier
 * @param {() => number} rnd
 * @param {{ owned?: Record<string, unknown>, forceIntel?: string | null }} [opts]
 */
export function rollLoot(tier, rnd, { owned = {}, forceIntel = null } = {}) {
  const t = BOSS_TIERS[tier];
  /** @type {{ drills: number, relic: string | null, intel: { rarity: string } | null }} */
  const loot = { drills: DRILLS.perTier[tier] ?? 0, relic: null, intel: null };
  if (rnd() < t.loot.relic) {
    const pool = RELIC_KEYS.filter((k) => tierIndex(RELICS[k].minTier) <= tierIndex(tier) && !owned[k]);
    if (pool.length) loot.relic = pool[Math.floor(rnd() * pool.length)];
  }
  if (forceIntel) loot.intel = { rarity: forceIntel };
  else if (rnd() < t.intel.chance) loot.intel = { rarity: weighted(rnd, t.intel.rarity) };
  return loot;
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
  "boss-slayer": { name: "Boss Slayer", desc: "Defeat a boss in its lair.", icon: "skull" },
  "giant-killer": { name: "Giant Killer", desc: "Defeat a Legendary boss.", icon: "sword" },
  "relic-hunter": { name: "Relic Hunter", desc: "Own 3 relics.", icon: "chest" },
  spymaster: { name: "Spymaster", desc: "Collect 10 intelligence reports.", icon: "scroll" },
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
