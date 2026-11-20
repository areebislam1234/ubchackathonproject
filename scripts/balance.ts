// Balance check for strategic combat (engine 2). Armies of equal size (36 housing, level 3) play each
// other from both sides over many seeds. Checks the design goals:
//   1. no army type wins too much overall, and every army type has one it beats and one it loses to
//   2. the best formation depends on the army (no single dominant preset)
//   3. formation and order choices move results for the same army
//   4. every ability helps somewhere (+10 points), and no pair of abilities dominates the field
//   npx tsx scripts/balance.ts          (SEEDS=30 for a slower, finer run)
import { simulate2 } from "../shared/battle2.js";
import { ABILITIES, ABILITY_KEYS, ORDER_KEYS, PRESETS, PRESET_KEYS, UNIT_KEYS, autoFormation, bossArmy } from "../shared/rules.js";

const SEEDS = Number(process.env.SEEDS ?? 12);
const LEVEL = Object.fromEntries(UNIT_KEYS.map((k) => [k, 3]));
/** Test armies; each fills 36 housing (a level-5 Barracks). */
export const COMPS: Record<string, Record<string, number>> = {
  balanced: { infantry: 6, tank: 3, archer: 6, cavalry: 3, siege: 1, support: 2 },
  guardians: { infantry: 6, tank: 6, archer: 6, support: 3 },
  raiders: { infantry: 6, cavalry: 9, archer: 6, support: 3 },
  ranged: { infantry: 6, archer: 14, siege: 3, support: 2 },
  siege: { infantry: 4, tank: 2, archer: 6, siege: 5 },
};

type Side = { comp: string; preset: string; order?: string; abilities?: string[]; towers?: number };
const spec = (s: Side) => ({ formation: autoFormation(COMPS[s.comp], s.preset, s.order ?? null), levels: LEVEL, abilities: s.abilities ?? [], towers: s.towers ?? 0 });

/** Share of games X wins against Y, playing both as attacker and as defender. */
export function winShare(x: Side, y: Side, seeds = SEEDS) {
  let w = 0;
  for (let i = 1; i <= seeds; i++) {
    if (simulate2({ attacker: spec(x), defender: spec(y), seed: i * 7919 }).winner === "attacker") w++;
    if (simulate2({ attacker: spec(y), defender: spec(x), seed: i * 104729 }).winner === "defender") w++;
  }
  return w / (2 * seeds);
}

/** Share of fights X wins against a legendary boss (the Grand Champion and its escort). */
function bossShare(x: Side, seeds = SEEDS) {
  const army = bossArmy("grand-champion");
  const boss = { ...army, formation: autoFormation(army.units, "assault") };
  let w = 0;
  for (let i = 1; i <= seeds * 2; i++) if (simulate2({ attacker: spec(x), defender: boss, seed: i * 7919 }).winner === "attacker") w++;
  return w / (2 * seeds);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

function main() {
  let ok = true;
  const fail = (msg: string) => ((ok = false), console.log(`   ✘ ${msg}`));
  const comps = Object.keys(COMPS);

  // 2. formations: for each army, every preset against every preset (same army on both sides)
  const best: Record<string, string> = {};
  console.log("Formations: same army on both sides, row preset's win share");
  for (const c of comps) {
    console.log(`\n  ${c}`.padEnd(14) + PRESET_KEYS.map((p) => p.padStart(11)).join("") + "    average");
    let bestAvg = -1;
    let worstAvg = 2;
    for (const a of PRESET_KEYS) {
      const row = PRESET_KEYS.map((b) => (a === b ? 0.5 : winShare({ comp: c, preset: a }, { comp: c, preset: b })));
      const avg = mean(row.filter((_, i) => PRESET_KEYS[i] !== a));
      if (avg > bestAvg) (bestAvg = avg), (best[c] = a);
      worstAvg = Math.min(worstAvg, avg);
      console.log(`  ${a}`.padEnd(14) + row.map((v) => pct(v).padStart(11)).join("") + pct(avg).padStart(11));
    }
    if (bestAvg - worstAvg < 0.3) fail(`for the ${c} army the formation barely matters (${pct(bestAvg - worstAvg)} spread)`);
  }
  const bests = new Set(Object.values(best));
  console.log(`\n  best formation per army: ${comps.map((c) => `${c} → ${best[c]}`).join(", ")}`);
  if (bests.size < 2) fail("one formation is best for every army");

  // 1. armies against armies, each on its best formation
  console.log("\nArmies: each on its best formation, row army's win share");
  console.log("".padEnd(12) + comps.map((k) => k.padStart(11)).join("") + "    average");
  for (const a of comps) {
    const row = comps.map((b) => (a === b ? 0.5 : winShare({ comp: a, preset: best[a] }, { comp: b, preset: best[b] })));
    const others = row.filter((_, i) => comps[i] !== a);
    console.log(a.padEnd(12) + row.map((v) => pct(v).padStart(11)).join("") + pct(mean(others)).padStart(11));
    if (mean(others) > 0.72) fail(`the ${a} army is too strong overall`);
    if (Math.max(...others) <= 0.6) fail(`the ${a} army has no army it beats`);
    if (Math.min(...others) >= 0.4) fail(`the ${a} army has no counter`);
  }

  // 3. orders: the same army and formation, each order, against a fixed opponent
  console.log("\nOrders: balanced army, each preset and order, vs a balanced army on its best formation");
  const ref: Side = { comp: "balanced", preset: best.balanced };
  const rates: number[] = [];
  for (const preset of PRESET_KEYS) {
    const row = ORDER_KEYS.map((order) => winShare({ comp: "balanced", preset, order }, ref));
    rates.push(...row);
    console.log(`  ${preset.padEnd(11)} ${ORDER_KEYS.map((o, i) => `${o} ${pct(row[i])}`).join("  ")}  (default ${PRESETS[preset as keyof typeof PRESETS].order})`);
  }
  const spread = Math.max(...rates) - Math.min(...rates);
  console.log(`  spread between the best and worst choice: ${pct(spread)}`);
  if (spread < 0.25) fail("formation and order choices barely matter");

  // 4. abilities: one ability against the same army and formation without it
  console.log("\nAbilities: win share gained by bringing one ability (same army and formation, opponent brings none)");
  console.log("".padEnd(14) + comps.map((k) => k.padStart(11)).join(""));
  const useful: Record<string, string[]> = Object.fromEntries(comps.map((c) => [c, []]));
  for (const k of ABILITY_KEYS) {
    // Siege Breaker only matters against towers and bosses, so test it against a legendary boss
    const vsBoss = k === "siegebreaker";
    const gains = comps.map((c) => {
      const base = { comp: c, preset: best[c] };
      if (vsBoss) return bossShare({ ...base, abilities: [k] }) - bossShare(base);
      return winShare({ ...base, abilities: [k] }, base) - winShare(base, base);
    });
    const name = (ABILITIES as Record<string, { name: string }>)[k].name;
    console.log(`  ${name}`.padEnd(14) + gains.map((g) => `${g >= 0 ? "+" : ""}${Math.round(g * 100)}`.padStart(11)).join("") + (vsBoss ? "   (vs the Grand Champion)" : ""));
    if (Math.max(...gains) < 0.1) fail(`${name} never helps by 10 points`);
    if (!vsBoss) comps.forEach((c, i) => gains[i] >= 0.05 && useful[c].push(k));
  }

  // 5. ability pairs: for each army, every pair of the abilities that help it, round robin. Mirror
  // matches are knife-edge (a small edge wins most games), so the goal checked is that the best
  // loadout depends on the army: no single pair is the top pick everywhere.
  console.log("\nAbility pairs: same army and formation, each useful pair against the other useful pairs");
  const pairSeeds = Math.max(4, Math.round(SEEDS / 3));
  const tops: string[] = [];
  for (const c of comps) {
    const ks = useful[c];
    const pairs: string[][] = [];
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) pairs.push([ks[i], ks[j]]);
    if (pairs.length < 3) {
      console.log(`  ${c.padEnd(10)} (only ${ks.length} useful abilities: ${ks.join(", ") || "none"})`);
      continue;
    }
    const score = new Map<string, number[]>(pairs.map((p) => [p.join("+"), []]));
    const side = (abilities: string[]) => ({ comp: c, preset: best[c], abilities });
    for (let i = 0; i < pairs.length; i++)
      for (let j = i + 1; j < pairs.length; j++) {
        const w = winShare(side(pairs[i]), side(pairs[j]), pairSeeds);
        score.get(pairs[i].join("+"))!.push(w);
        score.get(pairs[j].join("+"))!.push(1 - w);
      }
    const ranked = [...score].map(([k, v]) => [k, mean(v)] as const).sort((a, b) => b[1] - a[1]);
    console.log(`  ${c.padEnd(10)} strongest ${ranked.slice(0, 3).map(([k, v]) => `${k} ${pct(v)}`).join(", ")} · weakest ${ranked.at(-1)![0]} ${pct(ranked.at(-1)![1])}`);
    tops.push(ranked[0][0]);
  }
  console.log(`  best loadout per army: ${tops.join(", ")}`);
  if (tops.length > 1 && new Set(tops).size === 1) fail(`the ${tops[0]} loadout is the best pick for every army`);

  console.log(ok ? "\nbalance goals met" : "\nbalance goals NOT met");
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("balance.ts")) main();
