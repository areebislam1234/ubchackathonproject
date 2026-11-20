// Test vectors for the on-chain battle engine. Plays random battles through the JavaScript engine
// (shared/battle2.js) and writes inputs and results in the Rust engine's input format, so
// `cargo test` in programs/battle proves both engines give identical results.
//   npx tsx scripts/battle-vectors.ts [count]
import fs from "node:fs";
import path from "node:path";
import { simulate2 } from "../shared/battle2.js";
import { ABILITY_KEYS, BOSS_KEYS, ORDER_KEYS, PRESET_KEYS, UNIT_KEYS, autoFormation, bossArmy } from "../shared/rules.js";

const COUNT = Number(process.argv[2] ?? 1000);
const OUT = path.join(import.meta.dirname, "..", "programs", "battle", "tests", "vectors.json");

/** Deterministic generator so the vectors only change when the engine does. */
let s = 12345;
const rand = (n: number) => ((s = (s * 1103515245 + 12345) >>> 0), s % n);
const chance = (p: number) => rand(1000) < p * 1000;

const NONE = 255;

/** A battle side in the JS engine's shape plus the same side in the Rust engine's shape. */
function side(opts: { boss?: string } = {}) {
  let units: Record<string, number>;
  let levels: Record<string, number>;
  let towers = 0;
  let champions: any[] = [];
  if (opts.boss) {
    const b = bossArmy(opts.boss) as any;
    units = b.units;
    levels = b.levels;
    towers = b.towers;
    champions = b.champions;
  } else {
    units = {};
    for (const k of UNIT_KEYS) if (chance(0.7)) units[k] = 1 + rand(12);
    if (!Object.keys(units).length) units.infantry = 3;
    levels = Object.fromEntries(UNIT_KEYS.map((k) => [k, 1 + rand(5)]));
    if (chance(0.25)) towers = 1 + rand(4);
  }
  const formation: any = autoFormation(units, PRESET_KEYS[rand(PRESET_KEYS.length)], ORDER_KEYS[rand(ORDER_KEYS.length)]);
  // sometimes shuffle by hand, like a player placing troops
  if (chance(0.3)) for (let i = 8; i > 0; i--) { const j = rand(i + 1); [formation.slots[i], formation.slots[j]] = [formation.slots[j], formation.slots[i]]; }
  const abilities: string[] = [];
  const nAb = rand(4); // 0..3 (a third ability must be ignored)
  for (let i = 0; i < nAb; i++) abilities.push(ABILITY_KEYS[rand(ABILITY_KEYS.length)]);
  formation.abilities = abilities;
  const boosts: Record<string, number> = {};
  const vigor: Record<string, number> = {};
  if (chance(0.4)) for (const k of UNIT_KEYS) if (chance(0.4)) boosts[k] = rand(16) / 100;
  if (chance(0.3)) vigor.all = rand(10) / 100;
  if (chance(0.3)) for (const k of UNIT_KEYS) if (chance(0.3)) vigor[k] = rand(16) / 200;
  const js = { formation, levels, boosts, vigor, towers, champions };
  const bps = (m: Record<string, number>) => [...UNIT_KEYS.map((k) => Math.round((m[k] ?? 0) * 10000)), Math.round((m.all ?? 0) * 10000)];
  const ab = abilities.map((k) => ABILITY_KEYS.indexOf(k));
  const rust = {
    slots: formation.slots.map((x: any) => (x ? [UNIT_KEYS.indexOf(x.unit), x.n] : [0, 0])),
    order: ORDER_KEYS.indexOf(formation.order),
    // the engine reads only the first two entries (cleanLoadout keeps the first two distinct ones)
    abilities: firstTwoDistinct(ab),
    levels: UNIT_KEYS.map((k) => levels[k] ?? 1),
    boosts: bps(boosts),
    vigor: bps(vigor),
    towers,
    champion: champions[0] ? { hp: champions[0].hp, atk: Math.floor((champions[0].dmg * 60) / Math.max(1, champions[0].cooldown)), splash: champions[0].splash > 0 } : null,
  };
  return { js, rust };
}
function firstTwoDistinct(ab: number[]) {
  const out: number[] = [];
  for (const a of ab) if (!out.includes(a) && out.length < 2) out.push(a);
  while (out.length < 2) out.push(NONE);
  return out;
}

const vectors = [];
for (let i = 0; i < COUNT; i++) {
  const atk = side();
  const def = chance(0.15) ? side({ boss: BOSS_KEYS[rand(BOSS_KEYS.length)] }) : side();
  const seed = rand(2 ** 31) * 2 + rand(2);
  const r: any = simulate2({ attacker: atk.js, defender: def.js, seed });
  vectors.push({
    seed,
    attacker: atk.rust,
    defender: def.rust,
    expect: {
      attacker_won: r.winner === "attacker",
      ticks: r.ticks,
      destruction_pm: Math.round(r.destruction * 10),
      survival_pm: Math.round(r.survival * 10),
      score: r.score,
      lost: UNIT_KEYS.map((k) => r.lost[k] ?? 0),
    },
  });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(vectors));
const won = vectors.filter((v) => v.expect.attacker_won).length;
console.log(`wrote ${vectors.length} battles to ${path.relative(process.cwd(), OUT)} (attacker won ${won}, bosses ${vectors.filter((v) => v.defender.champion).length})`);
