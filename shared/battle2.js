// Strategic combat, engine 2: two 3x3 formations of unit stacks fight in rounds.
//
// Integer arithmetic only (no floats, no Math.random): the same rules are ported line for line to
// the Solana program, and both must produce identical results for the same inputs and seed. The
// browser re-runs this to animate a battle, so what you watch is exactly what scored.
//
// Slot index i = row * 3 + lane. Row 0 is the frontline, row 2 the backline; lanes are left,
// centre, right. Index 9 is the defender's watchtowers, 10 a boss champion.
import { CLASS_COUNTERS, COMBAT, COMBAT_STATS, ORDERS, UNITS, UNIT_CLASS, autoFormation } from "./rules.js";

const B = 10000;
const mul = (v, bps) => Math.floor((v * bps) / B);
const RANK = { raider: 0, ranger: 1, artillery: 2, boss: 2, guardian: 3, tower: 3, support: 4 };
const VALUE = { artillery: 3, ranger: 2, support: 2, raider: 1, guardian: 1, tower: 1, boss: 1 };

/** xorshift32: the same sequence in JS and Rust (all u32 arithmetic). */
function rng(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

const levelBps = (lvl) => B + 1200 * (Math.max(1, Math.floor(lvl ?? 1)) - 1);
const fracBps = (f) => Math.round((f ?? 0) * B); // boosts/vigor arrive as fractions (0.05 = +5%)

function makeSide(team, spec) {
  const f = spec.formation?.slots ? spec.formation : autoFormation(spec.units ?? {}, spec.preset ?? "shieldwall", spec.order ?? null);
  const order = ORDERS[spec.formation?.order ?? f.order] ? (spec.formation?.order ?? f.order) : "hold";
  const slots = [];
  f.slots.forEach((s, i) => {
    if (!s || !UNITS[s.unit] || !(s.n > 0)) return;
    const st = COMBAT_STATS[s.unit];
    const lv = levelBps(spec.levels?.[s.unit]);
    const hpBps = mul(lv, B + fracBps(spec.vigor?.[s.unit]) + fracBps(spec.vigor?.all));
    const dmgBps = mul(lv, B + fracBps(spec.boosts?.[s.unit]) + fracBps(spec.boosts?.all));
    const unitHp = Math.max(1, mul(st.hp, hpBps));
    const n = Math.floor(s.n);
    slots.push({ team, idx: i, row: Math.floor(i / 3), lane: i % 3, unit: s.unit, cls: UNIT_CLASS[s.unit], n0: n, unitHp, hpMax: unitHp * n, hp: unitHp * n, atk: mul(st.atk, dmgBps), heal: st.heal ? mul(st.heal, lv) : 0, intercept: st.intercept ?? 0, splash: st.splash ?? 0 });
  });
  if (spec.towers > 0) {
    const t = COMBAT_STATS.tower;
    slots.push({ team, idx: 9, row: 2, lane: 1, unit: "tower", cls: "tower", n0: spec.towers, unitHp: t.hp, hpMax: t.hp * spec.towers, hp: t.hp * spec.towers, atk: t.atk, heal: 0, intercept: 0, splash: 0 });
  }
  for (const c of spec.champions ?? []) {
    // a boss: one huge unit standing mid-centre, behind its escort
    const atk = Math.floor((c.dmg * 60) / Math.max(1, c.cooldown));
    slots.push({ team, idx: 10, row: 1, lane: 1, unit: "boss", look: c.look, cls: "boss", n0: 1, unitHp: c.hp, hpMax: c.hp, hp: c.hp, atk, heal: 0, intercept: 0, splash: c.splash > 0 ? 5000 : 0 });
  }
  return { team, order, slots, formation: { slots: f.slots, order } };
}

const count = (s) => (s.hp <= 0 ? 0 : Math.floor((s.hp + s.unitHp - 1) / s.unitHp));
const alive = (side) => side.slots.filter((s) => s.hp > 0);
const laneDist = (a, b) => Math.abs(a.lane - b.lane);

function exposed(side, s) {
  if (s.row === 0) return false;
  return !side.slots.some((o) => o.hp > 0 && o.row === 0 && o.lane === s.lane);
}

function pick(list, better) {
  let best = null;
  for (const s of list) if (!best || better(s, best)) best = s;
  return best;
}

/** Who a slot attacks, by its class and its side's order. */
function chooseTarget(a, order, enemy) {
  const list = alive(enemy);
  if (!list.length) return null;
  const near = (x, y) => laneDist(x, a) - laneDist(y, a) || x.idx - y.idx;
  if (order === "focus") return pick(list, (x, y) => x.hp < y.hp || (x.hp === y.hp && x.idx < y.idx));
  if (a.cls === "raider") {
    const exp = list.filter((s) => s.row > 0 && exposed(enemy, s));
    const pool = exp.length ? exp : list.filter((s) => s.row > 0);
    if (pool.length) return pick(pool, (x, y) => VALUE[x.cls] > VALUE[y.cls] || (VALUE[x.cls] === VALUE[y.cls] && near(x, y) < 0));
    return pick(list, (x, y) => near(x, y) < 0);
  }
  if (a.cls === "ranger") {
    const exp = list.filter((s) => s.row > 0 && exposed(enemy, s));
    if (exp.length) return pick(exp, (x, y) => VALUE[x.cls] > VALUE[y.cls] || (VALUE[x.cls] === VALUE[y.cls] && near(x, y) < 0));
    const g = list.filter((s) => s.cls === "guardian");
    if (g.length) return pick(g, (x, y) => x.hp < y.hp || (x.hp === y.hp && x.idx < y.idx));
    return pick(list, (x, y) => x.row - y.row || near(x, y) < 0);
  }
  if (a.cls === "artillery" || a.cls === "boss") return pick(list, (x, y) => count(x) > count(y) || (count(x) === count(y) && (x.row < y.row || (x.row === y.row && x.idx < y.idx))));
  // Guardians engage enemy Raiders first (that is how they counter them), then the nearest enemy
  if (a.cls === "guardian") {
    const r = list.filter((s) => s.cls === "raider");
    if (r.length) return pick(r, (x, y) => near(x, y) < 0);
  }
  return pick(list, (x, y) => x.row < y.row || (x.row === y.row && near(x, y) < 0));
}

function newStats() {
  return { dealt: 0, matrix: {}, counterExtra: 0, intercepted: 0, healed: 0, exposedTaken: 0, orderExtra: 0, orderTakenExtra: 0, preventedByOrder: 0, auraPrevented: 0, splashHits: 0, wiped: {}, firstLoss: null };
}

/**
 * Run a battle.
 * attacker / defender: { formation?: { slots, order }, units?, preset?, order?, levels?, boosts?, vigor?, towers?, champions? }
 * Without a formation the army is auto-placed with the given preset (Shield Wall by default).
 */
export function simulate2({ attacker, defender, seed, record = false }) {
  const next = rng(seed);
  const sides = [makeSide(0, attacker), makeSide(1, defender)];
  const stats = [newStats(), newStats()];
  const events = [];
  const start = sides.map((s) => s.slots.reduce((t, x) => t + x.hpMax, 0));
  const snapshot = sides.map((s) => s.slots.map((x) => ({ idx: x.idx, unit: x.unit, look: x.look, cls: x.cls, n: x.n0, hpMax: x.hpMax })));
  let round = 0;

  const hit = (src, dst, amount, kind) => {
    const dealt = Math.min(dst.hp, Math.max(0, amount));
    const before = count(dst);
    dst.hp -= dealt;
    const st = stats[src.team];
    st.dealt += dealt;
    const key = `${src.cls}>${dst.cls}`;
    st.matrix[key] = (st.matrix[key] ?? 0) + dealt;
    const loss = before - count(dst);
    const dstStats = stats[dst.team];
    if (loss > 0 && !dstStats.firstLoss && dst.cls !== "tower") dstStats.firstLoss = { unit: dst.unit, round };
    if (dst.hp <= 0) dstStats.wiped[dst.unit] = dstStats.wiped[dst.unit] ?? round;
    if (record) events.push({ r: round, k: kind, t: src.team, from: src.idx, to: dst.idx, amount: dealt, kill: dst.hp <= 0 });
    return dealt;
  };

  for (round = 1; round <= COMBAT.rounds; round++) {
    if (!alive(sides[0]).length || !alive(sides[1]).length) break;
    const order = [...alive(sides[0]), ...alive(sides[1])];
    const rankOf = (s) => (s.cls === "ranger" && sides[s.team].order === "hold" ? -1 : RANK[s.cls]);
    order.sort((x, y) => rankOf(x) - rankOf(y) || ((x.team + round) % 2) - ((y.team + round) % 2) || x.idx - y.idx);
    for (const a of order) {
      if (a.hp <= 0) continue;
      const mine = sides[a.team];
      // Hold Position: the line doesn't advance in the first round
      if (round === 1 && mine.order === "hold" && (a.cls === "raider" || a.cls === "guardian")) continue;
      const enemy = sides[1 - a.team];
      const n = count(a);
      if (a.cls === "support") {
        const hurt = pick(
          mine.slots.filter((s) => s.hp > 0 && s.hp < s.hpMax && laneDist(s, a) <= 1),
          (x, y) => x.hpMax - x.hp > y.hpMax - y.hp || (x.hpMax - x.hp === y.hpMax - y.hp && x.idx < y.idx),
        );
        if (hurt) {
          const h = Math.min(hurt.hpMax - hurt.hp, n * a.heal);
          hurt.hp += h;
          stats[a.team].healed += h;
          if (record) events.push({ r: round, k: "heal", t: a.team, from: a.idx, to: hurt.idx, amount: h, kill: false });
          continue;
        }
      }
      const tgt = chooseTarget(a, mine.order, enemy);
      if (!tgt) break;
      let d = n * a.atk;
      // class counters
      const counter = tgt.cls === "boss" && (a.unit === "siege" || a.unit === "tank") ? COMBAT.bossCounterBps : (CLASS_COUNTERS[a.cls]?.[tgt.cls] ?? B);
      d = mul(d, counter);
      // the attacker's bonuses
      const isExposed = exposed(enemy, tgt);
      let atkBonus = 0;
      let orderBonus = 0;
      if (a.cls === "artillery") atkBonus += Math.min(COMBAT.clusterMaxBps, COMBAT.clusterBpsPer10 * Math.floor(count(tgt) / 10));
      const o = ORDERS[mine.order];
      if (o.dmg) orderBonus += o.dmg;
      if (mine.order === "flank") orderBonus += a.cls === "raider" ? (isExposed ? o.flankBps : 0) : o.othersBps;
      if (mine.order === "focus") orderBonus += o.focusBps;
      d = mul(d, B + atkBonus + orderBonus);
      d = mul(d, COMBAT.roll[0] + (next() % (COMBAT.roll[1] - COMBAT.roll[0] + 1)));
      // the target's situation
      const expBonus = isExposed ? COMBAT.exposedBps + (a.cls === "ranger" ? COMBAT.rangerExposedBps : 0) : 0;
      d = mul(d, B + expBonus);
      const eo = ORDERS[enemy.order];
      const aura = enemy.slots.some((s) => s.hp > 0 && s.cls === "support" && laneDist(s, tgt) <= 1) ? COMBAT.auraBps : 0;
      const takenBps = Math.max(1000, B + (eo.taken ?? 0) - aura);
      const beforeTaken = d;
      d = mul(d, takenBps);
      // what each factor added, for the combat report (estimates from the final number)
      const st = stats[a.team];
      if (counter > B) st.counterExtra += d - mul(d, Math.floor((B * B) / counter));
      if (orderBonus > 0) st.orderExtra += d - Math.floor((d * B) / (B + orderBonus));
      if (expBonus) stats[tgt.team].exposedTaken += d - Math.floor((d * B) / (B + expBonus));
      if ((eo.taken ?? 0) > 0) stats[tgt.team].orderTakenExtra += d - mul(beforeTaken, B - aura);
      if ((eo.taken ?? 0) < 0) stats[tgt.team].preventedByOrder += mul(beforeTaken, B - aura) - d;
      if (aura) stats[tgt.team].auraPrevented += mul(beforeTaken, aura);
      // Guardians in front, in the same lane, take part of the blow
      // (Raiders striking from a wing lane slip past the Guardians: that is how they penetrate a formation)
      const penetrates = a.cls === "raider" && a.lane !== 1;
      if (tgt.row > 0 && tgt.cls !== "guardian") {
        const guard = pick(
          enemy.slots.filter((s) => s.hp > 0 && s.cls === "guardian" && s.lane === tgt.lane && s.row < tgt.row),
          (x, y) => x.intercept > y.intercept || (x.intercept === y.intercept && x.row < y.row),
        );
        if (guard) {
          let share = guard.intercept + (enemy.order === "hold" ? ORDERS.hold.interceptBps : 0);
          if (penetrates) share = Math.floor(share / 2);
          const part = mul(d, share);
          // the Guardian takes its share as a hit on itself: its own counter, no exposed bonus
          const counterVsGuard = CLASS_COUNTERS[a.cls]?.guardian ?? B;
          let guardPart = Math.floor((part * counterVsGuard) / counter);
          if (expBonus) guardPart = Math.floor((guardPart * B) / (B + expBonus));
          const taken = hit(a, guard, guardPart, "intercept");
          stats[tgt.team].intercepted += part;
          void taken;
          d -= part;
        }
      }
      hit(a, tgt, d, "hit");
      if (a.splash) {
        const sd = mul(d, a.splash);
        for (const s of enemy.slots) if (s.hp > 0 && s !== tgt && s.row === tgt.row && laneDist(s, tgt) === 1 && s.idx < 9) (hit(a, s, sd, "splash"), (st.splashHits += 1));
      }
      if (!alive(enemy).length) break;
    }
  }

  const end = sides.map((s) => s.slots.reduce((t, x) => t + Math.max(0, x.hp), 0));
  const attackerWon = !alive(sides[1]).length;
  const destructionPm = start[1] > 0 ? 1000 - Math.floor((end[1] * 1000) / start[1]) : 1000;
  const survivalPm = start[0] > 0 ? Math.floor((end[0] * 1000) / start[0]) : 0;
  const lost = {};
  for (const s of sides[0].slots) {
    const l = s.n0 - count(s);
    if (l > 0 && s.unit !== "boss") lost[s.unit] = (lost[s.unit] ?? 0) + l;
  }
  const survivors = sides.map((side) => side.slots.reduce((m, s) => (count(s) > 0 && s.idx < 9 ? ((m[s.unit] = (m[s.unit] ?? 0) + count(s)), m) : m), {}));
  const result = {
    engine: 2,
    winner: attackerWon ? "attacker" : "defender",
    ticks: Math.min(round, COMBAT.rounds),
    destruction: destructionPm / 10,
    survival: survivalPm / 10,
    score: destructionPm + (attackerWon ? 300 : 0) + Math.floor(survivalPm / 5),
    lost,
    orders: [sides[0].order, sides[1].order],
  };
  result.report = explainBattle(result, sides, stats, survivors);
  if (record) return { ...result, events, slots: snapshot, formations: sides.map((s) => s.formation) };
  return result;
}

const CLASS_NAME = { guardian: "Guardians", raider: "Raiders", ranger: "Rangers", artillery: "Artillery", support: "Support", tower: "Watchtowers", boss: "the boss" };
const fmtN = (n) => Math.round(n).toLocaleString("en-US");

/**
 * Why the battle went the way it did: the factors that moved the most damage, ranked, written from
 * the attacker's point of view ("you" = attacker). Each factor says which side it helped.
 */
export function explainBattle(result, sides, stats, survivors) {
  const f = [];
  const who = (t) => (t === 0 ? "Your" : "Their");
  const add = (team, impact, text) => impact > 0 && f.push({ helped: team === 0 ? "attacker" : "defender", impact: Math.round(impact), text });
  for (const t of [0, 1]) {
    const s = stats[t];
    add(t, s.intercepted, `${who(t)} Guardians absorbed ${fmtN(s.intercepted)} damage aimed at the troops behind them.`);
    add(t, s.healed, `${who(t)} Support healed ${fmtN(s.healed)} damage.`);
    add(t, s.auraPrevented, `${who(t)} Support aura blocked about ${fmtN(s.auraPrevented)} damage.`);
    add(1 - t, s.exposedTaken, `${who(t)} exposed backline took ${fmtN(s.exposedTaken)} extra damage once a lane's frontline fell.`);
    add(t, s.preventedByOrder, `${who(t)} Defensive order blocked about ${fmtN(s.preventedByOrder)} damage.`);
    add(1 - t, s.orderTakenExtra, `${who(t)} Aggressive order left ${t === 0 ? "you" : "them"} open: ${fmtN(s.orderTakenExtra)} extra damage taken.`);
    if (s.orderExtra > 0) add(t, s.orderExtra, `${who(t)} ${ORDERS[sides[t].order].name} order added ${fmtN(s.orderExtra)} damage.`);
    if (s.counterExtra > 0) {
      const best = Object.entries(s.matrix)
        .filter(([k]) => {
          const [a, d] = k.split(">");
          return (CLASS_COUNTERS[a]?.[d] ?? 10000) > 10000;
        })
        .sort((a, b) => b[1] - a[1])[0];
      const pair = best ? best[0].split(">") : null;
      add(t, s.counterExtra, `${who(t)} counters added ${fmtN(s.counterExtra)} damage${pair ? ` (mostly ${CLASS_NAME[pair[0]]} into ${CLASS_NAME[pair[1]]})` : ""}.`);
    }
    const dive = (s.matrix["raider>ranger"] ?? 0) + (s.matrix["raider>artillery"] ?? 0) + (s.matrix["raider>support"] ?? 0);
    add(t, dive * 0.5, `${who(t)} Raiders reached the backline and dealt ${fmtN(dive)} damage to Rangers, Artillery and Support.`);
    if (s.splashHits >= 3) add(t, (s.matrix["artillery>guardian"] ?? 0) * 0.3, `${who(t)} Artillery splash hit ${s.splashHits} extra stacks in clustered rows.`);
  }
  f.sort((a, b) => b.impact - a.impact);
  const lostTxt = (t) =>
    Object.entries(stats[t].wiped)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 2)
      .map(([u, r]) => `${UNITS[u]?.name ?? (u === "tower" ? "Watchtowers" : u)} wiped out in round ${r}`);
  return {
    headline: result.winner === "attacker" ? "Victory" : "Defeat",
    factors: f.slice(0, 5),
    orders: sides.map((s) => ORDERS[s.order].name),
    yourLosses: lostTxt(0),
    theirLosses: lostTxt(1),
    rounds: result.ticks,
    survivors,
  };
}
