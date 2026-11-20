// Player accounts, the fortress economy, exploration and badges.
import crypto from "node:crypto";
import {
  BADGES,
  BUILDINGS,
  DRILLS,
  ABILITIES,
  UNIT_CLASS,
  MAX_LOADOUT,
  cleanLoadout,
  ORDERS,
  PRESETS,
  PRESET_KEYS,
  autoFormation,
  formationArmy,
  validFormation,
  drillBonus,
  masteryCost,
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
import { db, feed, type Drills, type Formation, type Inventory, type Player } from "./db";

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
// ── Drills: minor army upgrades from bosses ───────────────────────────
const utcDay = () => new Date().toISOString().slice(0, 10);
export function drills(p: Player): Drills {
  p.drills ??= { units: {}, pool: 0, day: utcDay(), today: 0 };
  if (p.drills.day !== utcDay()) {
    p.drills.day = utcDay();
    p.drills.today = 0;
  }
  return p.drills;
}
/** Add drill points from a boss win, up to today's cap. Returns how many landed. */
export function earnDrills(p: Player, points: number) {
  const d = drills(p);
  const landed = Math.max(0, Math.min(points, DRILLS.dailyCap - d.today));
  d.today += landed;
  d.pool += landed;
  return landed;
}
/** Spend pool points on one unit type (each +0.5% HP and damage, up to 30). */
export function assignDrill(p: Player, unit: string, count = 1) {
  const u = (UNITS as any)[unit];
  if (!u) throw new GameError("Unknown unit.");
  const d = drills(p);
  const have = d.units[unit] ?? 0;
  const n = Math.max(1, Math.min(Math.floor(count) || 1, d.pool, DRILLS.maxPerUnit - have));
  if (d.pool <= 0) throw new GameError("No drill points to assign. Defeat bosses to earn them.");
  if (have >= DRILLS.maxPerUnit) throw new GameError(`${u.name} drills are maxed (+${Math.round(drillBonus(have) * 100)}%).`);
  d.units[unit] = have + n;
  d.pool -= n;
  db.save();
  return { unit, points: d.units[unit], pool: d.pool };
}
/** Drills (from bosses): the same bonus applies to HP and damage. */
const drillMap = (p: Player) => {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(p.drills?.units ?? {})) if (n > 0) out[k] = drillBonus(n);
  return out;
};

/** Damage bonuses for the battle simulator (relics + drills), or undefined when there are none. */
export function boostsOf(p: Player) {
  const d: Record<string, number> = { ...relicFx(p).dmg };
  for (const [k, v] of Object.entries(drillMap(p))) d[k] = (d[k] ?? 0) + v;
  return Object.keys(d).length ? d : undefined;
}
/** HP bonuses for the battle simulator (drills), or undefined when there are none. */
export function vigorOf(p: Player) {
  const v = drillMap(p);
  return Object.keys(v).length ? v : undefined;
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

// ── Formations ────────────────────────────────────────────────────────
const hashOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/**
 * The formation a warlord fights with right now. A hand-placed formation is clamped to the troops
 * they still own (casualties); a preset is re-applied to the current army. `override` comes from an
 * attack: a full formation, or a preset and/or order for this fight only.
 */
export function fieldFormation(p: Player, override: { formation?: unknown; preset?: unknown; order?: unknown; abilities?: unknown } = {}): Formation {
  const f = baseFormation(p, override);
  const abilities = loadoutOf(p, override.abilities);
  return abilities.length ? { ...f, abilities } : f;
}

function baseFormation(p: Player, override: { formation?: unknown; preset?: unknown; order?: unknown }): Formation {
  const order = typeof override.order === "string" && override.order in ORDERS ? override.order : null;
  if (override.formation) {
    try {
      const f = validFormation(override.formation, p.army);
      return order ? { ...f, order } : f;
    } catch (e) {
      throw new GameError((e as Error).message);
    }
  }
  const saved = p.formation;
  const preset = typeof override.preset === "string" && override.preset in PRESETS ? override.preset : null;
  if (saved?.manual && !preset) {
    const left: Record<string, number> = { ...p.army };
    const slots = saved.slots.map((s) => {
      if (!s) return null;
      const n = Math.min(s.n, left[s.unit] ?? 0);
      left[s.unit] = (left[s.unit] ?? 0) - n;
      return n > 0 ? { unit: s.unit, n } : null;
    });
    if (slots.some(Boolean)) return { slots, order: order ?? saved.order, preset: null };
  }
  // bots without a formation each favour a preset, so rivals fight differently
  const fallback = p.bot ? PRESET_KEYS[hashOf(p.id) % PRESET_KEYS.length] : "shieldwall";
  return autoFormation(p.army, preset ?? (saved && !saved.manual ? saved.preset : null) ?? fallback, order ?? (saved?.manual ? null : saved?.order) ?? null);
}

// ── Abilities (bought with Might) ─────────────────────────────────────
const abilityBook = (p: Player) => (p.abilities ??= { unlocked: [], loadout: [] });
const pickable = (p: Player, k: string) => (ABILITIES as any)[k] && abilityBook(p).unlocked.includes(k);

/** The abilities a warlord brings: an override for this fight, else the saved loadout (only unlocked ones). */
export function loadoutOf(p: Player, override?: unknown): string[] {
  if (p.bot && !p.abilities) return botLoadout(p);
  const list = Array.isArray(override) ? override.map(String) : abilityBook(p).loadout;
  return cleanLoadout(list.filter((k) => pickable(p, k)));
}

/** Rival warlords bring two abilities that suit their favourite formation. */
const BOT_LOADOUTS: Record<string, string[]> = { shieldwall: ["bulwark", "volley"], flanking: ["ambush", "rally"], ranged: ["volley", "pinning"], assault: ["firststrike", "revive"] };
function botLoadout(p: Player) {
  const preset = p.formation && !p.formation.manual ? p.formation.preset : PRESET_KEYS[hashOf(p.id) % PRESET_KEYS.length];
  return BOT_LOADOUTS[preset ?? "shieldwall"] ?? [];
}

/** Unlock an ability with Might. Repeating an unlock is a no-op, so retries never charge twice. */
export function unlockAbility(p: Player, id: string) {
  const a = (ABILITIES as any)[id];
  if (!a) throw new GameError("Unknown ability.");
  const book = abilityBook(p);
  if (book.unlocked.includes(id)) return { id, unlocked: book.unlocked, might: p.might ?? 0, already: true };
  const classOpen = unlockedUnits(p.buildings.barracks).some((u: string) => (UNIT_CLASS as any)[u] === a.cls);
  if (!classOpen) throw new GameError(`${a.name} needs a ${a.cls} unit. Upgrade your Barracks first.`);
  if ((p.might ?? 0) < a.cost) throw new GameError(`${a.name} costs ${a.cost} Might (you have ${p.might ?? 0}). Convert realized yield in the Treasury.`);
  p.might = (p.might ?? 0) - a.cost;
  book.unlocked.push(id);
  if (book.loadout.length < MAX_LOADOUT) book.loadout.push(id);
  if (book.unlocked.length >= 5) award(p, "master-at-arms");
  db.save();
  return { id, unlocked: book.unlocked, might: p.might };
}

/** Choose which unlocked abilities to bring into battle (at most MAX_LOADOUT). */
export function setLoadout(p: Player, list: unknown) {
  if (!Array.isArray(list)) throw new GameError("Send a list of abilities.");
  const want = [...new Set(list.map(String))];
  if (want.length > MAX_LOADOUT) throw new GameError(`Bring at most ${MAX_LOADOUT} abilities.`);
  for (const k of want) if (!pickable(p, k)) throw new GameError(`${(ABILITIES as any)[k]?.name ?? "That ability"} isn't unlocked.`);
  abilityBook(p).loadout = want;
  db.save();
  return abilityBook(p).loadout;
}

/**
 * Mastery (stat ranks bought with Might) became abilities. Refund every Might a player spent on
 * Mastery, once, and clear the ranks. Safe to run at every start.
 */
export function refundMastery() {
  let n = 0;
  for (const p of Object.values(db.data.players)) {
    const ranks = p.mastery;
    if (!ranks || !Object.keys(ranks).length) continue;
    let spent = 0;
    for (const r of Object.values(ranks)) for (let i = 1; i <= r; i++) spent += masteryCost(i);
    p.might = (p.might ?? 0) + spent;
    delete p.mastery;
    n++;
  }
  if (n) db.save();
  return n;
}

/** Save a formation: a preset (re-applied as the army changes) or a hand-placed one. */
export function setFormation(p: Player, body: any) {
  if (body?.preset && !body?.slots) {
    if (!(body.preset in PRESETS)) throw new GameError("Unknown formation.");
    const order = body.order in ORDERS ? body.order : (PRESETS as any)[body.preset].order;
    p.formation = { ...autoFormation(p.army, body.preset, order), manual: false };
  } else {
    try {
      p.formation = { ...validFormation(body, p.army), manual: true };
    } catch (e) {
      throw new GameError((e as Error).message);
    }
  }
  db.save();
  return fieldFormation(p);
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
    formation: (() => {
      const f = fieldFormation(p);
      const placed = formationArmy(f);
      const unplaced = Object.fromEntries(UNIT_KEYS.map((k) => [k, Math.max(0, (p.army[k] ?? 0) - (placed[k] ?? 0))]).filter(([, n]) => (n as number) > 0));
      return { ...f, manual: !!p.formation?.manual, unplaced };
    })(),
    might: p.might ?? 0,
    usdc: p.funds?.cash ?? 0, // micro-USDC
    abilities: { unlocked: p.abilities?.unlocked ?? [], loadout: loadoutOf(p), max: MAX_LOADOUT },
    drills: (() => {
      const d = drills(p);
      return { units: d.units, pool: d.pool, todayLeft: DRILLS.dailyCap - d.today, perPoint: DRILLS.perPoint, maxPerUnit: DRILLS.maxPerUnit, dailyCap: DRILLS.dailyCap };
    })(),
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
