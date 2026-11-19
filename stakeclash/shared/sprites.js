// StakeClash pixel art. Every sprite is a grid of palette letters ('.' = transparent).
// Hand-drawn sprites are strings below; trees, rocks and towers are generated from a few
// parameters so forests don't look copy-pasted. Shared by the browser (canvas) and the
// server (badge PNGs).
import { mulberry32, rand2 } from "./rng.js";

export const PALETTE = {
  k: "#1b1626", // outline
  K: "#3a3348",
  x: "#ffffff",
  g: "#5fb83f", // grass
  G: "#3f8a33",
  h: "#8ad14e",
  H: "#b9e66e",
  F: "#2d6e2b", // foliage
  f: "#1f4d24",
  t: "#4ea23a",
  T: "#7cc84a",
  b: "#8a5a2c", // wood / earth
  B: "#5c3a1d",
  n: "#b98146",
  N: "#e0b278",
  s: "#e6c27a", // sand / path
  S: "#c99a4f",
  y: "#f5e0a4",
  w: "#2b62c4", // water
  W: "#1f4aa0",
  V: "#173a7d",
  c: "#4f8ee0",
  C: "#cfe8ff",
  r: "#a3a3b3", // stone
  R: "#6f6e82",
  q: "#d0d0dc",
  Q: "#4a4860",
  e: "#d8452f", // red roof
  E: "#962a22",
  o: "#f07c4f",
  u: "#3e74d6", // blue (player team)
  U: "#25448f",
  v: "#7ba8f2",
  p: "#8f52d4", // purple
  P: "#5a2e93",
  m: "#c49bf2",
  a: "#f6c33b", // gold
  A: "#b9861a",
  z: "#fff3a6",
  i: "#f3c39c", // skin
  I: "#c98b66",
  l: "#eef4fb", // snow
  L: "#b7cbe0",
  d: "#c9683b", // badlands
  D: "#8f4327",
  j: "#e23c3c", // red (enemy team)
  J: "#9c2323",
  M: "#6f8f4f", // marsh
  Z: "#2a2240",
};

/** RGB triples for fast per-pixel drawing. */
export const RGB = Object.fromEntries(
  Object.entries(PALETTE).map(([k, hex]) => [k, [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]]),
);

// ── Helpers ───────────────────────────────────────────────────────────
const grid = (w, h) => Array.from({ length: h }, () => Array(w).fill("."));
const toRows = (g) => g.map((r) => r.join(""));
/** Normalise hand-drawn rows to a fixed width. */
function rows(lines, w) {
  return lines.map((l) => (l.length >= w ? l.slice(0, w) : l + ".".repeat(w - l.length)));
}
function sprite(lines, ax = 0.5, ay = 1) {
  const w = Math.max(...lines.map((l) => l.length));
  return { w, h: lines.length, px: rows(lines, w), ax, ay };
}
/** Swap palette letters, e.g. blue team → red team. */
export function recolor(spr, map) {
  return { ...spr, px: spr.px.map((r) => [...r].map((c) => map[c] ?? c).join("")) };
}
export function mirror(spr) {
  return { ...spr, px: spr.px.map((r) => [...r].reverse().join("")) };
}
export const TEAM_RED = { u: "j", U: "J", v: "o" };

/** Outline every filled pixel that touches transparency. */
function outline(g, color, skip = () => false) {
  const h = g.length;
  const w = g[0].length;
  const out = g.map((r) => r.slice());
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (g[y][x] === "." || skip(x, y)) continue;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx < 0 || ny < 0 || nx >= w || ny >= h || g[ny][nx] === ".";
      });
      if (edge) out[y][x] = color;
    }
  return out;
}

// ── Procedural: round-canopy trees, pines, rocks, mountains ────────────
function blob(g, circles, tones, seed, opts = {}) {
  const h = g.length;
  const w = g[0].length;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let best = -Infinity;
      let v = 0;
      for (const [cx, cy, r] of circles) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const depth = 1 - Math.sqrt(dx * dx + dy * dy) / r;
        if (depth > 0 && depth > best - 0.25) {
          if (depth > best) best = depth;
          v = (dx * 0.62 + dy * 0.78) / r;
        }
      }
      if (best <= 0) continue;
      const j = (rand2(x, y, seed) - 0.5) * 0.45;
      const s = v + j;
      g[y][x] = s < -0.42 ? tones[0] : s < 0.08 ? tones[1] : s < 0.5 ? tones[2] : tones[3];
      if (opts.sparkle && s < -0.3 && rand2(x, y, seed + 7) > 0.8) g[y][x] = opts.sparkle;
    }
}

function roundTree(seed, tones = ["T", "t", "F", "f"], sparkle = "H") {
  const r = mulberry32(seed);
  const w = 16;
  const h = 21;
  const g = grid(w, h);
  // trunk
  for (let y = 13; y < 20; y++) {
    g[y][6] = "n";
    g[y][7] = "b";
    g[y][8] = "b";
    g[y][9] = "B";
  }
  g[19][5] = "b";
  g[19][10] = "B";
  const circles = [
    [8, 7.2, 6.4 + r() * 0.5],
    [4.6 + r(), 9.8, 3.8 + r() * 0.6],
    [11.4 - r(), 9.8, 3.8 + r() * 0.6],
    [8 + (r() - 0.5) * 2, 4.4, 3.8],
  ];
  blob(g, circles, tones, seed, { sparkle });
  const o = outline(g, tones[3] === "f" ? "f" : "k", (x, y) => y >= 13 && g[y][x] !== tones[0] && "nbB".includes(g[y][x]) && y > 15);
  // trunk outline
  for (let y = 13; y < 20; y++) {
    if (o[y][5] === ".") o[y][5] = "B";
    if (o[y][10] === ".") o[y][10] = "B";
  }
  o[20] = o[20].map((c, x) => (x >= 5 && x <= 10 ? "B" : c));
  return { w, h, px: toRows(o), ax: 0.5, ay: 1 };
}

function pineTree(seed, snowy = false) {
  const w = 14;
  const h = 22;
  const g = grid(w, h);
  for (let y = 17; y < 21; y++) {
    g[y][6] = "b";
    g[y][7] = "B";
  }
  const tiers = [
    [2, 8, 3.4],
    [6, 13, 5],
    [10, 18, 6.5],
  ];
  for (const [top, bottom, half] of tiers) {
    for (let y = top; y <= bottom; y++) {
      const t = (y - top) / (bottom - top);
      const span = 0.8 + t * half;
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - 7;
        if (Math.abs(dx) > span) continue;
        const v = dx / half + (rand2(x, y, seed) - 0.5) * 0.6 - (1 - t) * 0.3;
        let c = v < -0.45 ? "T" : v < 0.1 ? "t" : v < 0.55 ? "F" : "f";
        if (snowy && (y - top < 2 || (t < 0.5 && rand2(x, y, seed + 3) > 0.55))) c = v > 0.3 ? "L" : "l";
        g[y][x] = c;
      }
    }
  }
  const o = outline(g, "f", (x, y) => y >= 17);
  o[21] = o[21].map((c, x) => (x >= 5 && x <= 8 ? "B" : c));
  return { w, h, px: toRows(o), ax: 0.5, ay: 1 };
}

function rock(seed, tones = ["q", "r", "R", "Q"], w = 13, h = 10, snowCap = false) {
  const g = grid(w, h);
  blob(g, [[w / 2, h * 0.62, w * 0.42], [w * 0.36, h * 0.66, w * 0.3], [w * 0.66, h * 0.55, w * 0.32]], tones, seed);
  if (snowCap) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y][x] !== "." && y < h * 0.45) g[y][x] = rand2(x, y, seed) > 0.3 ? "l" : "L";
  return { w, h, px: toRows(outline(g, "k")), ax: 0.5, ay: 1 };
}

function peak(seed, tones, snow = false) {
  const w = 22;
  const h = 22;
  const g = grid(w, h);
  const r = mulberry32(seed);
  const top = 2 + Math.floor(r() * 4);
  const lean = (r() - 0.5) * 4;
  for (let y = top; y < h; y++) {
    const t = (y - top) / (h - top);
    const half = 2 + t * 9.5;
    const cx = 11 + lean * (1 - t);
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      if (Math.abs(dx) > half) continue;
      // strata: lighter top surfaces, darker vertical faces, layered bands
      const band = (y + Math.floor(rand2(x >> 2, y, seed) * 2)) % 5 === 0;
      const v = dx / half + (rand2(x, y, seed) - 0.5) * 0.35;
      let c = v < -0.35 ? tones[0] : v < 0.25 ? tones[1] : tones[2];
      if (band) c = tones[2];
      if (y === h - 1 || (y > h - 3 && rand2(x, y, seed + 2) > 0.5)) c = tones[3];
      if (snow && y < top + 5 + rand2(x, 0, seed) * 3) c = v < 0.2 ? "l" : "L";
      g[y][x] = c;
    }
  }
  return { w, h, px: toRows(outline(g, "k")), ax: 0.5, ay: 1 };
}

// ── Procedural: towers and buildings ───────────────────────────────────
const ROOFS = {
  red: ["o", "e", "E"],
  blue: ["v", "u", "U"],
  purple: ["m", "p", "P"],
  gold: ["z", "a", "A"],
};
function tower({ roof = "red", w = 14, wall = 13, ruined = false, flag = true, seed = 1 } = {}) {
  const roofH = roof === "none" ? 0 : Math.round(w * 0.9);
  const flagH = flag && !ruined ? 4 : 0;
  const h = flagH + roofH + wall + 1;
  const W2 = w + 2;
  const g = grid(W2, h);
  const cx = W2 / 2;
  // flag
  if (flagH) {
    for (let y = 0; y < flagH + 1; y++) g[y][Math.floor(cx)] = "K";
    g[0][Math.floor(cx) + 1] = "j";
    g[0][Math.floor(cx) + 2] = "j";
    g[1][Math.floor(cx) + 1] = "j";
    g[1][Math.floor(cx) + 2] = "J";
  }
  // conical roof
  const [rl, rm, rd] = ROOFS[roof] ?? ROOFS.red;
  for (let y = 0; y < roofH; y++) {
    const t = (y + 1) / roofH;
    const half = 0.6 + t * (W2 / 2);
    for (let x = 0; x < W2; x++) {
      const dx = x + 0.5 - cx;
      if (Math.abs(dx) > half) continue;
      const v = dx / half;
      g[flagH + y][x] = v < -0.35 ? rl : v < 0.4 ? rm : rd;
      if (y % 3 === 2 && rand2(x, y, seed) > 0.6) g[flagH + y][x] = rd;
    }
  }
  // wall
  const wy0 = flagH + roofH;
  for (let y = 0; y < wall; y++)
    for (let x = 1; x < W2 - 1; x++) {
      const v = (x + 0.5 - cx) / (W2 / 2);
      let c = v < -0.45 ? "q" : v < 0.45 ? "r" : "R";
      if (y % 4 === 3 || ((x + (Math.floor(y / 4) % 2) * 2) % 5 === 0 && y % 4 !== 0)) c = c === "q" ? "r" : "R";
      g[wy0 + y][x] = c;
    }
  // rim under roof
  if (roofH) for (let x = 0; x < W2; x++) g[wy0][x] = x === 0 || x === W2 - 1 ? "." : "Q";
  // window + door
  const mx = Math.floor(cx) - 1;
  if (wall > 8) {
    g[wy0 + 3][mx] = "k";
    g[wy0 + 3][mx + 1] = "k";
    g[wy0 + 4][mx] = "k";
    g[wy0 + 4][mx + 1] = "Z";
  }
  for (let y = wall - 4; y < wall; y++)
    for (let x = mx - 1; x <= mx + 2; x++) g[wy0 + y][x] = y === wall - 4 && (x === mx - 1 || x === mx + 2) ? g[wy0 + y][x] : x === mx + 2 ? "B" : "b";
  // ruined: bite chunks out of the top
  if (ruined)
    for (let x = 0; x < W2; x++) {
      const bite = Math.floor(rand2(x, 0, seed) * 4);
      for (let y = wy0; y < wy0 + bite; y++) g[y][x] = ".";
    }
  // battlements when no roof
  if (!roofH && !ruined) for (let x = 1; x < W2 - 1; x += 2) g[wy0][x] = ".";
  return { w: W2, h, px: toRows(outline(g, "k")), ax: 0.5, ay: 1 };
}

function house({ roof = "red", w = 24, seed = 3, snowy = false, wallTone = "N" } = {}) {
  const roofH = 10;
  const wall = 10;
  const h = roofH + wall;
  const g = grid(w, h);
  const [rl, rm, rd] = ROOFS[roof];
  for (let y = 0; y < roofH; y++) {
    const inset = Math.max(0, roofH - 1 - y) * 0.9;
    for (let x = Math.floor(inset); x < w - Math.floor(inset); x++) {
      const shade = x < w / 2 ? (y % 2 ? rm : rl) : y % 2 ? rd : rm;
      g[y][x] = snowy && y < 4 ? (x < w / 2 ? "l" : "L") : shade;
    }
  }
  for (let y = roofH; y < h; y++)
    for (let x = 1; x < w - 1; x++) {
      let c = wallTone;
      if (x === 1 || x === w - 2 || y === roofH || x === Math.floor(w / 2)) c = "b";
      g[y][x] = c;
    }
  // windows and door
  for (const wx of [4, w - 7]) for (let y = roofH + 3; y < roofH + 6; y++) for (let x = wx; x < wx + 3; x++) g[y][x] = y === roofH + 3 ? "B" : "c";
  for (let y = h - 6; y < h; y++) for (let x = Math.floor(w / 2) - 2; x <= Math.floor(w / 2) + 1; x++) g[y][x] = x === Math.floor(w / 2) + 1 ? "B" : "b";
  g[h - 3][Math.floor(w / 2)] = "a";
  return { w, h, px: toRows(outline(g, "k")), ax: 0, ay: 1 };
}

function castle() {
  // Composite: a curtain wall with a gate, four round towers, a keep with blue roofs.
  const w = 112;
  const h = 74;
  const g = grid(w, h);
  const stamp = (spr, x0, y0) => {
    spr.px.forEach((row, y) => [...row].forEach((c, x) => c !== "." && y0 + y >= 0 && y0 + y < h && x0 + x >= 0 && x0 + x < w && (g[y0 + y][x0 + x] = c)));
  };
  // back keep
  const keep = tower({ roof: "blue", w: 24, wall: 22, seed: 11 });
  stamp(keep, Math.floor(w / 2 - keep.w / 2), h - 22 - keep.h);
  // curtain wall
  for (let y = h - 26; y < h; y++)
    for (let x = 8; x < w - 8; x++) {
      let c = (y - (h - 26)) % 5 === 4 ? "R" : (x + (Math.floor(y / 5) % 2) * 3) % 7 === 0 ? "R" : "r";
      if (y === h - 26) c = (x % 4 < 2) ? "q" : ".";
      g[y][x] = c;
    }
  // gate
  for (let y = h - 14; y < h; y++)
    for (let x = w / 2 - 7; x < w / 2 + 7; x++) {
      const dx = Math.abs(x + 0.5 - w / 2);
      const arch = y - (h - 14) < 4 && dx > 7 - (y - (h - 14)) * 1.6;
      if (!arch) g[y][x] = (x + y) % 3 === 0 ? "B" : "b";
    }
  const side = tower({ roof: "blue", w: 18, wall: 26, seed: 12 });
  const small = tower({ roof: "blue", w: 14, wall: 20, seed: 13, flag: false });
  stamp(small, 22, h - 10 - small.h);
  stamp(small, w - 22 - small.w, h - 10 - small.h);
  stamp(side, 0, h - side.h);
  stamp(side, w - side.w, h - side.h);
  return { w, h, px: toRows(outline(g, "k")), ax: 0, ay: 1 };
}

function tent(roofKey = "red") {
  const [l, m, d] = ROOFS[roofKey];
  const w = 18;
  const h = 14;
  const g = grid(w, h);
  for (let y = 0; y < h; y++) {
    const half = 1 + (y / (h - 1)) * 8;
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - 9;
      if (Math.abs(dx) > half) continue;
      g[y][x] = dx < -half * 0.3 ? l : dx < half * 0.4 ? m : d;
      if (Math.abs(dx) < 1.5 && y > h - 6) g[y][x] = "k";
      if ((x + y) % 4 === 0 && y > 2) g[y][x] = dx < 0 ? m : d;
    }
  }
  return { w, h, px: toRows(outline(g, "k")), ax: 0.5, ay: 1 };
}

function colosseum() {
  const w = 56;
  const h = 32;
  const g = grid(w, h);
  for (let y = 4; y < h; y++)
    for (let x = 2; x < w - 2; x++) {
      const tier = y < 14 ? 0 : 1;
      const ax = (x - 2) % 7;
      const archTop = tier === 0 ? 8 : 20;
      const isArch = y >= archTop && y < archTop + (tier ? 9 : 5) && ax >= 2 && ax <= 4;
      let c = x < w * 0.3 ? "y" : x < w * 0.75 ? "N" : "n";
      if (y === 4 || y === 14) c = "b";
      if (isArch) c = y === archTop ? "B" : "K";
      g[y][x] = c;
    }
  for (let x = 4; x < w - 4; x += 8) {
    g[0][x] = "K";
    g[1][x] = "K";
    g[2][x] = "K";
    g[3][x] = "K";
    g[0][x + 1] = "j";
    g[1][x + 1] = "j";
    g[0][x + 2] = "a";
  }
  return { w, h, px: toRows(outline(g, "k")), ax: 0, ay: 1 };
}

// ── Hand-drawn sprites ─────────────────────────────────────────────────
const HERO_DOWN = [
  "................",
  ".....kkkkkk.....",
  "....kBBBBBBk....",
  "...kBbbbbbbBk...",
  "...kBbiiiibBk...",
  "...kbikiikibk...",
  "...kiiiiiiiik...",
  "....kiiIIiik....",
  "...kUuuuuuuUk...",
  "..kiUuvuuvuUik..",
  "..kikUuuuuUkik..",
  "...kkBnnanBkk...",
  "....kRRRRRRk....",
  "....kRRkkRRk....",
  "....kBBk.kBBk...",
  ".....kk...kk....",
];
const HERO_DOWN_STEP = [...HERO_DOWN.slice(0, 12), "....kRRRRRRk....", "....kRRk.kRk....", "....kBBk..kBk...", ".....kk....k...."];
const HERO_UP = [
  "................",
  ".....kkkkkk.....",
  "....kBBBBBBk....",
  "...kBbbbbbbBk...",
  "...kBbbbbbbBk...",
  "...kBbbnbbbBk...",
  "...kBBbbbbBBk...",
  "....kBBBBBBk....",
  "...kUuuuuuuUk...",
  "..kiUUuuuuUUik..",
  "..kikUuuuuUkik..",
  "...kkBnnnnBkk...",
  "....kRRRRRRk....",
  "....kRRkkRRk....",
  "....kBBk.kBBk...",
  ".....kk...kk....",
];
const HERO_UP_STEP = [...HERO_UP.slice(0, 12), "....kRRRRRRk....", "....kRk.kRRk....", "...kBk..kBBk....", "....k....kk....."];
const HERO_SIDE = [
  "................",
  ".....kkkkkk.....",
  "....kBBBBBBk....",
  "...kBbbbbbBBk...",
  "...kBbbbiiiik...",
  "...kBbbiikikk...",
  "....kBbiiiiik...",
  ".....kiiiIIk....",
  "....kUuuuuUk....",
  "....kUuvuuUk....",
  "....kUuuuiik....",
  "....kBnnaBkk....",
  ".....kRRRRk.....",
  ".....kRkkRk.....",
  ".....kBk.kBk....",
  "......k...k.....",
];
const HERO_SIDE_STEP = [...HERO_SIDE.slice(0, 12), ".....kRRRRk.....", "....kRk..kRk....", "...kBk....kBk...", "....k......k...."];

const INFANTRY = [
  "................",
  "......kkkk......",
  ".....kqqrRk.....",
  ".....kqrrRk.....",
  ".....kkiikk...k.",
  "......kiik...kqk",
  "....kkuUUk..kqk.",
  "...kRqkuvUkkqk..",
  "...kRqkuuUikk...",
  "...kRqkUuUk.....",
  "....kkkBaBk.....",
  ".....kRRRRk.....",
  ".....kRk.kRk....",
  ".....kBk.kBk....",
  "......k...k.....",
  "................",
];
const INFANTRY_HIT = INFANTRY.map((r, y) => (y >= 3 && y <= 8 ? r.slice(0, 11) + ["kkkk.", ".kqqk", "..kqq", "...kk", ".....", "....."][y - 3] : r));
const ARCHER = [
  "................",
  "......kkkk......",
  ".....kuuuUk.....",
  "....kuuiiUk..k..",
  "....kUiikik.kbk.",
  ".....kiiiik.kbk.",
  "....kkuUUk..k.bk",
  "...kbkuvUkkkk.bk",
  "...kbkuuUiiq..bk",
  "...kbkUuUk.k.bk.",
  "....kkkBaBk.kbk.",
  ".....kRRRRk..k..",
  ".....kRk.kRk....",
  ".....kBk.kBk....",
  "......k...k.....",
  "................",
];
const ARCHER_HIT = ARCHER.map((r, y) => (y === 8 ? "...kbkuuUiiqqqqk" : r));
const TANK = [
  "......kkkk......",
  ".....kjuuk......",
  "....kqqqqRk.....",
  "....kqrrrRk.....",
  "....kkRkkRk.....",
  "...kkqrrrRkk....",
  "..kqqkqqrrRRk...",
  ".kqrrrkqrrRRRk..",
  ".kquurkrrRRRRk..",
  ".kquvrkqrrRRk...",
  ".kqurrkkRRRk....",
  ".kqrrrk.kRRk....",
  "..kkkk.kRRRRk...",
  "......kRRkkRRk..",
  "......kQQk.kQQk.",
  ".......kk...kk..",
];
const TANK_HIT = TANK.map((r, y) => (y >= 6 && y <= 11 ? ".." + r.slice(0, 14) : r));
const CAVALRY = [
  "........kkkk........",
  ".......kqqrk........",
  ".......kiikk........",
  "......kkuuUk....k...",
  ".....kqkuvUkk..kqk..",
  "......kkUuUkk.kqk...",
  ".kk..kkkBBBkkkqk....",
  "kbnk.knnnnnnbbkk....",
  "kbbbknnnnnnnnbbk.kk.",
  ".kbkknnnnnnnnnbbkbnk",
  "..k.knnnnnnnnnnbbbk.",
  "....kbnbkkkkkbnbkk..",
  "....kbbk....kbbk....",
  "....kbk......kbk....",
  "....kBk......kBk....",
  ".....k........k.....",
];
const CAVALRY_HIT = CAVALRY.map((r, y) => (y >= 12 ? ["...kbbk......kbbk...", "..kbk..........kbk..", "..kBk..........kBk..", "...k............k..."][y - 12] : r));
const SIEGE = [
  "....................",
  ".kk.................",
  "krrk................",
  "kRrRkk..............",
  ".kkbbbkk............",
  "....kbbbkk......kuk.",
  "......kbbbkk....kuuk",
  "........kbbbkk..kuk.",
  "..........kbbbk.kk..",
  "....kkkkkkkkbbbkk...",
  "...kbnnnnnnnnnnbbk..",
  "...kbbbbbbbbbbbbbk..",
  "..kRk.kkk...kkk.kRk.",
  "..kQk.kRk...kRk.kQk.",
  "...k...k.....k...k..",
  "....................",
];
const SIEGE_HIT = SIEGE.map((r, y) => (y <= 8 ? ["....................", "....................", "........kk..........", ".......krrk.........", ".......kRRk.........", "........kbk.....kuk.", ".......kbbk.....kuuk", "......kbbk......kuk.", ".....kbbk.......kk.."][y] : r));
const WATCHTOWER_DEF = tower({ roof: "red", w: 12, wall: 14, seed: 41 });

const WAYSTONE = [
  "....kkk.....",
  "...kqrRk....",
  "..kqrrrRk...",
  "..kqrcrRk...",
  "..kqcCcRk...",
  "..kqrcrRk...",
  "..kqrrrRk...",
  "..kqrrrRk...",
  "..kqrcrRk...",
  "..kqrrrRk...",
  "..kqrrrRk...",
  ".kqqrrrRRk..",
  "kRRRRRRRRRk.",
  "kkkkkkkkkkk.",
];
const WAYSTONE_LIT = WAYSTONE.map((r) => r.replace(/c/g, "C").replace(/C(?=C)/, "x"));

const PALM = [
  "...kk....kk.....",
  "..kTtk..ktTk....",
  ".kTttkkkkttFk...",
  "kTtk.ktTtk.kFk..",
  "kk..kTtttTk..kk.",
  "...kTtkbktTk....",
  "..kTk.kbk.kFk...",
  "..kk..knk..kk...",
  "......knk.......",
  "......kbnk......",
  ".......knk......",
  ".......kbk......",
  ".......knk......",
  "......kbnk......",
  "......knbk......",
  ".....kbnbk......",
  ".....kkkkk......",
];
const CACTUS = [
  "....kk....",
  "...kTtk...",
  "...kttk.k.",
  ".k.kttkkTk",
  "kTkkttkttk",
  "kTtkttktFk",
  "kttktFkkk.",
  ".kkttFk...",
  "...ktFk...",
  "...ktFk...",
  "...kFFk...",
  "...kkkk...",
];
const DEADTREE = [
  "..k.....k...",
  ".kbk...kbk..",
  "..kbk.kbk.k.",
  "...kbkbk.kbk",
  ".k..kbbkkbk.",
  "kbkkkbbbbk..",
  ".kbbbbbk....",
  "...kbbBk....",
  "....kbBk....",
  "....kbBk....",
  "....kbBk....",
  "...kbbBBk...",
  "..kkkkkkkk..",
];
const BUSH = (() => {
  const g = grid(13, 9);
  blob(g, [[6.5, 5.5, 5], [3.5, 6, 3.4], [9.5, 6, 3.4]], ["T", "t", "F", "f"], 77, { sparkle: "H" });
  return { w: 13, h: 9, px: toRows(outline(g, "f")), ax: 0.5, ay: 1 };
})();
const MINE = [
  "......kkkkkkkk......",
  "....kknnnnnnnnkk....",
  "...knnbbbbbbbbnnk...",
  "..knbbkkkkkkkkbbnk..",
  "..knbkZZZZZZZZkbnk..",
  ".knbkZZZZZZZZZZkbnk.",
  ".knbkZZZZZZZZZZkbnk.",
  ".kbbkZZZZaZZZZZkbbk.",
  "kdbbkZZZaaaZZZZkbbDk",
  "kddbkZZkRRkZZZZkbDDk",
  "kdddkZkRkkRkZZZkDDDk",
  "kkkkkkkkkkkkkkkkkkkk",
];
const ICONS = {
  coin: ["..kkkk..", ".kzaaak.", "kzaAaaAk", "kaaAzaAk", "kaaAzaAk", "kaAaaAAk", ".kAAAAk.", "..kkkk.."],
  crystal: ["...kk...", "..kmmk..", ".kmxmpk.", "kmmmppPk", "kmmppPPk", ".kmpPPk.", "..kpPk..", "...kk..."],
  trophy: ["kkkkkkkk", "kazzaaAk", "kkaaaAkk", ".kaaaAk.", "..kaAk..", "...kk...", "..kAAk..", ".kkkkkk."],
  sword: [".....kkk", "....kqxk", "...kqxk.", "k.kqxk..", "kkqxk...", ".kAk....", "kAkkk...", "kk......"],
  shield: ["kkkkkkkk", "kuuvvuUk", "kuuvvuUk", "kvvvvvvk", "kuuvvuUk", ".kuvvUk.", "..kvUk..", "...kk..."],
  scroll: [".kkkkkk.", "kNyyyyNk", ".kyBByk.", ".kyyyyk.", ".kyBByk.", ".kyyyyk.", "kNyyyyNk", ".kkkkkk."],
  hourglass: ["kkkkkkkk", ".kyyyyk.", "..kssk..", "...kk...", "...kk...", "..kysk..", ".kssssk.", "kkkkkkkk"],
  skull: [".kkkkk..", "kxxxxxk.", "kxkxkxk.", "kxxxxxk.", ".kxkxk..", ".kkkkk..", "........", "........"],
  crown: ["k..k..k.", "kakakak.", "kaaaaak.", "kazazak.", "kaaaaak.", "kkkkkkk.", "........", "........"],
  star: ["...kk...", "...kak..", "kkkaakkk", "kazaaaak", ".kaaaak.", ".kaAAak.", "kaAkkAak", "kkk..kkk"],
  lock: ["..kkkk..", ".kRkkRk.", ".kRk.kR.", "kkkkkkkk", "kaaaaaAk", "kaaAkaAk", "kaaaaaAk", "kkkkkkkk"],
  check: [".......k", "......kG", ".....kGk", "k...kGk.", "kGk.kGk.", ".kGkGk..", "..kGGk..", "...kk..."],
  map: ["kkkkkkkk", "kyNyyNyk", "kyjyNyyk", "kNyyyjNk", "kyyNyyyk", "kyNyjyNk", "kNyyyyyk", "kkkkkkkk"],
  castle: ["k.k..k.k", "kkk..kkk", "krkkkkRk", "krrrrrRk", "krrkkrRk", "krrkkrRk", "krrkkrRk", "kkkkkkkk"],
  helmet: ["..kkkk..", ".kqqqRk.", "kqqrrRRk", "kqrrrRRk", "kkkkkkkk", "kqkRRkRk", "kqk..kRk", "kk....kk"],
  person: ["..kkkk..", ".kiiiik.", ".kikkik.", ".kiiiik.", "..kkkk..", ".kuuuuk.", "kuuuuuuk", "kkkkkkkk"],
  flag: ["kkkkk...", "kjjjjk..", "kjJjjjk.", "kjjjjk..", "kkkkk...", "k.......", "k.......", "k......."],
  swords: ["k......k", "kq....qk", ".kq..qk.", "..kqqk..", "..kqqk..", ".kAkkAk.", "kAk..kAk", "kk....kk"],
  eye: ["........", "..kkkk..", ".kxxxxk.", "kxxkkxxk", "kxxkuxxk", ".kxxxxk.", "..kkkk..", "........"],
  chest: [".kkkkkk.", "kbbbbbbk", "kbnnnnbk", "kkkaakkk", "kbbaabbk", "kbnnnnbk", "kbbbbbbk", "kkkkkkkk"],
  bolt: ["....kkk.", "...kaak.", "..kaak..", ".kaaakk.", "kkkaaak.", "..kaak..", ".kaak...", ".kkk...."],
  pin: ["..kkkk..", ".kjjjjk.", "kjjxxjjk", "kjjxxjjk", ".kjjjjk.", "..kjjk..", "...kk...", "........"],
};

// ── Assemble ──────────────────────────────────────────────────────────
const S = {};
for (let i = 0; i < 4; i++) S[`oak${i}`] = roundTree(100 + i);
for (let i = 0; i < 3; i++) S[`willow${i}`] = roundTree(200 + i, ["t", "F", "f", "Z"], "T");
for (let i = 0; i < 3; i++) S[`pine${i}`] = pineTree(300 + i);
for (let i = 0; i < 3; i++) S[`snowpine${i}`] = pineTree(400 + i, true);
for (let i = 0; i < 3; i++) S[`rock${i}`] = rock(500 + i);
S.snowrock = rock(520, ["l", "q", "r", "R"], 13, 10, true);
S.badrock = rock(530, ["N", "n", "d", "D"]);
for (let i = 0; i < 4; i++) S[`peak${i}`] = peak(600 + i, ["N", "n", "b", "B"]);
for (let i = 0; i < 3; i++) S[`snowpeak${i}`] = peak(620 + i, ["q", "r", "R", "Q"], true);
for (let i = 0; i < 3; i++) S[`redpeak${i}`] = peak(640 + i, ["d", "D", "b", "B"]);
for (let i = 0; i < 3; i++) S[`sandpeak${i}`] = peak(660 + i, ["y", "s", "S", "n"]);
S.palm = sprite(PALM);
S.cactus = sprite(CACTUS);
S.deadtree = sprite(DEADTREE);
S.bush = BUSH;
S.hero_down_0 = sprite(HERO_DOWN);
S.hero_down_1 = sprite(HERO_DOWN_STEP);
S.hero_up_0 = sprite(HERO_UP);
S.hero_up_1 = sprite(HERO_UP_STEP);
S.hero_right_0 = sprite(HERO_SIDE);
S.hero_right_1 = sprite(HERO_SIDE_STEP);
S.hero_left_0 = mirror(S.hero_right_0);
S.hero_left_1 = mirror(S.hero_right_1);
const UNITS = { infantry: [INFANTRY, INFANTRY_HIT], archer: [ARCHER, ARCHER_HIT], tank: [TANK, TANK_HIT], cavalry: [CAVALRY, CAVALRY_HIT], siege: [SIEGE, SIEGE_HIT] };
for (const [k, [a, b]] of Object.entries(UNITS)) {
  S[`${k}_0`] = sprite(a);
  S[`${k}_1`] = sprite(b);
  S[`${k}_red_0`] = mirror(recolor(S[`${k}_0`], TEAM_RED));
  S[`${k}_red_1`] = mirror(recolor(S[`${k}_1`], TEAM_RED));
}
S.tower_def = WATCHTOWER_DEF;
S.tower_def_red = recolor(WATCHTOWER_DEF, {});
S.tower_red = tower({ roof: "red", w: 14, wall: 15, seed: 51 });
S.tower_blue = tower({ roof: "blue", w: 14, wall: 15, seed: 52 });
S.tower_purple = tower({ roof: "purple", w: 12, wall: 22, seed: 53 });
S.tower_gold = tower({ roof: "gold", w: 16, wall: 16, seed: 54 });
S.tower_ruin = tower({ roof: "none", w: 14, wall: 13, ruined: true, seed: 55 });
S.tower_stone = tower({ roof: "none", w: 16, wall: 18, seed: 56, flag: false });
S.house = house({ roof: "red" });
S.house_blue = house({ roof: "blue", seed: 5 });
S.house_snow = house({ roof: "blue", snowy: true, seed: 6 });
S.house_purple = house({ roof: "purple", seed: 7, wallTone: "y" });
S.house_gold = house({ roof: "gold", seed: 8, wallTone: "q", w: 40 });
S.castle = castle();
S.tent_red = tent("red");
S.tent_blue = tent("blue");
S.tent_gold = tent("gold");
S.colosseum = colosseum();
S.mine = sprite(MINE);
S.waystone = sprite(WAYSTONE);
S.waystone_lit = sprite(WAYSTONE_LIT);
for (const [k, v] of Object.entries(ICONS)) S[`icon_${k}`] = sprite(v, 0, 0);

export const SPRITES = S;
