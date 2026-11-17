// Turns palette sprites into canvases (cached) and offers small drawing helpers.
import { PALETTE, SPRITES } from "/shared/sprites.js";

const cache = new Map();

/** Canvas for a sprite (1 canvas pixel per art pixel). */
export function spriteCanvas(name) {
  let c = cache.get(name);
  if (c) return c;
  const s = SPRITES[name];
  if (!s) throw new Error(`unknown sprite ${name}`);
  c = document.createElement("canvas");
  c.width = s.w;
  c.height = s.h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(s.w, s.h);
  for (let y = 0; y < s.h; y++) {
    const row = s.px[y];
    for (let x = 0; x < s.w; x++) {
      const ch = row[x];
      if (ch === "." || ch === undefined) continue;
      const hex = PALETTE[ch];
      if (!hex) continue;
      const o = (y * s.w + x) * 4;
      img.data[o] = parseInt(hex.slice(1, 3), 16);
      img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  c.ax = s.ax ?? 0.5;
  c.ay = s.ay ?? 1;
  cache.set(name, c);
  return c;
}

/** Data URL of a sprite scaled up `scale`× with hard pixels, for use in the DOM. */
const urlCache = new Map();
export function spriteUrl(name, scale = 3) {
  const key = `${name}@${scale}`;
  let u = urlCache.get(key);
  if (u) return u;
  const src = spriteCanvas(name);
  const c = document.createElement("canvas");
  c.width = src.width * scale;
  c.height = src.height * scale;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  u = c.toDataURL();
  urlCache.set(key, u);
  return u;
}

/** <img> markup for an icon sprite. */
export function icon(name, scale = 2, cls = "") {
  return `<img class="px-icon ${cls}" src="${spriteUrl(`icon_${name}`, scale)}" alt="" width="${8 * scale}" height="${8 * scale}">`;
}

/** A pixel-art 9-slice frame for CSS border-image. */
export function frameUrl(kind = "wood") {
  const key = `frame:${kind}`;
  if (urlCache.has(key)) return urlCache.get(key);
  const S = 12;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d");
  const sets = {
    wood: ["#1b1626", "#5c3a1d", "#8a5a2c", "#b98146", "#f3e2b8"],
    stone: ["#1b1626", "#4a4860", "#6f6e82", "#a3a3b3", "#2a2240"],
    gold: ["#1b1626", "#b9861a", "#f6c33b", "#fff3a6", "#f3e2b8"],
    dark: ["#1b1626", "#2a2240", "#3a3348", "#4a4860", "#221c33"],
  };
  const [k, d, m, l, fill] = sets[kind] ?? sets.wood;
  const px = (x, y, col) => {
    ctx.fillStyle = col;
    ctx.fillRect(x, y, 1, 1);
  };
  ctx.fillStyle = fill;
  ctx.fillRect(2, 2, S - 4, S - 4);
  for (let i = 0; i < S; i++) {
    px(i, 0, k);
    px(i, S - 1, k);
    px(0, i, k);
    px(S - 1, i, k);
    px(i, 1, l);
    px(1, i, l);
    px(i, S - 2, d);
    px(S - 2, i, d);
  }
  for (const [x, y] of [[0, 0], [S - 1, 0], [0, S - 1], [S - 1, S - 1]]) ctx.clearRect(x, y, 1, 1);
  px(1, 1, k);
  px(S - 2, 1, k);
  px(1, S - 2, k);
  px(S - 2, S - 2, k);
  px(2, 2, m);
  px(S - 3, 2, m);
  px(2, S - 3, m);
  px(S - 3, S - 3, m);
  const u = c.toDataURL();
  urlCache.set(key, u);
  return u;
}
