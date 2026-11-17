// Paints the ground: every pixel gets its own shade from noise, so the ground never tiles.
// Chunks of 32×32 tiles are painted once and cached. Water pixels stay transparent so the
// animated ocean drawn underneath shows through; cliffs and foam are painted on top.
import { RGB } from "/shared/sprites.js";
import { CHUNK, REALMS, T, TILE, isDecal, isWater, O } from "/shared/world.js";
import { noise2, rand2 } from "/shared/rng.js";
import { spriteCanvas } from "./gfx.js";

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const TONES = {
  [T.GRASS]: [RGB.h, hex("#64be41"), RGB.G],
  [T.MEADOW]: [RGB.H, RGB.h, hex("#64be41")],
  [T.FOREST]: [hex("#4fa83a"), RGB.G, RGB.F],
  [T.BADLANDS]: [hex("#d97b47"), RGB.d, hex("#b0552f")],
  [T.DESERT]: [hex("#f2d999"), RGB.s, hex("#dcb36a")],
  [T.SNOW]: [RGB.x, RGB.l, hex("#d3e1ee")],
  [T.MARSH]: [hex("#7fa05e"), RGB.M, hex("#5f7d45")],
  [T.BEACH]: [RGB.y, RGB.y, RGB.s],
  [T.ROAD]: [RGB.y, RGB.s, RGB.s],
  [T.TOWN]: [RGB.y, RGB.s, RGB.s],
  [T.BRIDGE]: [RGB.n, RGB.b, RGB.B],
};
const MOUNTAIN_TONES = {
  frostpeaks: [RGB.l, RGB.L, RGB.r],
  ironvein: [RGB.d, RGB.D, RGB.B],
  sunscar: [RGB.s, RGB.S, RGB.n],
  default: [RGB.n, RGB.b, RGB.B],
};
const FOAM = RGB.C;
const SHALLOW = RGB.c;

export class Terrain {
  constructor(world) {
    this.world = world;
    this.chunks = new Map();
    this.ocean = makeOceanFrames();
  }

  terr(x, y) {
    const w = this.world;
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return T.DEEP;
    return w.terrain[y * w.W + x];
  }

  tones(t, x, y) {
    if (t === T.MOUNTAIN) {
      const rid = REALMS[this.world.realm[y * this.world.W + x]].id;
      return MOUNTAIN_TONES[rid] ?? MOUNTAIN_TONES.default;
    }
    return TONES[t] ?? TONES[T.GRASS];
  }

  chunk(cx, cy) {
    const key = cx + "," + cy;
    let c = this.chunks.get(key);
    if (c) return c;
    c = this.paint(cx, cy);
    this.chunks.set(key, c);
    if (this.chunks.size > 90) this.chunks.delete(this.chunks.keys().next().value);
    return c;
  }

  paint(cx, cy) {
    const size = CHUNK * TILE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const seed = this.world.seed;
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        const X = x0 + tx;
        const Y = y0 + ty;
        const t = this.terr(X, Y);
        const up = this.terr(X, Y - 1);
        const dn = this.terr(X, Y + 1);
        const lf = this.terr(X - 1, Y);
        const rt = this.terr(X + 1, Y);
        const water = isWater(t);
        const tones = water ? null : this.tones(t, X, Y);
        const nTones = water ? null : [this.tones(up, X, Y - 1), this.tones(dn, X, Y + 1), this.tones(lf, X - 1, Y), this.tones(rt, X + 1, Y)];
        const vertBridge = t === T.BRIDGE && (up === T.ROAD || up === T.BRIDGE || dn === T.ROAD || dn === T.BRIDGE);
        for (let ly = 0; ly < TILE; ly++) {
          for (let lx = 0; lx < TILE; lx++) {
            const wx = X * TILE + lx;
            const wy = Y * TILE + ly;
            const o = ((ty * TILE + ly) * size + tx * TILE + lx) * 4;
            let col = null;
            let alpha = 255;
            if (water) {
              // cliffs below land, foam along every shore
              const r = rand2(wx, 7, seed);
              const cliffH = 6 + (r > 0.6 ? 1 : 0) + (r > 0.9 ? 1 : 0);
              if (!isWater(up) && up !== T.BEACH && ly < cliffH) {
                const stripe = (wx + (ly >> 1)) % 4;
                col = ly === cliffH - 1 ? RGB.B : stripe === 0 ? RGB.n : stripe === 3 ? RGB.B : RGB.b;
                if (ly === 0) col = RGB.B;
              } else if (!isWater(up) && ly < (up === T.BEACH ? 2 : cliffH + 2) && rand2(wx, wy, seed + 5) > 0.35) {
                col = FOAM;
              } else if ((!isWater(lf) && lx < 2) || (!isWater(rt) && lx > 13) || (!isWater(dn) && ly > 13)) {
                col = rand2(wx, wy, seed + 6) > 0.3 ? FOAM : SHALLOW;
              } else if (t === T.WATER) {
                col = SHALLOW;
                alpha = this.world.sea[Y * this.world.W + X] ? 0 : 70; // lakes read lighter; the sea stays deep
              } else {
                alpha = 0;
              }
            } else if (t === T.BRIDGE) {
              const along = vertBridge ? ly : lx;
              const across = vertBridge ? lx : ly;
              if (across < 2 || across > 13) col = across === 0 || across === 15 ? RGB.k : RGB.B;
              else col = along % 4 === 3 ? RGB.B : rand2(wx, wy, seed) > 0.8 ? RGB.n : RGB.b;
            } else {
              const n1 = noise2(wx / 9, wy / 9, seed + 101);
              const n2 = rand2(wx, wy, seed + 102);
              let set = tones;
              // soften borders between different grounds (and give roads ragged edges)
              const edge = Math.min(ly, 15 - ly, lx, 15 - lx);
              if (edge < 4) {
                let nt = -1;
                let dist = 99;
                if (ly < 4 && up !== t && !isWater(up)) (nt = 0), (dist = ly);
                if (15 - ly < dist && 15 - ly < 4 && dn !== t && !isWater(dn)) (nt = 1), (dist = 15 - ly);
                if (lx < dist && lx < 4 && lf !== t && !isWater(lf)) (nt = 2), (dist = lx);
                if (15 - lx < dist && 15 - lx < 4 && rt !== t && !isWater(rt)) (nt = 3), (dist = 15 - lx);
                if (nt >= 0) {
                  const ntype = [up, dn, lf, rt][nt];
                  const fuzz = (4 - dist) / 5 + (noise2(wx / 3, wy / 3, seed + 103) - 0.5) * 0.7;
                  if (t === T.ROAD || t === T.TOWN) {
                    if (ntype !== T.ROAD && ntype !== T.TOWN && ntype !== T.BRIDGE) {
                      if (fuzz > 0.45) set = nTones[nt];
                      else if (fuzz > 0.25) set = [RGB.S, RGB.S, RGB.S];
                    }
                  } else if (ntype === T.ROAD || ntype === T.TOWN || ntype === T.BRIDGE) {
                    // grass side of a road keeps its own colour
                  } else if (rand2(wx, wy, seed + 104) < fuzz * 0.8) set = nTones[nt];
                }
              }
              const n3 = noise2(wx / 3.5, wy / 3.5, seed + 105);
              const v = n1 * 0.55 + n3 * 0.45 + (n2 - 0.5) * 0.14;
              col = v < 0.33 ? set[0] : v < 0.67 ? set[1] : set[2];
              // little grass blades
              if ((t === T.GRASS || t === T.MEADOW || t === T.FOREST) && set === tones && n2 > 0.985) col = set[0];
              if ((t === T.GRASS || t === T.MEADOW || t === T.FOREST) && set === tones && rand2(wx, wy - 1, seed + 102) > 0.985) col = set[2];
              if (t === T.TOWN && set === tones && n2 > 0.97) col = RGB.r;
              // lip of grass above a cliff
              if (isWater(dn) && ly > 13) col = ly === 15 ? RGB.F : tones[2];
            }
            if (col) {
              d[o] = col[0];
              d[o + 1] = col[1];
              d[o + 2] = col[2];
              d[o + 3] = alpha;
            }
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    // flat details: flowers, tufts, reeds, mushrooms, bones
    const w = this.world;
    for (let ty = 0; ty < CHUNK; ty++)
      for (let tx = 0; tx < CHUNK; tx++) {
        const X = x0 + tx;
        const Y = y0 + ty;
        if (X >= w.W || Y >= w.H) continue;
        const ob = w.objects[Y * w.W + X];
        if (!isDecal(ob)) continue;
        drawDecal(ctx, ob, tx * TILE, ty * TILE, rand2(X, Y, seed + 9));
      }
    return canvas;
  }
}

const DECAL_PX = {
  [O.FLOWERS]: [["x", 3, 4], ["a", 4, 4], ["x", 9, 9], ["j", 10, 9], ["x", 12, 3], ["m", 6, 11], ["a", 7, 11], ["G", 4, 5], ["G", 10, 10], ["G", 7, 12]],
  [O.TUFT]: [["G", 4, 8], ["G", 5, 7], ["G", 6, 8], ["G", 10, 12], ["G", 11, 11], ["G", 12, 12], ["h", 5, 6], ["h", 11, 10]],
  [O.REEDS]: [["F", 4, 6], ["F", 4, 7], ["F", 4, 8], ["F", 4, 9], ["b", 4, 5], ["F", 7, 8], ["F", 7, 9], ["F", 7, 10], ["F", 7, 11], ["b", 7, 7], ["F", 11, 5], ["F", 11, 6], ["F", 11, 7], ["F", 11, 8], ["b", 11, 4]],
  [O.MUSHROOM]: [["j", 6, 8], ["j", 7, 8], ["j", 8, 8], ["x", 7, 8], ["j", 5, 9], ["j", 9, 9], ["x", 6, 9], ["j", 7, 9], ["j", 8, 9], ["y", 7, 10], ["y", 7, 11], ["k", 6, 12], ["k", 7, 12], ["k", 8, 12]],
  [O.BONES]: [["x", 5, 9], ["x", 6, 9], ["x", 7, 9], ["x", 8, 9], ["q", 4, 8], ["q", 4, 10], ["q", 9, 8], ["q", 9, 10], ["x", 11, 5], ["q", 12, 5]],
};
function drawDecal(ctx, ob, x, y, r) {
  const px = DECAL_PX[ob];
  if (!px) return;
  const flip = r > 0.5;
  for (const [c, dx, dy] of px) {
    const rgb = RGB[c];
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(x + (flip ? 15 - dx : dx), y + dy, 1, 1);
  }
}

/** Four 64×64 frames of animated ocean. */
function makeOceanFrames() {
  const frames = [];
  for (let f = 0; f < 4; f++) {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(64, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const n = noise2(x / 10, y / 7, 991) * 0.6 + noise2((x + 64) / 10, y / 7, 991) * 0;
        let col = n > 0.62 ? RGB.w : n < 0.3 ? RGB.V : RGB.W;
        // short wave glints drifting right
        const lane = Math.floor(y / 8);
        const phase = (x - f * 2 + lane * 13 + 640) % 32;
        if (y % 8 === 3 && phase < 5 && rand2(lane, Math.floor((x - f * 2 + 640) / 32), 992) > 0.35) col = phase === 0 || phase === 4 ? RGB.w : RGB.c;
        if (y % 8 === 4 && phase > 0 && phase < 4 && rand2(lane, Math.floor((x - f * 2 + 640) / 32), 992) > 0.35) col = RGB.w;
        const o = (y * 64 + x) * 4;
        img.data[o] = col[0];
        img.data[o + 1] = col[1];
        img.data[o + 2] = col[2];
        img.data[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    frames.push(c);
  }
  return frames;
}

/** One pixel per tile: used by the minimap and the world map. */
export function worldThumbnail(world) {
  const c = document.createElement("canvas");
  c.width = world.W;
  c.height = world.H;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(world.W, world.H);
  const COL = {
    [T.DEEP]: hex("#2b5cb8"),
    [T.WATER]: hex("#4f8ee0"),
    [T.BEACH]: RGB.y,
    [T.GRASS]: hex("#64be41"),
    [T.MEADOW]: RGB.h,
    [T.FOREST]: RGB.G,
    [T.BADLANDS]: RGB.d,
    [T.DESERT]: RGB.s,
    [T.SNOW]: RGB.l,
    [T.MARSH]: RGB.M,
    [T.ROAD]: hex("#f0d58c"),
    [T.MOUNTAIN]: RGB.b,
    [T.TOWN]: RGB.r,
    [T.BRIDGE]: RGB.n,
  };
  for (let i = 0; i < world.W * world.H; i++) {
    let col = COL[world.terrain[i]] ?? RGB.g;
    const ob = world.objects[i];
    if (ob && !isDecal(ob) && ob !== O.PEAK) col = col.map((v) => v * 0.7);
    if (world.blocked[i]) col = RGB.e;
    img.data[i * 4] = col[0];
    img.data[i * 4 + 1] = col[1];
    img.data[i * 4 + 2] = col[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** The sprite to draw for an object at a tile. */
export function objectSprite(world, ob, x, y) {
  const r = rand2(x, y, world.seed + 13);
  const rid = REALMS[world.realm[y * world.W + x]].id;
  switch (ob) {
    case O.OAK:
      return `oak${Math.floor(r * 4)}`;
    case O.WILLOW:
      return `willow${Math.floor(r * 3)}`;
    case O.PINE:
      return `pine${Math.floor(r * 3)}`;
    case O.SNOWPINE:
      return `snowpine${Math.floor(r * 3)}`;
    case O.PALM:
      return "palm";
    case O.CACTUS:
      return "cactus";
    case O.DEADTREE:
      return "deadtree";
    case O.BUSH:
      return "bush";
    case O.ROCK:
      return rid === "ironvein" ? "badrock" : `rock${Math.floor(r * 3)}`;
    case O.SNOWROCK:
      return "snowrock";
    case O.PEAK:
      if (rid === "frostpeaks") return `snowpeak${Math.floor(r * 3)}`;
      if (rid === "ironvein") return `redpeak${Math.floor(r * 3)}`;
      if (rid === "sunscar") return `sandpeak${Math.floor(r * 3)}`;
      return `peak${Math.floor(r * 4)}`;
    default:
      return null;
  }
}

export { spriteCanvas };
