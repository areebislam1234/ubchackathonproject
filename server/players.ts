// Player accounts, the fortress economy, exploration and badges.
import crypto from "node:crypto";
import {
  BADGES,
  BUILDINGS,
  MATERIAL_KEYS,
  START,
  UNITS,
  UNIT_KEYS,
  armyCapacity,
  housingOf,
  materialDiscount,
  relicEffects,
  unitUpgradeCost,
  unlockedUnits,
  upgradeCost,
  vaultCapWith,
} from "../shared/rules.js";
import { FOG_H, FOG_W } from "../shared/world.js";
import { db, feed, type Inventory, type Player } from "./db";

/** After attacking you count as "in combat" this long: no recalling home. */
export const COMBAT_MS = 30_000;

export class GameError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const badgeListeners: ((p: Player, badge: string) => void)[] = [];
export const onBadge = (fn: (p: Player, badge: string) => void) => badgeListeners.push(fn);

export function newPlayer(name: string, opts: { email?: string; bot?: boolean } = {}): Player {
  const id = (opts.bot ? "bot_" : "p_") + (++db.data.meta.playerSeq).toString(36) + crypto.randomBytes(3).toString("hex");
  const p: Player = {
    id,
    name: name.slice(0, 20),
    email: opts.email,
    createdAt: Date.now(),
    bot: opts.bot,
    gold: START.gold,
    crystals: START.crystals,
    trophies: 0,
    buildings: { ...START.buildings },
    army: { ...START.army },
    unitLevels: { ...START.unitLevels },
    pos: null,
    explored: Buffer.alloc(FOG_W * FOG_H).toString("base64"),
    discovered: [],
    attuned: ["Kingsmarket"],
    badges: {},
    stats: { battles: 0, wins: 0, bountiesEntered: 0, bountiesWon: 0, predictions: 0, correct: 0, discovered: 0, crystalsEarned: 0 },
    history: [],
  };
  db.data.players[id] = p;
  db.save();
  return p;
}

// ── Accounts ──────────────────────────────────────────────────────────
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,18}[A-Za-z0-9]$/;
const scrypt = (password: string, salt: Buffer) =>
  new Promise<Buffer>((ok, fail) => crypto.scrypt(password.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? fail(e) : ok(k))));

async function setPassword(p: Player, password: string) {
  const salt = crypto.randomBytes(16);
  p.auth = { algo: "scrypt", salt: salt.toString("base64"), hash: (await scrypt(password, salt)).toString("base64") };
}
async function checkPassword(p: Player, password: string) {
  if (!p.auth) return false;
  const want = Buffer.from(p.auth.hash, "base64");
  const got = await scrypt(password, Buffer.from(p.auth.salt, "base64"));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function validatePassword(pw: unknown) {
  const s = String(pw ?? "");
  if (s.length < 8) throw new GameError("Passwords need at least 8 characters.");
  if (s.length > 200) throw new GameError("That password is too long.");
  return s;
}

// Slow down guessing: 5 wrong passwords for a name locks it for a minute.
const failures = new Map<string, { n: number; until: number }>();
function checkLock(key: string) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) throw new GameError(`Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s.`, 429);
}
function noteFailure(key: string) {
  const f = failures.get(key) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) {
    f.until = Date.now() + 60_000;
    f.n = 0;
  }
  failures.set(key, f);
}

/** Sessions end after this long without a request. */
export const SESSION_IDLE_MS = 12 * 3600_000;

function startSession(p: Player) {
  const token = crypto.randomBytes(24).toString("base64url");
  db.data.sessions[token] = p.id;
  (db.data.sessionSeen ??= {})[token] = Date.now();
  db.save();
  return token;
}

export async function register(name: string, password: string) {
  const clean = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(clean)) throw new GameError("Names are 3–20 letters, numbers, spaces, dots, dashes or underscores.");
  const pw = validatePassword(password);
  const key = clean.toLowerCase();
  if (db.data.usernames[key]) throw new GameError("That name is taken. Pick another, or sign in.", 409);
  const p = newPlayer(clean);
  await setPassword(p, pw);
  db.data.usernames[key] = p.id;
  feed({ kind: "join", text: `${p.name} raised a banner in the Crownlands`, player: p.id });
  return { token: startSession(p), player: p };
}

export async function signIn(name: string, password: string) {
  const key = String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const pw = String(password ?? "");
  checkLock(key);
  const id = db.data.usernames[key];
  const p = id ? db.data.players[id] : undefined;
  if (!p || p.bot) {
    noteFailure(key);
    throw new GameError("Wrong name or password.", 401);
  }
  if (!p.auth) {
    // Accounts made before passwords existed: the first sign-in sets it.
    await setPassword(p, validatePassword(pw));
    return { token: startSession(p), player: p, passwordSet: true };
  }
  if (!(await checkPassword(p, pw))) {
    noteFailure(key);
    throw new GameError("Wrong name or password.", 401);
  }
  failures.delete(key);
  return { token: startSession(p), player: p };
}

export function logout(token: string | undefined) {
  if (token && db.data.sessions[token]) {
    delete db.data.sessions[token];
    delete db.data.sessionSeen?.[token];
    db.save();
  }
}

export function bySession(token: string | undefined): Player | null {
  if (!token) return null;
  const id = db.data.sessions[token];
  if (!id) return null;
  const seen = (db.data.sessionSeen ??= {});
  const now = Date.now();
  // sessions from before idle expiry existed start their clock now
  if (seen[token] && now - seen[token] > SESSION_IDLE_MS) {
    delete db.data.sessions[token];
    delete seen[token];
    db.save();
    return null;
  }
  if (!seen[token] || now - seen[token] > 60_000) {
    seen[token] = now;
    db.save();
  }
  return db.data.players[id] ?? null;
}

/** Put a warlord at their fortress gate (every sign-in starts there). */
export function sendHome(p: Player) {
  if (p.home) p.pos = { x: p.home.x, y: p.home.y + 2 };
}

// ── Inventory and relics ──────────────────────────────────────────────
/** The player's bag, created on first use so saves from before loot existed load unchanged. */
export function inventory(p: Player): Inventory {
  p.inventory ??= { materials: {}, manuals: {}, scrolls: 0, relics: {} };
  for (const k of MATERIAL_KEYS) p.inventory.materials[k] ??= 0;
  return p.inventory;
}
export const materialCount = (p: Player) => MATERIAL_KEYS.reduce((s, k) => s + (p.inventory?.materials[k] ?? 0), 0);
export const relicFx = (p: Player) => relicEffects(p.inventory?.relics ?? {});
export const vaultCap = (p: Player) => vaultCapWith(p.buildings.vault, relicFx(p));
/** Relic damage bonuses for the battle simulator, or undefined when there are none. */
export function boostsOf(p: Player) {
  const d = relicFx(p).dmg;
  return Object.keys(d).length ? d : undefined;
}

/** Add gold, clamped to vault capacity. Returns what actually landed. */
export function addGold(p: Player, amount: number) {
  const cap = vaultCap(p);
  const before = p.gold;
  p.gold = Math.max(0, Math.min(cap, p.gold + amount));
  return p.gold - before;
}

export function spend(p: Player, cost: { gold?: number; crystals?: number }) {
  if ((cost.gold ?? 0) > p.gold) throw new GameError(`You need ${cost.gold} gold (you have ${p.gold}).`);
  if ((cost.crystals ?? 0) > p.crystals) throw new GameError(`You need ${cost.crystals} crystals (you have ${p.crystals}). Crystals come from well-calibrated predictions.`);
  p.gold -= cost.gold ?? 0;
  p.crystals -= cost.crystals ?? 0;
}

export function upgradeBuilding(p: Player, building: string, opts: { useMaterials?: boolean } = {}) {
  const def = (BUILDINGS as any)[building];
  if (!def || building === "trophy") throw new GameError("That building can't be upgraded.");
  const lvl = p.buildings[building] ?? 1;
  if (lvl >= def.max) throw new GameError(`${def.name} is already at max level.`);
  if (building !== "keep" && lvl >= p.buildings.keep + 1) throw new GameError(`Raise your Keep first: buildings can be at most one level above it (Keep is level ${p.buildings.keep}).`);
  const cost = { ...upgradeCost(building, lvl)! };
  // Materials from boss loot knock gold off the price (never crystals, never the Keep rule).
  let used = 0;
  if (opts.useMaterials && cost.gold) {
    const d = materialDiscount(cost.gold, materialCount(p));
    cost.gold -= d.gold;
    used = d.materials;
  }
  spend(p, cost);
  if (used) {
    const inv = inventory(p);
    for (let i = 0; i < used; i++) {
      const k = MATERIAL_KEYS.reduce((a, b) => (inv.materials[b] > inv.materials[a] ? b : a));
      inv.materials[k]--;
    }
  }
  p.buildings[building] = lvl + 1;
  if (building === "keep" && lvl + 1 >= 3) award(p, "stronghold");
  if (building === "keep") feed({ kind: "upgrade", text: `${p.name} raised their Keep to level ${lvl + 1}`, player: p.id });
  db.save();
  return { building, level: lvl + 1, materialsUsed: used, goldPaid: cost.gold ?? 0 };
}

export function train(p: Player, unit: string, count: number) {
  const u = (UNITS as any)[unit];
  if (!u) throw new GameError("Unknown unit.");
  if (!unlockedUnits(p.buildings.barracks).includes(unit)) throw new GameError(`${u.name} unlock at Barracks level ${u.unlock}.`);
  const n = Math.max(1, Math.min(50, Math.floor(count)));
  const cap = armyCapacity(p.buildings.barracks);
  const used = housingOf(p.army);
  if (used + n * u.housing > cap) throw new GameError(`Not enough room: ${used}/${cap} housing used. Upgrade the Barracks for more.`);
  spend(p, { gold: u.cost * n });
  p.army[unit] = (p.army[unit] ?? 0) + n;
  db.save();
  return { unit, count: p.army[unit] };
}

export function disband(p: Player, unit: string, count: number) {
  const n = Math.max(1, Math.min(p.army[unit] ?? 0, Math.floor(count)));
  if (!n) throw new GameError("No units to disband.");
  p.army[unit] -= n;
  db.save();
  return { unit, count: p.army[unit] };
}

export function upgradeUnit(p: Player, unit: string, opts: { use?: "manual" | "scroll" } = {}) {
  const u = (UNITS as any)[unit];
  if (!u) throw new GameError("Unknown unit.");
  const lvl = p.unitLevels[unit] ?? 1;
  if (lvl >= p.buildings.training) throw new GameError(`Upgrade the Training Grounds to train ${u.name} past level ${lvl}.`);
  if (opts.use === "manual") {
    const inv = inventory(p);
    if (!(inv.manuals[unit] > 0)) throw new GameError(`You have no ${u.name} training manuals.`);
    inv.manuals[unit]--;
  } else if (opts.use === "scroll") {
    const inv = inventory(p);
    if (!(inv.scrolls > 0)) throw new GameError("You have no upgrade scrolls.");
    inv.scrolls--;
  } else spend(p, { gold: unitUpgradeCost(unit, lvl) });
  p.unitLevels[unit] = lvl + 1;
  db.save();
  return { unit, level: lvl + 1 };
}

// ── Exploration ───────────────────────────────────────────────────────
export function exploredBytes(p: Player) {
  return Buffer.from(p.explored, "base64");
}
export function markExplored(p: Player, cells: number[]) {
  const buf = exploredBytes(p);
  let fresh = 0;
  for (const c of cells) {
    if (!Number.isInteger(c) || c < 0 || c >= buf.length) continue;
    if (!buf[c]) {
      buf[c] = 1;
      fresh++;
    }
  }
  if (fresh) {
    p.explored = buf.toString("base64");
    db.save();
  }
  return fresh;
}

// ── Badges ────────────────────────────────────────────────────────────
export function award(p: Player, badge: string) {
  if (p.bot || !(badge in BADGES) || p.badges[badge]) return;
  p.badges[badge] = { earnedAt: Date.now(), status: "unclaimed" };
  feed({ kind: "badge", text: `${p.name} earned the ${(BADGES as any)[badge].name} badge`, player: p.id });
  db.save();
  for (const fn of badgeListeners) fn(p, badge);
}

/** Everything the client needs about the signed-in player. */
export function playerView(p: Player) {
  const cap = armyCapacity(p.buildings.barracks);
  const inv = inventory(p);
  const mats = materialCount(p);
  const nextCosts = Object.fromEntries(Object.keys(BUILDINGS).map((b) => [b, (p.buildings[b] ?? 1) < (BUILDINGS as any)[b].max ? upgradeCost(b, p.buildings[b] ?? 1) : null]));
  return {
    id: p.id,
    name: p.name,
    gold: p.gold,
    crystals: p.crystals,
    trophies: p.trophies,
    buildings: p.buildings,
    army: p.army,
    unitLevels: p.unitLevels,
    pos: p.pos,
    home: p.home ?? null,
    combatUntil: (p.lastCombatAt ?? 0) + COMBAT_MS,
    explored: p.explored,
    discovered: p.discovered,
    attuned: p.attuned,
    wallet: p.wallet ? { address: p.wallet.address, kind: p.wallet.kind, label: p.wallet.label ?? null, verified: p.wallet.kind === "address" ? false : p.wallet.verified ?? true } : null,
    badges: p.badges,
    stats: p.stats,
    history: p.history.slice(-20).reverse(),
    inventory: inv,
    relicFx: relicFx(p),
    bossKills: Object.values(p.bosses?.kills ?? {}).reduce((s, n) => s + n, 0),
    intelCount: p.intel?.length ?? 0,
    derived: {
      capacity: cap,
      housing: housingOf(p.army),
      vaultCap: vaultCap(p),
      materials: mats,
      materialDiscount: Object.fromEntries(Object.entries(nextCosts).map(([b, c]) => [b, c?.gold ? materialDiscount(c.gold, mats) : null])),
      unlocked: unlockedUnits(p.buildings.barracks),
      nextCosts,
      unitUpgradeCosts: Object.fromEntries(UNIT_KEYS.map((k) => [k, unitUpgradeCost(k, p.unitLevels[k] ?? 1)])),
    },
  };
}
