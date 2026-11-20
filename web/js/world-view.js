// The overworld: camera, hero movement, y-sorted objects, bounty camps, boss lairs and interaction.
import { astar, FOG_CELL, FOG_H, FOG_W, isDecal, SIGHT, TILE, REALMS } from "/shared/world.js";
import { rand2 } from "/shared/rng.js";
import { objectSprite, spriteCanvas, Terrain } from "./terrain.js";

const SPEED = 9 * TILE; // px per second (Shift to sprint)
const FOOT_W = 8;
const FOOT_H = 5;

const CAMP_LOOK = {
  common: [["tower_red", 0, 0]],
  rare: [["tower_blue", -6, 0], ["tent_blue", 12, 2]],
  epic: [["tent_red", -18, 3], ["tower_gold", 0, 0], ["tent_gold", 18, 3]],
};
const STATUS_ICON = { upcoming: "hourglass", active: "swords", revealed: "scroll", resolved: "check" };
// How big each boss tier stands on the map, and what its lair looks like.
const LAIR_LOOK = {
  common: { scale: 1, aura: null, props: "stones" },
  rare: { scale: 1.5, aura: "123,168,242", props: "bones" },
  epic: { scale: 2, aura: "196,155,242", props: "palisade" },
  legendary: { scale: 3, aura: "226,60,60", props: "arena" },
};
const LAIR_COLOR = { common: "#a3a3b3", rare: "#4f8ee0", epic: "#8f52d4", legendary: "#f6c33b" };

export class WorldView {
  constructor(canvas, world, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.world = world;
    this.hooks = hooks;
    this.terrain = new Terrain(world);
    this.zoom = 3;
    this.hero = { x: world.spawn.x * TILE + 8, y: world.spawn.y * TILE + 14, dir: "down", moving: false, anim: 0 };
    this.cam = { x: this.hero.x, y: this.hero.y, free: false };
    this.keys = new Set();
    this.path = null;
    this.camps = [];
    this.campTiles = new Map();
    this.lairs = [];
    this.lairTiles = new Map();
    this.shakeUntil = 0;
    this.attuned = new Set();
    this.explored = new Uint8Array(FOG_W * FOG_H);
    this.near = null;
    this.time = 0;
    this.shadow = makeShadow();
    this.structuresByRow = new Map();
    for (const s of world.structures) this.addRow(this.structuresByRow, s.y, { kind: "structure", s });
    this.bindInput();
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  addRow(map, row, item) {
    if (!map.has(row)) map.set(row, []);
    map.get(row).push(item);
  }

  resize() {
    const dpr = Math.max(1, Math.round(devicePixelRatio || 1));
    this.dpr = dpr;
    this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
    this.ctx.imageSmoothingEnabled = false;
  }

  get scale() {
    return this.zoom * this.dpr;
  }

  setCamps(camps) {
    this.camps = camps;
    this.campTiles = new Map(camps.map((c) => [c.y * this.world.W + c.x, c]));
    this.campsByRow = new Map();
    for (const c of camps) this.addRow(this.campsByRow, c.y, { kind: "camp", c });
    this.unstick();
  }

  /**
   * If the hero stands where something solid now is (a camp or lair that loaded after they were
   * placed), step them to the nearest open tile. Otherwise every direction is blocked and they freeze.
   */
  unstick() {
    const h = this.hero;
    if (this.footFree(h.x, h.y)) return;
    const tx = Math.floor(h.x / TILE);
    const ty = Math.floor((h.y - 2) / TILE);
    for (let r = 1; r < 12; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = (tx + dx) * TILE + 8;
          const y = (ty + dy) * TILE + 14;
          if (this.footFree(x, y) && this.world.reachable[(ty + dy) * this.world.W + tx + dx]) {
            h.x = x;
            h.y = y;
            this.path = null;
            return;
          }
        }
  }

  /** Boss lairs the player has found: [{ id, tier, x, y, readyAt, name }]. */
  setLairs(lairs) {
    this.lairs = lairs;
    this.lairTiles = new Map(lairs.map((l) => [l.y * this.world.W + l.x, l]));
    this.lairsByRow = new Map();
    for (const l of lairs) this.addRow(this.lairsByRow, l.y, { kind: "lair", l });
    this.unstick();
  }

  /** Shake the camera for a moment (a legendary boss is near). */
  shake(ms = 700) {
    this.shakeUntil = performance.now() + ms;
  }

  /** Your own fortress on the world map. */
  setHome(home, keep = 1) {
    if (!home) return;
    const changed = !this.home || this.home.x !== home.x || this.home.y !== home.y || this.homeKeep !== keep;
    this.home = home;
    this.homeKeep = keep;
    if (changed) {
      this.homeTile = home.y * this.world.W + home.x;
      this.homeByRow = new Map([[home.y, [{ kind: "home" }]]]);
    }
  }

  setAttuned(list) {
    this.attuned = new Set(list);
  }

  setExplored(bytes) {
    if (bytes && bytes.length === this.explored.length) this.explored.set(bytes);
  }

  teleport(tx, ty) {
    // land on the nearest walkable tile
    if (!this.walkable(tx, ty))
      search: for (let r = 1; r < 40; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            if (this.walkable(tx + dx, ty + dy) && this.world.reachable[(ty + dy) * this.world.W + tx + dx]) {
              tx += dx;
              ty += dy;
              break search;
            }
          }
    this.hero.x = tx * TILE + 8;
    this.hero.y = ty * TILE + 14;
    this.cam.x = this.hero.x;
    this.cam.y = this.hero.y;
    this.cam.free = false;
    this.path = null;
    this.reveal(true);
  }

  // ── Walking ─────────────────────────────────────────────────────────
  walkable(tx, ty) {
    const w = this.world;
    if (tx < 0 || ty < 0 || tx >= w.W || ty >= w.H) return false;
    const i = ty * w.W + tx;
    return w.walk[i] === 1 && !this.campTiles.has(i) && !this.lairTiles.has(i) && i !== this.homeTile;
  }

  footFree(x, y) {
    const x0 = Math.floor((x - FOOT_W / 2) / TILE);
    const x1 = Math.floor((x + FOOT_W / 2 - 1) / TILE);
    const y0 = Math.floor((y - FOOT_H) / TILE);
    const y1 = Math.floor((y - 1) / TILE);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (!this.walkable(tx, ty)) return false;
    return true;
  }

  /** Walk to a tile along the shortest path. Returns false if there's no way there. */
  setCourse(tx, ty, { far = false } = {}) {
    const w = this.world;
    const start = Math.floor((this.hero.y - 2) / TILE) * w.W + Math.floor(this.hero.x / TILE);
    // aim for the nearest walkable tile to the target
    let goal = -1;
    for (let r = 0; r < 5 && goal < 0; r++)
      for (let dy = -r; dy <= r && goal < 0; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.walkable(tx + dx, ty + dy)) {
            goal = (ty + dy) * w.W + tx + dx;
            break;
          }
        }
    if (goal < 0) return false;
    const path = astar(w.W, w.H, start, goal, (i) => (w.walk[i] === 1 && !this.campTiles.has(i) && !this.lairTiles.has(i) && i !== this.homeTile ? 1 : Infinity), {
      diagonal: true,
      maxNodes: far ? w.W * w.H : 40000,
    });
    if (!path) return false;
    this.path = path.slice(1).map((i) => ({ x: (i % w.W) * TILE + 8, y: Math.floor(i / w.W) * TILE + 12 }));
    this.cam.free = false;
    this.pathTarget = { tx, ty };
    return true;
  }

  update(dt) {
    this.time += dt;
    const h = this.hero;
    let vx = 0;
    let vy = 0;
    const k = this.keys;
    if (k.has("ArrowLeft") || k.has("a")) vx -= 1;
    if (k.has("ArrowRight") || k.has("d")) vx += 1;
    if (k.has("ArrowUp") || k.has("w")) vy -= 1;
    if (k.has("ArrowDown") || k.has("s")) vy += 1;
    const sprint = k.has("Shift") ? 1.7 : 1;
    if (vx || vy) {
      this.path = null;
      this.cam.free = false;
    } else if (this.path?.length) {
      const p = this.path[0];
      const dx = p.x - h.x;
      const dy = p.y - h.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 2) {
        this.path.shift();
        if (!this.path.length) {
          this.path = null;
          this.hooks.onArrive?.(this.pathTarget);
        }
      } else {
        vx = dx / dist;
        vy = dy / dist;
      }
    }
    h.moving = !!(vx || vy);
    if (h.moving) {
      const len = Math.hypot(vx, vy);
      const step = (SPEED * sprint * dt) / len;
      const nx = h.x + vx * step;
      const ny = h.y + vy * step;
      if (this.footFree(nx, h.y)) h.x = nx;
      else if (this.path) h.x = nx; // paths are pre-checked; allow sliding around corners
      if (this.footFree(h.x, ny)) h.y = ny;
      else if (this.path) h.y = ny;
      if (Math.abs(vx) > Math.abs(vy)) h.dir = vx > 0 ? "right" : "left";
      else h.dir = vy > 0 ? "down" : "up";
      h.anim += dt;
      this.revealTimer = (this.revealTimer ?? 0) + dt;
      if (this.revealTimer > 0.25) {
        this.revealTimer = 0;
        this.reveal();
      }
    }
    if (!this.cam.free) {
      this.cam.x += (h.x - this.cam.x) * Math.min(1, dt * 8);
      this.cam.y += (h.y - this.cam.y) * Math.min(1, dt * 8);
    }
    this.checkNear();
  }

  /** Mark fog cells around the hero as explored. */
  reveal(force = false) {
    const tx = this.hero.x / TILE;
    const ty = this.hero.y / TILE;
    const fresh = [];
    const r = SIGHT;
    for (let cy = Math.floor((ty - r) / FOG_CELL); cy <= Math.floor((ty + r) / FOG_CELL); cy++)
      for (let cx = Math.floor((tx - r) / FOG_CELL); cx <= Math.floor((tx + r) / FOG_CELL); cx++) {
        if (cx < 0 || cy < 0 || cx >= FOG_W || cy >= FOG_H) continue;
        const mx = (cx + 0.5) * FOG_CELL;
        const my = (cy + 0.5) * FOG_CELL;
        if ((mx - tx) ** 2 + (my - ty) ** 2 > (r + 4) ** 2) continue;
        const i = cy * FOG_W + cx;
        if (!this.explored[i]) {
          this.explored[i] = 1;
          fresh.push(i);
        }
      }
    if (fresh.length || force) this.hooks.onExplore?.(fresh, { x: Math.floor(tx), y: Math.floor((this.hero.y - 2) / TILE) });
  }

  checkNear() {
    const h = this.hero;
    let best = null;
    let bd = 2.6 * TILE;
    for (const c of this.camps) {
      const d = Math.hypot(c.x * TILE + 8 - h.x, c.y * TILE + 12 - h.y);
      if (d < bd) {
        bd = d;
        best = { kind: "camp", camp: c };
      }
    }
    for (const l of this.lairs) {
      // big bosses can be reached from further away
      const reach = (LAIR_LOOK[l.tier]?.scale ?? 1) - 1;
      const d = Math.hypot(l.x * TILE + 8 - h.x, l.y * TILE + 12 - h.y) - reach * TILE;
      if (d < bd) {
        bd = d;
        best = { kind: "lair", lair: l };
      }
    }
    if (this.home) {
      const d = Math.hypot(this.home.x * TILE + 8 - h.x, this.home.y * TILE + 12 - h.y);
      if (d < bd) {
        bd = d;
        best = { kind: "home" };
      }
    }
    for (const t of this.world.towns) {
      const d = Math.hypot(t.x * TILE + 8 - h.x, (t.y - 1) * TILE + 12 - h.y);
      if (d < bd) {
        bd = d;
        best = { kind: "waystone", town: t };
      }
    }
    const key = best ? (best.camp?.id ?? best.lair?.id ?? best.town?.name ?? best.kind) : null;
    if (key !== this.nearKey) {
      this.nearKey = key;
      this.near = best;
      this.hooks.onNear?.(best);
    }
  }

  interact() {
    if (this.near) this.hooks.onInteract?.(this.near);
  }

  // ── Input ───────────────────────────────────────────────────────────
  bindInput() {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (this.paused) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) e.preventDefault();
      this.keys.add(k);
      if (k === "e" || k === " " || k === "Enter") this.interact();
      if (k === "+" || k === "=") this.zoomBy(1);
      if (k === "-") this.zoomBy(-1);
      if (k === "c") this.cam.free = false;
    });
    addEventListener("keyup", (e) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.delete(k);
    });
    addEventListener("blur", () => this.keys.clear());
    let drag = null;
    this.canvas.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
      if (drag.moved) {
        this.cam.free = true;
        this.cam.x = drag.cx - dx / this.zoom;
        this.cam.y = drag.cy - dy / this.zoom;
      }
    });
    this.canvas.addEventListener("pointerup", (e) => {
      if (drag && !drag.moved) this.click(e.clientX, e.clientY);
      drag = null;
    });
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
  }

  zoomBy(d) {
    this.zoom = Math.max(2, Math.min(5, this.zoom + d));
  }

  screenToWorld(cx, cy) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: this.cam.x + (cx - rect.left - rect.width / 2) / this.zoom, y: this.cam.y + (cy - rect.top - rect.height / 2) / this.zoom };
  }

  click(cx, cy) {
    if (this.paused) return;
    const p = this.screenToWorld(cx, cy);
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    // clicked a camp (its sprite rises above its tile)?
    for (const c of this.camps) {
      if (Math.abs(tx - c.x) <= 1 && ty <= c.y && ty >= c.y - 2) {
        if (this.near?.camp?.id === c.id) return this.interact();
        this.setCourse(c.x, c.y + 1);
        this.pendingCamp = c.id;
        return;
      }
    }
    for (const l of this.lairs) {
      const sc = LAIR_LOOK[l.tier]?.scale ?? 1;
      if (Math.abs(tx - l.x) <= Math.ceil(sc) && ty <= l.y && ty >= l.y - Math.ceil(1.6 * sc)) {
        if (this.near?.lair?.id === l.id) return this.interact();
        this.setCourse(l.x, l.y + 1);
        this.pendingLair = l.id;
        return;
      }
    }
    if (this.home && Math.abs(tx - this.home.x) <= 1 && ty <= this.home.y && ty >= this.home.y - 2) {
      if (this.near?.kind === "home") return this.interact();
      this.setCourse(this.home.x, this.home.y + 1);
      return;
    }
    for (const t of this.world.towns) {
      if (tx === t.x && (ty === t.y - 1 || ty === t.y - 2)) {
        if (this.near?.town === t) return this.interact();
        this.setCourse(t.x, t.y);
        return;
      }
    }
    this.pendingCamp = null;
    this.pendingLair = null;
    this.setCourse(tx, ty);
  }

  // ── Drawing ─────────────────────────────────────────────────────────
  draw() {
    const { ctx, canvas } = this;
    const s = this.scale;
    const W = canvas.width;
    const H = canvas.height;
    const camX = Math.round(this.cam.x);
    const camY = Math.round(this.cam.y);
    let ox = Math.round(W / 2 - camX * s);
    let oy = Math.round(H / 2 - camY * s);
    if (performance.now() < this.shakeUntil) {
      ox += Math.round((Math.random() - 0.5) * 4 * s);
      oy += Math.round((Math.random() - 0.5) * 3 * s);
    }
    ctx.imageSmoothingEnabled = false;
    // animated ocean
    const frame = ((Math.floor(this.time * 3) % 4) + 4) % 4;
    const pat = ctx.createPattern(this.terrain.ocean[frame], "repeat");
    pat.setTransform(new DOMMatrix([s, 0, 0, s, ox % (64 * s), oy % (64 * s)]));
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W, H);
    // ground chunks
    const view = { x0: camX - W / 2 / s, y0: camY - H / 2 / s, x1: camX + W / 2 / s, y1: camY + H / 2 / s };
    const CS = 32 * TILE;
    for (let cy = Math.max(0, Math.floor(view.y0 / CS)); cy <= Math.min(this.world.H / 32 - 1, Math.floor(view.y1 / CS)); cy++)
      for (let cx = Math.max(0, Math.floor(view.x0 / CS)); cx <= Math.min(this.world.W / 32 - 1, Math.floor(view.x1 / CS)); cx++) {
        ctx.drawImage(this.terrain.chunk(cx, cy), ox + cx * CS * s, oy + cy * CS * s, CS * s, CS * s);
      }
    // lair grounds (scorched earth, auras, props) sit under everything that stands up
    for (const l of this.lairs) {
      const lx = l.x * TILE;
      const ly = l.y * TILE;
      if (lx > view.x0 - 160 && lx < view.x1 + 160 && ly > view.y0 - 160 && ly < view.y1 + 200) this.drawLairGround(l, ox, oy, s);
    }
    // y-sorted objects, structures, camps and the hero
    const tx0 = Math.max(0, Math.floor(view.x0 / TILE) - 4);
    const tx1 = Math.min(this.world.W - 1, Math.ceil(view.x1 / TILE) + 4);
    const ty0 = Math.max(0, Math.floor(view.y0 / TILE) - 1);
    const ty1 = Math.min(this.world.H - 1, Math.ceil(view.y1 / TILE) + 6);
    const heroRow = Math.floor((this.hero.y - 1) / TILE);
    const W_ = this.world.W;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const ob = this.world.objects[ty * W_ + tx];
        if (!ob || isDecal(ob)) continue;
        const name = objectSprite(this.world, ob, tx, ty);
        if (!name) continue;
        const spr = spriteCanvas(name);
        const jx = Math.floor(rand2(tx, ty, 5) * 3) - 1;
        const bx = tx * TILE + 8 + jx;
        const by = ty * TILE + 15;
        if (name.startsWith("oak") || name.startsWith("pine") || name.startsWith("snowpine") || name.startsWith("willow") || name === "palm")
          ctx.drawImage(this.shadow, ox + (bx - 7) * s, oy + (by - 3) * s, 14 * s, 5 * s);
        ctx.drawImage(spr, ox + Math.round(bx - spr.width * spr.ax) * s, oy + Math.round(by - spr.height * spr.ay + 1) * s, spr.width * s, spr.height * s);
      }
      for (const item of this.structuresByRow.get(ty) ?? []) this.drawStructure(item.s, ox, oy, s);
      for (const item of this.campsByRow?.get(ty) ?? []) this.drawCamp(item.c, ox, oy, s);
      for (const item of this.lairsByRow?.get(ty) ?? []) this.drawLair(item.l, ox, oy, s);
      if (this.homeByRow?.has(ty)) this.drawHome(ox, oy, s);
      if (ty === heroRow) this.drawHero(ox, oy, s);
    }
    // floating camp banners on top of everything
    for (const c of this.camps) this.drawBanner(c, ox, oy, s);
    for (const l of this.lairs) this.drawLairMarker(l, ox, oy, s);
    // course marker
    if (this.path?.length) {
      const last = this.path[this.path.length - 1];
      const b = Math.floor(this.time * 4) % 2;
      ctx.fillStyle = "#fff3a6";
      for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3 - b], [0, 3 + b]]) ctx.fillRect(ox + (last.x + dx) * s, oy + (last.y + dy) * s, s, s);
    }
  }

  drawStructure(st, ox, oy, s) {
    const ctx = this.ctx;
    const realm = REALMS[this.world.realm[st.y * this.world.W + st.x]]?.id;
    let names = [];
    switch (st.kind) {
      case "waystone":
        names = [[this.attuned.has(this.townAt(st)?.name) ? "waystone_lit" : "waystone", 0]];
        break;
      case "house":
        names = [[{ frostpeaks: "house_snow", whisperwood: "house_purple", goldmarsh: "house_blue" }[realm] ?? "house", 0]];
        break;
      case "castle":
        names = [["castle", 0]];
        break;
      case "lodge":
        names = [["house_snow", 0]];
        break;
      case "mine":
        names = [["mine", 0]];
        break;
      case "treasury":
        names = [["house_gold", 0]];
        break;
      case "bazaar":
        names = [["tent_red", -10], ["tent_gold", 10]];
        break;
      case "colosseum":
        names = [["colosseum", 0]];
        break;
      case "magetower":
        names = [["tower_purple", 0]];
        break;
    }
    for (const [name, dx] of names) {
      const spr = spriteCanvas(name);
      const footW = st.w * TILE;
      const x = st.x * TILE + (footW - spr.width) / 2 + dx;
      const y = (st.y + 1) * TILE - spr.height;
      ctx.drawImage(spr, ox + Math.round(x) * s, oy + Math.round(y) * s, spr.width * s, spr.height * s);
    }
  }

  townAt(st) {
    return this.world.towns.find((t) => t.x === st.x && t.y - 1 === st.y);
  }

  drawCamp(c, ox, oy, s) {
    const ctx = this.ctx;
    const look = CAMP_LOOK[c.tier] ?? CAMP_LOOK.common;
    const bx = c.x * TILE + 8;
    const by = c.y * TILE + 15;
    if (c.featured) {
      const pulse = 0.35 + Math.sin(this.time * 3) * 0.15;
      ctx.fillStyle = `rgba(255,243,166,${pulse})`;
      for (let i = -14; i <= 14; i += 2) ctx.fillRect(ox + (bx + i) * s, oy + (by + 1 + (Math.abs(i) > 10 ? -1 : 0)) * s, s * 2, s);
    }
    ctx.drawImage(this.shadow, ox + (bx - 12) * s, oy + (by - 3) * s, 24 * s, 6 * s);
    for (const [name, dx, dy] of look) {
      const spr = spriteCanvas(name);
      ctx.drawImage(spr, ox + Math.round(bx + dx - spr.width / 2) * s, oy + Math.round(by + dy - spr.height + 1) * s, spr.width * s, spr.height * s);
    }
  }

  drawHome(ox, oy, s) {
    const ctx = this.ctx;
    const bx = this.home.x * TILE + 8;
    const by = this.home.y * TILE + 15;
    // a little palisade ring, then the keep for your level
    ctx.fillStyle = "#5c3a1d";
    for (let i = -16; i <= 16; i += 3) {
      ctx.fillRect(ox + (bx + i) * s, oy + (by - 2) * s, 2 * s, 4 * s);
    }
    ctx.drawImage(this.shadow, ox + (bx - 12) * s, oy + (by - 3) * s, 24 * s, 6 * s);
    const name = ["tower_stone", "tower_blue", "tower_gold", "tower_gold", "tower_gold"][Math.min(4, (this.homeKeep ?? 1) - 1)];
    const spr = spriteCanvas(name);
    ctx.drawImage(spr, ox + Math.round(bx - spr.width / 2) * s, oy + Math.round(by - spr.height + 1) * s, spr.width * s, spr.height * s);
    // your banner
    const fx = bx + 9;
    const fy = by - spr.height - 2 + Math.round(Math.sin(this.time * 3) * 1);
    ctx.fillStyle = "#1b1626";
    ctx.fillRect(ox + fx * s, oy + fy * s, s, 16 * s);
    ctx.fillStyle = "#3e74d6";
    ctx.fillRect(ox + (fx + 1) * s, oy + fy * s, 7 * s, 5 * s);
    ctx.fillStyle = "#f6c33b";
    ctx.fillRect(ox + (fx + 3) * s, oy + (fy + 2) * s, 2 * s, s);
  }

  drawBanner(c, ox, oy, s) {
    const ctx = this.ctx;
    const bob = Math.round(Math.sin(this.time * 2.4 + c.x) * 1.5);
    const look = CAMP_LOOK[c.tier] ?? CAMP_LOOK.common;
    const tallest = Math.max(...look.map(([n, , dy]) => spriteCanvas(n).height - dy));
    const x = c.x * TILE + 8;
    const y = c.y * TILE + 15 - tallest - 14 + bob;
    const colors = { upcoming: "#a3a3b3", active: "#e23c3c", revealed: "#f6c33b", resolved: "#5fb83f" };
    // banner body
    ctx.fillStyle = "#1b1626";
    ctx.fillRect(ox + (x - 7) * s, oy + (y - 1) * s, 14 * s, 12 * s);
    ctx.fillStyle = c.entered ? "#3e74d6" : colors[c.status] ?? "#a3a3b3";
    ctx.fillRect(ox + (x - 6) * s, oy + y * s, 12 * s, 10 * s);
    ctx.fillStyle = "#1b1626";
    ctx.fillRect(ox + (x - 1) * s, oy + (y + 11) * s, 2 * s, 3 * s);
    const ic = spriteCanvas(`icon_${STATUS_ICON[c.status] ?? "flag"}`);
    ctx.drawImage(ic, ox + (x - 4) * s, oy + (y + 1) * s, 8 * s, 8 * s);
  }

  drawLairGround(l, ox, oy, s) {
    const ctx = this.ctx;
    const look = LAIR_LOOK[l.tier] ?? LAIR_LOOK.common;
    const cx = l.x * TILE + 8;
    const cy = l.y * TILE + 12;
    const px = (x, y, w, h, c) => {
      ctx.fillStyle = c;
      ctx.fillRect(ox + Math.round(x) * s, oy + Math.round(y) * s, Math.max(1, Math.round(w)) * s, Math.max(1, Math.round(h)) * s);
    };
    if (l.tier === "legendary") {
      // scorched, cracked ground in a wide ring
      for (let dy = -4; dy <= 3; dy++)
        for (let dx = -5; dx <= 5; dx++) {
          const d = Math.hypot(dx, dy * 1.3);
          if (d > 5.2) continue;
          px(cx - 8 + dx * TILE, cy - 12 + dy * TILE, TILE, TILE, `rgba(27,22,38,${(0.42 - d * 0.06).toFixed(2)})`);
          if (rand2(l.x + dx, l.y + dy, 91) > 0.62) px(cx - 4 + dx * TILE + rand2(dx, dy, 3) * 6, cy - 6 + dy * TILE, 6, 1, "rgba(226,60,60,0.55)");
        }
    }
    if (look.aura) {
      const pulse = 0.28 + Math.sin(this.time * (l.tier === "rare" ? 1.5 : 3)) * 0.12;
      const r = 12 * look.scale;
      for (let a = 0; a < 40; a++) {
        const ang = (a / 40) * Math.PI * 2;
        px(cx + Math.cos(ang) * r - 1, cy + Math.sin(ang) * r * 0.45 - 1, 2, 2, `rgba(${look.aura},${pulse.toFixed(2)})`);
      }
    }
    const ring = (n, r, draw) => {
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + 0.3;
        draw(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r * 0.5, i);
      }
    };
    if (look.props === "stones")
      ring(8, 14, (x, y) => {
        px(x - 2, y - 2, 4, 3, "#1b1626");
        px(x - 1, y - 2, 3, 2, "#a3a3b3");
      });
    if (look.props === "bones") {
      ring(6, 18, (x, y, i) => {
        if (i % 2) px(x - 3, y - 1, 6, 2, "#eef4fb");
        else px(x - 1, y - 3, 2, 5, "#eef4fb");
      });
      this.drawFlame(cx + 20, cy - 4, ox, oy, s, 1);
    }
    if (look.props === "palisade") {
      ring(18, 28, (x, y) => {
        px(x - 1, y - 8, 3, 9, "#1b1626");
        px(x, y - 8, 1, 8, "#8a5a2c");
        px(x, y - 9, 1, 1, "#d0d0dc");
      });
      this.drawFlame(cx - 26, cy - 6, ox, oy, s, 1.5);
      this.drawFlame(cx + 26, cy - 6, ox, oy, s, 1.5);
    }
    if (look.props === "arena") {
      ring(14, 46, (x, y, i) => {
        // broken pillars, skull totems and rubble
        if (i % 3 === 0) {
          px(x - 3, y - 14, 7, 15, "#1b1626");
          px(x - 2, y - 13, 5, 13, "#6f6e82");
          px(x - 2, y - 13, 2, 13, "#a3a3b3");
          this.drawFlame(x, y - 15, ox, oy, s, 1.4);
        } else if (i % 3 === 1) {
          px(x - 1, y - 9, 2, 10, "#5c3a1d");
          const sk = spriteCanvas("icon_skull");
          ctx.drawImage(sk, ox + Math.round(x - 4) * s, oy + Math.round(y - 15) * s, 8 * s, 8 * s);
        } else px(x - 4, y - 3, 8, 3, "#6f6e82");
      });
    }
  }

  drawFlame(x, y, ox, oy, s, size = 1) {
    const ctx = this.ctx;
    const f = Math.floor(this.time * 8 + x) % 3;
    const h = Math.round((5 + f) * size);
    ctx.fillStyle = "#1b1626";
    ctx.fillRect(ox + Math.round(x - 2) * s, oy + Math.round(y) * s, 4 * s, 3 * s);
    ctx.fillStyle = "#e23c3c";
    ctx.fillRect(ox + Math.round(x - 1.5 * size) * s, oy + Math.round(y - h) * s, Math.max(1, Math.round(3 * size)) * s, h * s);
    ctx.fillStyle = "#f6c33b";
    ctx.fillRect(ox + Math.round(x - 0.5 * size) * s, oy + Math.round(y - h * 0.6) * s, Math.max(1, Math.round(size)) * s, Math.round(h * 0.6) * s);
  }

  drawLair(l, ox, oy, s) {
    const ctx = this.ctx;
    const look = LAIR_LOOK[l.tier] ?? LAIR_LOOK.common;
    const sc = look.scale;
    // epic and legendary bosses breathe; the rest stand still
    const breathe = l.tier === "epic" || l.tier === "legendary" ? Math.floor(this.time * 1.6 + l.x) % 2 : 0;
    const spr = spriteCanvas(`boss_${l.id}_${breathe}`);
    const bx = l.x * TILE + 8;
    const by = l.y * TILE + 15;
    const w = Math.round(spr.width * sc);
    const h = Math.round(spr.height * sc);
    ctx.drawImage(this.shadow, ox + Math.round(bx - 9 * sc) * s, oy + Math.round(by - 3 * sc) * s, Math.round(18 * sc) * s, Math.round(5 * sc) * s);
    const resting = l.readyAt && l.readyAt > Date.now();
    if (resting) ctx.globalAlpha = 0.55;
    ctx.drawImage(spr, ox + Math.round(bx - w / 2) * s, oy + Math.round(by - h + 1) * s, w * s, h * s);
    ctx.globalAlpha = 1;
    if (l.tier === "legendary") {
      // embers rising around the boss
      for (let i = 0; i < 14; i++) {
        const t = (this.time * 0.5 + rand2(i, l.x, 7)) % 1;
        const x = bx + (rand2(i, l.y, 8) - 0.5) * 70;
        const y = by - t * 80;
        ctx.fillStyle = `rgba(${t < 0.5 ? "246,195,59" : "226,60,60"},${(1 - t).toFixed(2)})`;
        ctx.fillRect(ox + Math.round(x) * s, oy + Math.round(y) * s, s * 2, s * 2);
      }
    }
  }

  drawLairMarker(l, ox, oy, s) {
    const ctx = this.ctx;
    const sc = (LAIR_LOOK[l.tier] ?? LAIR_LOOK.common).scale;
    const bob = Math.round(Math.sin(this.time * 2.4 + l.x) * 1.5);
    const x = l.x * TILE + 8;
    const y = l.y * TILE + 15 - Math.round(24 * sc) - 13 + bob;
    const resting = l.readyAt && l.readyAt > Date.now();
    ctx.fillStyle = "#1b1626";
    ctx.fillRect(ox + (x - 6) * s, oy + (y - 1) * s, 12 * s, 11 * s);
    ctx.fillStyle = resting ? "#6f6e82" : LAIR_COLOR[l.tier];
    ctx.fillRect(ox + (x - 5) * s, oy + y * s, 10 * s, 9 * s);
    const ic = spriteCanvas(`icon_${resting ? "hourglass" : "skull"}`);
    ctx.drawImage(ic, ox + (x - 4) * s, oy + (y + 1) * s, 8 * s, 8 * s);
  }

  drawHero(ox, oy, s) {
    const h = this.hero;
    const f = h.moving ? Math.floor(h.anim * 7) % 2 : 0;
    const spr = spriteCanvas(`hero_${h.dir}_${f}`);
    const bob = h.moving && f ? -1 : 0;
    this.ctx.drawImage(this.shadow, ox + Math.round(h.x - 6) * s, oy + Math.round(h.y - 3) * s, 12 * s, 4 * s);
    this.ctx.drawImage(spr, ox + Math.round(h.x - 8) * s, oy + Math.round(h.y - 15 + bob) * s, 16 * s, 16 * s);
  }

  start() {
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      if (!this.paused) this.update(dt);
      else this.time += dt;
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

function makeShadow() {
  const c = document.createElement("canvas");
  c.width = 14;
  c.height = 5;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(20,30,20,0.28)";
  for (let y = 0; y < 5; y++) {
    const half = Math.round(Math.sqrt(1 - ((y - 2) / 2.6) ** 2) * 7);
    ctx.fillRect(7 - half, y, half * 2, 1);
  }
  return c;
}
