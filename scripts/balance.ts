// Balance check for strategic combat (engine 2). Armies of equal size (36 housing, level 3) play each
// other from both sides over many seeds. Checks the design goals:
//   1. no army type wins too much overall, and every army type has one it beats and one it loses to
//   2. the best formation depends on the army (no single dominant preset)
//   3. formation and order choices move results for the same army
//   npx tsx scripts/balance.ts          (SEEDS=30 for a slower, finer run)
import { simulate2 } from "../shared/battle2.js";
import { ORDER_KEYS, PRESETS, PRESET_KEYS, UNIT_KEYS, autoFormation } from "../shared/rules.js";

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

type Side = { comp: string; preset: string; order?: string };
const spec = (s: Side) => ({ formation: autoFormation(COMPS[s.comp], s.preset, s.order ?? null), levels: LEVEL });

/** Share of games X wins against Y, playing both as attacker and as defender. */
export function winShare(x: Side, y: Side, seeds = SEEDS) {
  let w = 0;
  for (let i = 1; i <= seeds; i++) {
    if (simulate2({ attacker: spec(x), defender: spec(y), seed: i * 7919 }).winner === "attacker") w++;
    if (simulate2({ attacker: spec(y), defender: spec(x), seed: i * 104729 }).winner === "defender") w++;
  }
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

  console.log(ok ? "\nbalance goals met" : "\nbalance goals NOT met");
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("balance.ts")) main();
