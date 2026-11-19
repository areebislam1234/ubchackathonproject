// Renders the generated world to docs/world-map.png (1 pixel per tile, scaled 2×) and prints stats.
import fs from "node:fs";
import path from "node:path";
import { generateWorld, REALMS, T, O, isBlockingObject } from "../shared/world.js";
import { encodePng } from "../server/png";
import { ROOT } from "../shared/paths";

const t0 = performance.now();
const w = generateWorld();
const ms = Math.round(performance.now() - t0);
const COL: Record<number, [number, number, number]> = {
  [T.DEEP]: [30, 78, 163], [T.WATER]: [47, 111, 208], [T.BEACH]: [232, 196, 124], [T.GRASS]: [95, 184, 63],
  [T.MEADOW]: [138, 209, 78], [T.FOREST]: [52, 120, 52], [T.BADLANDS]: [201, 104, 59], [T.DESERT]: [240, 210, 140],
  [T.SNOW]: [238, 244, 251], [T.MARSH]: [92, 130, 70], [T.ROAD]: [214, 170, 100], [T.MOUNTAIN]: [120, 110, 120],
  [T.TOWN]: [180, 170, 170], [T.BRIDGE]: [139, 90, 43],
};
const S = 2;
const px = new Uint8Array(w.W * S * w.H * S * 4);
for (let y = 0; y < w.H; y++)
  for (let x = 0; x < w.W; x++) {
    const i = y * w.W + x;
    let c = COL[w.terrain[i]];
    if (isBlockingObject(w.objects[i]) && w.objects[i] !== O.PEAK) c = c.map((v) => v * 0.62) as any;
    if (w.blocked[i]) c = [60, 40, 40];
    for (let sy = 0; sy < S; sy++)
      for (let sx = 0; sx < S; sx++) {
        const o = ((y * S + sy) * w.W * S + x * S + sx) * 4;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
      }
  }
fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "world-map.png"), encodePng(w.W * S, w.H * S, px));
const counts = new Map<string, number>();
let land = 0, reach = 0;
for (let i = 0; i < w.W * w.H; i++) {
  if (w.terrain[i] !== T.DEEP && w.terrain[i] !== T.WATER) land++;
  if (w.reachable[i]) { reach++; const r = REALMS[w.realm[i]].id; counts.set(r, (counts.get(r) ?? 0) + 1); }
}
console.log(`generated in ${ms}ms  land ${(100 * land / (w.W * w.H)).toFixed(1)}%  reachable ${reach} tiles`);
console.log("reachable per realm", Object.fromEntries(counts));
console.log("towns", w.towns.map((t) => `${t.name}@${t.x},${t.y}`).join("  "));
console.log("structures", w.structures.length, "spawn", w.spawn);
