// StakeClash world generator. Shared by the server (to place bounties on real land) and the
// browser (to draw it), so both build the identical world from the same seed.
//
// The world is a 384×384-tile continent split into seven realms, one per kind of Gemini market.
// A bounty about crypto spawns in the Ironvein Badlands, a sports bounty on the Arena Plains, and so on,
// so players know where to search without knowing the question.
import { fbm, mulberry32, rand2 } from "./rng.js";

export const TILE = 16; // pixels per tile
export const WORLD_W = 384;
export const WORLD_H = 384;
export const WORLD_SEED = 20261120;
export const CHUNK = 32; // tiles per render chunk
export const FOG_CELL = 8; // tiles per fog-of-war cell
export const FOG_W = WORLD_W / FOG_CELL;
export const FOG_H = WORLD_H / FOG_CELL;
export const SIGHT = 13; // tiles the hero can see

// ── Terrain ───────────────────────────────────────────────────────────
export const T = {
  DEEP: 0,
  WATER: 1,
  BEACH: 2,
  GRASS: 3,
  MEADOW: 4,
  FOREST: 5,
  BADLANDS: 6,
  DESERT: 7,
  SNOW: 8,
  MARSH: 9,
  ROAD: 10,
  MOUNTAIN: 11,
  TOWN: 12,
  BRIDGE: 13,
};
const WALK_T = new Uint8Array(16);
for (const t of [T.BEACH, T.GRASS, T.MEADOW, T.FOREST, T.BADLANDS, T.DESERT, T.SNOW, T.MARSH, T.ROAD, T.TOWN, T.BRIDGE]) WALK_T[t] = 1;
export const isWalkableTerrain = (t) => WALK_T[t] === 1;
/** Mountain ground is walkable rock; only the peaks drawn on it block (see O.PEAK). */
const canStand = (t) => WALK_T[t] === 1 || t === T.MOUNTAIN;
export const isWater = (t) => t === T.DEEP || t === T.WATER;

// ── Objects (one per tile) ────────────────────────────────────────────
export const O = {
  NONE: 0,
  OAK: 1,
  PINE: 2,
  SNOWPINE: 3,
  PALM: 4,
  CACTUS: 5,
  DEADTREE: 6,
  BUSH: 7,
  ROCK: 8,
  PEAK: 9,
  FLOWERS: 10,
  REEDS: 11,
  TUFT: 12,
  MUSHROOM: 13,
  BONES: 14,
  SNOWROCK: 15,
  WILLOW: 16,
};
const BLOCK_O = new Uint8Array(32);
for (const o of [O.OAK, O.PINE, O.SNOWPINE, O.PALM, O.CACTUS, O.DEADTREE, O.BUSH, O.ROCK, O.PEAK, O.SNOWROCK, O.WILLOW]) BLOCK_O[o] = 1;
export const isBlockingObject = (o) => BLOCK_O[o] === 1;
/** Flat details drawn into the ground layer rather than y-sorted with the hero. */
export const isDecal = (o) => o === O.FLOWERS || o === O.REEDS || o === O.TUFT || o === O.MUSHROOM || o === O.BONES;

// ── Realms ────────────────────────────────────────────────────────────
export const REALMS = [
  { id: "crownlands", name: "Crownlands", category: "Politics", ground: T.GRASS, at: [0.5, 0.5], town: "Kingsmarket", landmark: "castle", blurb: "Elections, courts and crowns" },
  { id: "frostpeaks", name: "Frostpeaks", category: "Weather", ground: T.SNOW, at: [0.5, 0.2], town: "Rimeholt", landmark: "lodge", blurb: "Storms, snow and heatwaves" },
  { id: "ironvein", name: "Ironvein Badlands", category: "Crypto", ground: T.BADLANDS, at: [0.77, 0.3], town: "Hashforge", landmark: "mine", blurb: "Coins, chains and miners" },
  { id: "goldmarsh", name: "Goldmarsh", category: "Economics", ground: T.MARSH, at: [0.79, 0.63], town: "Ledgerport", landmark: "treasury", blurb: "Rates, prices and jobs" },
  { id: "sunscar", name: "Sunscar Dunes", category: "Commodities", ground: T.DESERT, at: [0.54, 0.8], town: "Crudewell", landmark: "bazaar", blurb: "Oil, gold and grain" },
  { id: "arena", name: "Arena Plains", category: "Sports", ground: T.MEADOW, at: [0.24, 0.7], town: "Gloryfield", landmark: "colosseum", blurb: "Leagues, titles and MVPs" },
  { id: "whisperwood", name: "Whisperwood", category: "Culture", ground: T.FOREST, at: [0.22, 0.36], town: "Lanternhollow", landmark: "magetower", blurb: "Awards, charts and tech" },
];
export const realmIndex = (id) => REALMS.findIndex((r) => r.id === id);

const KEYWORDS = [
  ["ironvein", /crypto|bitcoin|btc|eth|ether|solana|\bsol\b|token|coin|defi|blockchain/i],
  ["arena", /sport|nba|nfl|mlb|nhl|soccer|football|basketball|mvp|championship|cup|league|tennis|golf|f1|ufc/i],
  ["frostpeaks", /weather|rain|snow|temperature|hurricane|storm|climate|heat|°|degrees/i],
  ["goldmarsh", /econom|fed\b|fomc|rate|cpi|inflation|gdp|jobs|payroll|unemployment|recession|finance|stock|s&p|nasdaq|treasury/i],
  ["sunscar", /commodit|oil|wti|brent|gold|silver|gas|wheat|corn|copper/i],
  ["crownlands", /politic|election|president|senate|congress|house|governor|vote|court|supreme|minister|parliament/i],
];
/** Which realm a Gemini market belongs to, from its category and title. */
export function realmForMarket(category, title = "") {
  const c = String(category ?? "").toLowerCase();
  const direct = REALMS.find((r) => r.category.toLowerCase() === c);
  if (direct) return direct.id;
  for (const [id, re] of KEYWORDS) if (re.test(c) || re.test(title)) return id;
  return "whisperwood";
}

// ── Generation ────────────────────────────────────────────────────────
const SEA = 0.5;

/** Binary min-heap of indices keyed by a Float32Array of scores. */
function makeHeap(score) {
  const a = [];
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (score[a[p]] <= score[a[i]]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < a.length && score[a[l]] < score[a[m]]) m = l;
      if (r < a.length && score[a[r]] < score[a[m]]) m = r;
      if (m === i) break;
      [a[m], a[i]] = [a[i], a[m]];
      i = m;
    }
  };
  return {
    push(v) {
      a.push(v);
      up(a.length - 1);
    },
    pop() {
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        down(0);
      }
      return top;
    },
    get size() {
      return a.length;
    },
  };
}

/**
 * Grid A*. cost(i) returns the cost to enter tile i (Infinity = blocked).
 * Returns tile indices from start to goal, or null.
 */
export function astar(W, H, start, goal, cost, { diagonal = false, maxNodes = W * H, hScale = 1 } = {}) {
  const N = W * H;
  const g = new Float32Array(N).fill(Infinity);
  const f = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const gx = goal % W;
  const gy = (goal / W) | 0;
  const h = (i) => {
    const dx = Math.abs((i % W) - gx);
    const dy = Math.abs(((i / W) | 0) - gy);
    return (diagonal ? Math.max(dx, dy) + 0.41 * Math.min(dx, dy) : dx + dy) * hScale;
  };
  const heap = makeHeap(f);
  g[start] = 0;
  f[start] = h(start);
  heap.push(start);
  const dirs = diagonal
    ? [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [-1, 1, 1.414], [1, -1, 1.414], [-1, -1, 1.414]]
    : [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]];
  let expanded = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    if (cur === goal) {
      const path = [];
      for (let c = goal; c !== -1; c = came[c]) path.push(c);
      return path.reverse();
    }
    closed[cur] = 1;
    if (++expanded > maxNodes) return null;
    const cx = cur % W;
    const cy = (cur / W) | 0;
    for (const [dx, dy, step] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (closed[ni]) continue;
      const c = cost(ni);
      if (c === Infinity) continue;
      // no corner cutting on diagonals
      if (dx && dy && (cost(cy * W + nx) === Infinity || cost(ny * W + cx) === Infinity)) continue;
      const ng = g[cur] + c * step;
      if (ng < g[ni]) {
        g[ni] = ng;
        f[ni] = ng + h(ni);
        came[ni] = cur;
        heap.push(ni);
      }
    }
  }
  return null;
}

/** Build the whole world. Deterministic for a given seed. ~0.3–0.6s. */
export function generateWorld(seed = WORLD_SEED) {
  const W = WORLD_W;
  const H = WORLD_H;
  const N = W * H;
  const rng = mulberry32(seed);
  const terrain = new Uint8Array(N);
  const objects = new Uint8Array(N);
  const realm = new Uint8Array(N);
  const elev = new Float32Array(N);
  const sea = new Uint8Array(N);
  const blocked = new Uint8Array(N); // structures
  const idx = (x, y) => y * W + x;

  const seeds = REALMS.map((r) => ({ x: (r.at[0] + (rng() - 0.5) * 0.05) * W, y: (r.at[1] + (rng() - 0.5) * 0.05) * H }));
  const nearSeed = (x, y, r) => seeds.some((s) => (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y) < r * r);

  // 1. Elevation → land and sea; realms by warped Voronoi.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const nx = x / W - 0.5;
      const ny = y / H - 0.5;
      const d2 = (nx * nx + ny * ny) * 3.2;
      const base = fbm(x / 70, y / 70, seed + 11, 5);
      const detail = fbm(x / 18, y / 18, seed + 12, 3);
      let e = base * 0.75 + detail * 0.25 + 0.5 - d2 * 0.95;
      if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) e = 0;
      elev[i] = e;
      const wx = x + (fbm(x / 50, y / 50, seed + 21, 3) - 0.5) * 70;
      const wy = y + (fbm(x / 50, y / 50, seed + 22, 3) - 0.5) * 70;
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < seeds.length; k++) {
        const dx = seeds[k].x - wx;
        const dy = seeds[k].y - wy;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      realm[i] = best;
      if (e < SEA) {
        sea[i] = 1;
        terrain[i] = e < SEA - 0.05 ? T.DEEP : T.WATER;
      } else {
        terrain[i] = REALMS[best].ground;
      }
    }
  }

  // 2. Mountains, lakes, beaches.
  const MOUNT = { crownlands: 0.955, frostpeaks: 0.87, ironvein: 0.88, goldmarsh: 0.97, sunscar: 0.93, arena: 0.96, whisperwood: 0.92 };
  const LAKE = { crownlands: 0.73, frostpeaks: 0.78, ironvein: 0.8, goldmarsh: 0.6, sunscar: 0.79, arena: 0.76, whisperwood: 0.7 };
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = idx(x, y);
      if (sea[i]) continue;
      const rid = REALMS[realm[i]].id;
      const e = elev[i];
      if (nearSeed(x, y, 11)) continue;
      const ridge = 1 - Math.abs(2 * fbm(x / 45, y / 45, seed + 31, 4) - 1);
      const patch = fbm(x / 34, y / 34, seed + 32, 2);
      if (e > SEA + 0.08 && patch > 0.47 && ridge > MOUNT[rid]) {
        terrain[i] = T.MOUNTAIN;
        continue;
      }
      const lake = fbm(x / 26, y / 26, seed + 41, 3);
      if (e > SEA + 0.05 && lake > LAKE[rid]) terrain[i] = T.WATER;
    }
  }
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = idx(x, y);
      if (sea[i] || terrain[i] === T.MOUNTAIN || terrain[i] === T.WATER) continue;
      const rid = REALMS[realm[i]].id;
      if (rid === "frostpeaks" || rid === "ironvein") continue;
      let coast = false;
      for (let dy = -1; dy <= 1 && !coast; dy++) for (let dx = -1; dx <= 1; dx++) if (sea[idx(x + dx, y + dy)]) coast = true;
      if (!coast) continue;
      const beachy = rid === "sunscar" || fbm(x / 20, y / 20, seed + 61, 2) > 0.58;
      if (beachy && elev[i] < SEA + 0.04) terrain[i] = T.BEACH;
    }
  }

  // 3. Towns: one per realm, near its seed, on a clear patch of land.
  const structures = [];
  const towns = [];
  const clearArea = (cx, cy, rx, ry) => {
    for (let y = cy - ry; y <= cy + ry; y++)
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) return false;
        const t = terrain[idx(x, y)];
        if (!isWalkableTerrain(t) || t === T.BEACH) return false;
      }
    return true;
  };
  const place = (kind, x, y, w, h) => {
    structures.push({ kind, x, y, w, h });
    for (let yy = y - h + 1; yy <= y; yy++) for (let xx = x; xx < x + w; xx++) blocked[idx(xx, yy)] = 1;
  };
  REALMS.forEach((r, k) => {
    let cx = Math.round(seeds[k].x);
    let cy = Math.round(seeds[k].y);
    search: for (let rad = 0; rad < 40; rad++) {
      for (let dy = -rad; dy <= rad; dy++)
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          if (clearArea(cx + dx, cy + dy, 7, 7)) {
            cx += dx;
            cy += dy;
            break search;
          }
        }
    }
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 3; x <= cx + 3; x++) terrain[idx(x, y)] = T.TOWN;
    place("waystone", cx, cy - 1, 1, 1);
    place("house", cx - 6, cy - 1, 2, 2);
    place("house", cx + 5, cy - 1, 2, 2);
    place("house", cx - 6, cy + 3, 2, 2);
    place("house", cx + 5, cy + 3, 2, 2);
    if (r.landmark === "castle") place("castle", cx - 3, cy - 3, 7, 3);
    else place(r.landmark, cx - 1, cy - 3, 3, 2);
    towns.push({ realm: r.id, name: r.town, x: cx, y: cy, waystone: { x: cx, y: cy + 1 } });
  });

  // 4. Roads: a ring between neighbouring realms plus spokes to the capital.
  const roadCost = (i) => {
    if (blocked[i]) return Infinity;
    switch (terrain[i]) {
      case T.DEEP:
        return Infinity;
      case T.WATER:
        return sea[i] ? Infinity : 16;
      case T.ROAD:
      case T.BRIDGE:
        return 0.35;
      case T.TOWN:
        return 1;
      case T.MOUNTAIN:
        return 4;
      case T.MARSH:
        return 2.2;
      case T.BEACH:
        return 2;
      case T.FOREST:
      case T.SNOW:
        return 1.6;
      default:
        return 1 + rand2(i % W, (i / W) | 0, seed + 71) * 0.6;
    }
  };
  const byId = Object.fromEntries(towns.map((t) => [t.realm, t]));
  const links = [
    ["crownlands", "frostpeaks"],
    ["crownlands", "ironvein"],
    ["crownlands", "goldmarsh"],
    ["crownlands", "sunscar"],
    ["crownlands", "arena"],
    ["crownlands", "whisperwood"],
    ["whisperwood", "frostpeaks"],
    ["frostpeaks", "ironvein"],
    ["ironvein", "goldmarsh"],
    ["goldmarsh", "sunscar"],
    ["sunscar", "arena"],
    ["arena", "whisperwood"],
  ];
  for (const [a, b] of links) {
    const A = byId[a];
    const B = byId[b];
    const path = astar(W, H, idx(A.x, A.y + 2), idx(B.x, B.y + 2), roadCost, { hScale: 0.4 });
    if (!path) continue;
    for (const i of path) {
      if (terrain[i] === T.TOWN) continue;
      terrain[i] = terrain[i] === T.WATER ? T.BRIDGE : T.ROAD;
    }
  }

  // 5. Trees, rocks and ground details.
  const nearRoad = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const t = terrain[idx(x, y)];
      if (t === T.ROAD || t === T.BRIDGE || t === T.TOWN)
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) nearRoad[idx(x + dx, y + dy)] = 1;
    }
  const nearWater = (x, y, r) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && terrain[idx(xx, yy)] === T.WATER) return true;
      }
    return false;
  };
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = idx(x, y);
      const t = terrain[i];
      if (blocked[i]) continue;
      if (t === T.MOUNTAIN) {
        // winding passes: long thin valleys where no peaks grow, so every range can be crossed
        const pass = Math.abs(fbm(x / 11, y / 11, seed + 84, 2) - 0.5) < 0.075 || Math.abs(fbm(x / 7, y / 7, seed + 85, 2) - 0.5) < 0.04;
        if (!pass && rand2(x, y, seed + 81) < 0.55) objects[i] = O.PEAK;
        continue;
      }
      if (!isWalkableTerrain(t) || t === T.ROAD || t === T.TOWN || t === T.BRIDGE) continue;
      const p = rand2(x, y, seed + 82);
      const q = rand2(x, y, seed + 83);
      const cluster = fbm(x / 14, y / 14, seed + 51, 3);
      const rid = REALMS[realm[i]].id;
      const trail = Math.abs(fbm(x / 13, y / 13, seed + 86, 2) - 0.5) < 0.045;
      const clear = nearRoad[i] || nearSeed(x, y, 9) || trail;
      let o = O.NONE;
      if (t === T.BEACH) {
        if (!clear && (rid === "sunscar" || rid === "arena") && p < 0.03) o = O.PALM;
      } else if (rid === "crownlands") {
        const d = cluster > 0.6 ? 0.42 : 0.035;
        if (!clear && p < d) o = q < 0.72 ? O.OAK : O.PINE;
        else if (p > 0.9) o = q < 0.35 ? O.FLOWERS : O.TUFT;
      } else if (rid === "whisperwood") {
        const d = cluster > 0.45 ? 0.5 : 0.12;
        if (!clear && p < d) o = q < 0.55 ? O.OAK : O.PINE;
        else if (p > 0.92) o = q < 0.5 ? O.MUSHROOM : O.TUFT;
      } else if (rid === "frostpeaks") {
        const d = cluster > 0.52 ? 0.38 : 0.05;
        if (!clear && p < d) o = O.SNOWPINE;
        else if (!clear && p > 0.98) o = O.SNOWROCK;
      } else if (rid === "ironvein") {
        if (!clear && p < 0.035) o = O.ROCK;
        else if (!clear && p < 0.055) o = O.DEADTREE;
        else if (!clear && p < 0.063) o = O.CACTUS;
        else if (p > 0.985) o = O.BONES;
      } else if (rid === "sunscar") {
        if (!clear && nearWater(x, y, 3) && p < 0.3) o = O.PALM;
        else if (!clear && p < 0.025) o = O.CACTUS;
        else if (!clear && p < 0.033) o = O.ROCK;
        else if (p > 0.99) o = O.BONES;
      } else if (rid === "arena") {
        if (!clear && cluster > 0.7 && p < 0.35) o = O.OAK;
        else if (!clear && p < 0.018) o = O.BUSH;
        else if (p > 0.88) o = q < 0.6 ? O.FLOWERS : O.TUFT;
      } else if (rid === "goldmarsh") {
        if (!clear && cluster > 0.6 && p < 0.32) o = O.WILLOW;
        else if (!clear && p < 0.03) o = O.BUSH;
        else if (p > (nearWater(x, y, 1) ? 0.6 : 0.9)) o = O.REEDS;
      }
      objects[i] = o;
    }
  }

  // 6. Spawn just south of the capital, then cut passes so every sizeable area is reachable.
  const cap = byId.crownlands;
  const spawn = { x: cap.x, y: cap.y + 1 };
  const walk = new Uint8Array(N);
  const reachable = new Uint8Array(N);
  const queue = new Int32Array(N);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const refreshWalk = () => {
    for (let i = 0; i < N; i++) walk[i] = canStand(terrain[i]) && !isBlockingObject(objects[i]) && !blocked[i] ? 1 : 0;
  };
  const flood = (start, mark, value, filter) => {
    let qh = 0;
    let qt = 0;
    mark[start] = value;
    queue[qt++] = start;
    while (qh < qt) {
      const c = queue[qh++];
      const cx = c % W;
      const cy = (c / W) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (mark[n] === 0 && filter(n)) {
          mark[n] = value;
          queue[qt++] = n;
        }
      }
    }
    return qt;
  };
  refreshWalk();
  flood(idx(spawn.x, spawn.y), reachable, 1, (n) => walk[n] === 1);
  // Dijkstra from an unreachable pocket to the nearest reachable tile, digging through
  // mountains and trees (and bridging lakes) on the way.
  const carveCost = (i) => {
    if (blocked[i]) return Infinity;
    const t = terrain[i];
    if (t === T.DEEP || (t === T.WATER && sea[i])) return Infinity;
    if (t === T.WATER) return 9;
    if (isBlockingObject(objects[i])) return t === T.MOUNTAIN ? 3 : 2;
    return 1;
  };
  const dist = new Float32Array(N);
  const prev = new Int32Array(N);
  const comp = new Uint8Array(N);
  let carves = 0;
  for (let i = 0; i < N && carves < 80; i++) {
    if (!walk[i] || reachable[i] || comp[i]) continue;
    const size = flood(i, comp, 1, (n) => walk[n] === 1 && !reachable[n]);
    if (size < 30) continue;
    dist.fill(Infinity);
    prev.fill(-1);
    const heap = makeHeap(dist);
    for (let q = 0; q < size; q++) {
      const s0 = queue[q];
      dist[s0] = 0;
      heap.push(s0);
    }
    const members = new Set(Array.from(queue.subarray(0, size)));
    let hit = -1;
    while (heap.size) {
      const c = heap.pop();
      if (reachable[c]) {
        hit = c;
        break;
      }
      const cx = c % W;
      const cy = (c / W) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 2 || ny < 2 || nx >= W - 2 || ny >= H - 2) continue;
        const n = ny * W + nx;
        const cc = carveCost(n);
        if (cc === Infinity) continue;
        const nd = dist[c] + cc;
        if (nd < dist[n]) {
          dist[n] = nd;
          prev[n] = c;
          heap.push(n);
        }
      }
    }
    if (hit < 0) continue;
    for (let c = hit; c !== -1 && !members.has(c); c = prev[c]) {
      if (terrain[c] === T.WATER) terrain[c] = T.BRIDGE;
      if (isBlockingObject(objects[c])) objects[c] = O.NONE;
      walk[c] = 1;
    }
    carves++;
    reachable.fill(0);
    flood(idx(spawn.x, spawn.y), reachable, 1, (n) => walk[n] === 1);
  }

  return { W, H, seed, terrain, objects, realm, elev, sea, blocked, walk, reachable, structures, towns, spawn };
}

/** Pick bounty camp sites in a realm: reachable, open ground, away from towns and each other. */
export function pickBountySite(world, realmId, taken, rnd, minGap = 18) {
  const k = realmIndex(realmId);
  const { W, H, terrain, objects, walk, reachable, realm, towns } = world;
  for (let attempt = 0; attempt < 4000; attempt++) {
    const x = 4 + Math.floor(rnd() * (W - 8));
    const y = 4 + Math.floor(rnd() * (H - 8));
    const i = y * W + x;
    if (realm[i] !== k || !reachable[i]) continue;
    const t = terrain[i];
    if (t === T.ROAD || t === T.TOWN || t === T.BRIDGE || t === T.BEACH || t === T.MOUNTAIN) continue;
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const j = (y + dy) * W + x + dx;
        if (!walk[j] || (objects[j] && !isDecal(objects[j]))) ok = false;
      }
    if (!ok) continue;
    if (towns.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) < 14)) continue;
    if (taken.some((p) => Math.abs(p.x - x) + Math.abs(p.y - y) < minGap)) continue;
    return { x, y };
  }
  return null;
}
