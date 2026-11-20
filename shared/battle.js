// Deterministic auto-battle. The server runs it to score attacks; the browser re-runs it with
// the same seed and armies to animate the replay, so what you watch is exactly what scored.
// Only + - * / and sqrt are used, so results match across JS engines.
import { mulberry32 } from "./rng.js";
import { COUNTERS, TOWER, UNITS, unitMult } from "./rules.js";

export const FIELD_W = 160;
export const FIELD_H = 72;
export const TICKS_PER_SEC = 10;
export const MAX_TICKS = 600;
const TILE_U = 4; // field units per "tile" of range
const BASE_SPEED = 0.8; // field units per tick at speed 1
const ORDER = ["tank", "infantry", "cavalry", "archer", "siege"];
const COLUMN_X = { tank: 46, infantry: 38, cavalry: 30, archer: 22, siege: 12 };

function spawn(team, army, levels, towers, rnd, boosts) {
  const out = [];
  for (const type of ORDER) {
    const n = Math.max(0, Math.floor(army?.[type] ?? 0));
    const perCol = 9;
    for (let k = 0; k < n; k++) {
      const col = Math.floor(k / perCol);
      const row = k % perCol;
      const rowsInCol = Math.min(perCol, n - col * perCol);
      const y = FIELD_H / 2 + (row - (rowsInCol - 1) / 2) * 7 + (rnd() - 0.5) * 1.5;
      let x = COLUMN_X[type] - col * 5 + (rnd() - 0.5) * 1.5;
      if (team === 1) x = FIELD_W - x;
      const u = UNITS[type];
      const m = unitMult(levels?.[type] ?? 1);
      const boost = 1 + (boosts?.[type] ?? 0) + (boosts?.all ?? 0); // relic damage bonuses
      out.push({ team, type, x, y, hp: u.hp * m, maxHp: u.hp * m, dmg: u.dmg * m * boost, range: u.range * TILE_U, speed: u.speed * BASE_SPEED, cooldown: u.cooldown, cd: Math.floor(rnd() * 6), splash: (u.splash ?? 0) * TILE_U, target: -1, retarget: 0 });
    }
  }
  if (team === 1)
    for (let k = 0; k < (towers ?? 0); k++) {
      const y = FIELD_H / 2 + (k - ((towers ?? 0) - 1) / 2) * 16;
      out.push({ team, type: "tower", x: FIELD_W - 6, y, hp: TOWER.hp, maxHp: TOWER.hp, dmg: TOWER.dmg, range: TOWER.range * TILE_U, speed: 0, cooldown: TOWER.cooldown, cd: k * 3, splash: 0, target: -1, retarget: 0, static: true });
    }
  return out;
}

/** Boss champions: one huge unit each, standing behind the defender's front line. Spawned last so
 *  fights without a champion use exactly the same random sequence as before. */
function spawnChampions(champions, rnd) {
  const out = [];
  const n = champions?.length ?? 0;
  for (let k = 0; k < n; k++) {
    const c = champions[k];
    const y = FIELD_H / 2 + (k - (n - 1) / 2) * 18;
    out.push({ team: 1, type: "boss", look: c.look, x: FIELD_W - 34, y, hp: c.hp, maxHp: c.hp, dmg: c.dmg, range: c.range * TILE_U, speed: c.speed * BASE_SPEED, cooldown: c.cooldown, cd: Math.floor(rnd() * 6), splash: (c.splash ?? 0) * TILE_U, target: -1, retarget: 0 });
  }
  return out;
}

/**
 * Run a battle.
 * attacker / defender: { units: {infantry: n, ...}, levels: {infantry: lvl, ...}, towers?, champions?, boosts? }
 * With record: true, also returns per-tick frames and events for the replay.
 */
export function simulate({ attacker, defender, seed, record = false }) {
  const rnd = mulberry32(seed >>> 0);
  const units = [...spawn(0, attacker.units, attacker.levels, 0, rnd, attacker.boosts), ...spawn(1, defender.units, defender.levels, defender.towers ?? 0, rnd, defender.boosts), ...spawnChampions(defender.champions, rnd)];
  units.forEach((u, i) => (u.id = i));
  const startHp = [0, 0];
  for (const u of units) startHp[u.team] += u.maxHp;
  const projectiles = [];
  const frames = [];
  const events = [];
  let tick = 0;
  const alive = (team) => units.some((u) => u.team === team && u.hp > 0);
  const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
  const hit = (src, target, dmg) => {
    if (target.hp <= 0) return;
    const mult = COUNTERS[src.type]?.[target.type] ?? 1;
    target.hp -= dmg * mult * (0.85 + rnd() * 0.3);
    if (target.hp <= 0) {
      target.hp = 0;
      if (record) events.push({ t: tick, k: "die", id: target.id });
    }
  };
  const pickTarget = (u) => {
    let best = -1;
    let bd = Infinity;
    let bestPref = -1;
    let bdPref = Infinity;
    for (const v of units) {
      if (v.team === u.team || v.hp <= 0) continue;
      const d = dist2(u, v);
      if (d < bd) {
        bd = d;
        best = v.id;
      }
      const pref = (u.type === "cavalry" && (v.type === "archer" || v.type === "siege")) || (u.type === "siege" && (v.type === "tank" || v.type === "tower" || v.type === "boss"));
      if (pref && d < bdPref && d < 70 * 70) {
        bdPref = d;
        bestPref = v.id;
      }
    }
    return bestPref >= 0 ? bestPref : best;
  };

  while (tick < MAX_TICKS && alive(0) && alive(1)) {
    for (const u of units) {
      if (u.hp <= 0) continue;
      if (u.target < 0 || units[u.target].hp <= 0 || u.retarget <= 0) {
        u.target = pickTarget(u);
        u.retarget = 5;
      }
      u.retarget--;
      if (u.cd > 0) u.cd--;
      if (u.target < 0) continue;
      const t = units[u.target];
      const d = Math.sqrt(dist2(u, t));
      if (d > u.range) {
        if (!u.static) {
          const step = Math.min(u.speed, d - u.range * 0.9);
          u.x += ((t.x - u.x) / d) * step;
          u.y += ((t.y - u.y) / d) * step;
        }
      } else if (u.cd <= 0) {
        u.cd = u.cooldown + Math.floor(rnd() * 3);
        if (u.range > 2 * TILE_U) {
          const eta = Math.max(2, Math.ceil(d / 5));
          projectiles.push({ src: u.id, target: t.id, at: tick + eta, x: t.x, y: t.y, splash: u.splash });
          if (record) events.push({ t: tick, k: "shoot", id: u.id, target: t.id, eta, type: u.type });
        } else {
          hit(u, t, u.dmg);
          if (record) events.push({ t: tick, k: "swing", id: u.id });
        }
      }
    }
    // separation so armies don't stack into one pixel
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (a.hp <= 0 || a.static) continue;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j];
        if (b.hp <= 0 || b.team !== a.team || b.static) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0 && d2 < 36) {
          const d = Math.sqrt(d2);
          const push = (6 - d) * 0.2;
          a.x += (dx / d) * push;
          a.y += (dy / d) * push;
          b.x -= (dx / d) * push;
          b.y -= (dy / d) * push;
        }
      }
      a.x = Math.max(2, Math.min(FIELD_W - 2, a.x));
      a.y = Math.max(4, Math.min(FIELD_H - 2, a.y));
    }
    // land projectiles
    for (let p = projectiles.length - 1; p >= 0; p--) {
      const pr = projectiles[p];
      if (pr.at > tick) continue;
      projectiles.splice(p, 1);
      const src = units[pr.src];
      const t = units[pr.target];
      if (pr.splash > 0) {
        for (const v of units) if (v.team !== src.team && v.hp > 0 && (v.x - pr.x) * (v.x - pr.x) + (v.y - pr.y) * (v.y - pr.y) <= pr.splash * pr.splash) hit(src, v, src.dmg);
        if (record) events.push({ t: tick, k: "boom", x: pr.x, y: pr.y });
      } else if (t.hp > 0) hit(src, t, src.dmg);
    }
    if (record) {
      const f = new Float32Array(units.length * 3);
      units.forEach((u, i) => {
        f[i * 3] = u.x;
        f[i * 3 + 1] = u.y;
        f[i * 3 + 2] = u.hp / u.maxHp;
      });
      frames.push(f);
    }
    tick++;
  }

  const endHp = [0, 0];
  for (const u of units) endHp[u.team] += Math.max(0, u.hp);
  const attackerWon = !alive(1);
  const lost = {};
  for (const u of units) if (u.team === 0 && u.hp <= 0) lost[u.type] = (lost[u.type] ?? 0) + 1;
  const destruction = startHp[1] > 0 ? 1 - endHp[1] / startHp[1] : 1;
  const survival = startHp[0] > 0 ? endHp[0] / startHp[0] : 0;
  const score = Math.round(destruction * 1000) + (attackerWon ? 300 : 0) + Math.round(survival * 200);
  const result = {
    winner: attackerWon ? "attacker" : "defender",
    ticks: tick,
    destruction: Math.round(destruction * 1000) / 10,
    survival: Math.round(survival * 1000) / 10,
    score,
    lost,
  };
  if (record) return { ...result, frames, events, roster: units.map((u) => (u.look ? { team: u.team, type: u.type, look: u.look } : { team: u.team, type: u.type })) };
  return result;
}

/** Rough strength of an army, for matchmaking hints. */
export function armyPower(army, levels = {}, towers = 0, champions = []) {
  let p = towers * (TOWER.hp * 0.02 + TOWER.dmg);
  for (const c of champions ?? []) p += c.hp * 0.02 + (c.dmg * 10) / c.cooldown;
  for (const [k, n] of Object.entries(army ?? {})) {
    const u = UNITS[k];
    if (!u) continue;
    p += n * (u.hp * 0.02 + u.dmg) * unitMult(levels[k] ?? 1);
  }
  return Math.round(p);
}
