// Your fortress: a little pixel courtyard that visibly grows as you upgrade, plus building cards.
import { noise2, rand2 } from "/shared/rng.js";
import { BUILDINGS, UNITS, armyCapacity, unlockedUnits, vaultCapacity } from "/shared/rules.js";
import { RGB } from "/shared/sprites.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteCanvas } from "../gfx.js";
import { act, esc, fmt, openSheet, toast } from "../ui.js";
import { openProfile } from "./profile.js";

const SW = 320;
const SH = 150;
let selected = "keep";

export function openFortress(G, focus) {
  if (focus) selected = focus;
  const m = G.me;
  const b = m.buildings;
  const body = openSheet(
    "fortress",
    `
    <h2>Your Fortress</h2>
    <p class="sub">Gold builds walls and armies. Crystals, earned only from well-calibrated predictions, raise the Keep, and the Keep caps everything else at one level above it.</p>
    <canvas class="fort-scene" id="fort" width="${SW * 3}" height="${SH * 3}" aria-label="Your fortress. Click a building."></canvas>
    <div class="row spread" style="margin:10px 0 4px"><span class="note">${icon("coin", 2)} ${fmt(m.gold)} / ${fmt(m.derived.vaultCap)} gold · ${icon("crystal", 2)} ${fmt(m.crystals)} crystals</span><span class="note">Click a building to focus it</span></div>
    <div class="cards" id="bcards">${Object.keys(BUILDINGS).map((k) => card(G, k)).join("")}</div>
  `,
  );
  drawScene(body.querySelector("#fort"), b);
  body.querySelector("#fort").addEventListener("click", (e) => {
    const rect = e.target.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * SW;
    const y = ((e.clientY - rect.top) / rect.height) * SH;
    const hit = HITS.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    if (hit) {
      selected = hit.k;
      sfx("click");
      openFortress(G);
      body.querySelector(`[data-card="${hit.k}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });
  for (const btn of body.querySelectorAll("[data-up]"))
    btn.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const r = await api("/api/fortress/upgrade", { body: { building: btn.dataset.up } });
        sfx("upgrade");
        toast(`${BUILDINGS[r.building].name} is now level ${r.level}`, "good");
        await G.refreshMe();
        selected = r.building;
        openFortress(G);
      }),
    );
  body.querySelector("[data-trophy]")?.addEventListener("click", () => openProfile(G, "trophies"));
}

function effect(k, lvl) {
  switch (k) {
    case "keep":
      return `Buildings up to level ${lvl}`;
    case "barracks":
      return `Army of ${armyCapacity(lvl)} · ${unlockedUnits(lvl).map((u) => UNITS[u].name).join(", ")}`;
    case "training":
      return `Units train up to level ${lvl}`;
    case "vault":
      return `Holds ${fmt(vaultCapacity(lvl))} gold`;
    case "towers":
      return `${lvl} watchtower${lvl > 1 ? "s" : ""} defend you in bounties`;
    default:
      return "";
  }
}

function card(G, k) {
  const m = G.me;
  const def = BUILDINGS[k];
  const lvl = m.buildings[k] ?? 1;
  const cost = m.derived.nextCosts[k];
  const capped = k !== "keep" && k !== "trophy" && lvl >= m.buildings.keep + 1;
  const afford = cost && m.gold >= (cost.gold ?? 0) && m.crystals >= (cost.crystals ?? 0);
  const btn =
    k === "trophy"
      ? `<button class="btn btn-gold btn-small" data-trophy>Open the Trophy Room</button>`
      : !cost
        ? `<span class="note">Max level</span>`
        : `<button class="btn ${k === "keep" ? "btn-crystal" : "btn-go"} btn-small" data-up="${k}" ${afford && !capped ? "" : "disabled"}>Upgrade<span class="cost">${cost.gold ? `${fmt(cost.gold)}g` : ""}${cost.crystals ? ` + ${cost.crystals}◆` : ""}</span></button>${capped ? `<span class="note">Raise the Keep first</span>` : ""}`;
  return `<div class="card" data-card="${k}" style="${selected === k ? "border-color:var(--wood-d);background:#fdf0c4" : ""}">
    <div class="row spread"><h4>${esc(def.name)}</h4><span class="tag">${k === "trophy" ? "" : `Lv ${lvl}/${def.max}`}</span></div>
    <span class="stats">${esc(def.desc)}</span>
    ${k === "trophy" ? "" : `<span class="stats"><b>Now:</b>&nbsp;${effect(k, lvl)}</span>${cost ? `<span class="stats"><b>Next:</b>&nbsp;${effect(k, lvl + 1)}</span>` : ""}`}
    <div class="row">${btn}</div></div>`;
}

let HITS = [];
function drawScene(canvas, b) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(3, 0, 0, 3, 0, 0);
  // ground (painted at 1×, then scaled up with hard pixels)
  const ground = document.createElement("canvas");
  ground.width = SW;
  ground.height = SH;
  const gctx = ground.getContext("2d");
  const img = gctx.createImageData(SW, SH);
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const yard = x > 34 && x < SW - 34 && y > 34 && y < SH - 10;
      const n = noise2(x / 9, y / 9, 31) * 0.6 + noise2(x / 3, y / 3, 32) * 0.4 + (rand2(x, y, 33) - 0.5) * 0.1;
      const set = yard ? [RGB.y, RGB.s, [216, 173, 98]] : [RGB.h, [100, 190, 65], RGB.G];
      const c = n < 0.33 ? set[0] : n < 0.68 ? set[1] : set[2];
      const o = (y * SW + x) * 4;
      img.data.set([c[0], c[1], c[2], 255], o);
    }
  gctx.putImageData(img, 0, 0);
  ctx.drawImage(ground, 0, 0);
  // walls: wooden palisade, then stone from Keep 3
  const stone = b.keep >= 3;
  const wall = (x0, y0, x1, y1) => {
    for (let x = x0; x <= x1; x += stone ? 1 : 3)
      for (let y = y0; y <= y1; y += stone ? 1 : 3) {
        ctx.fillStyle = stone ? ((x + y) % 5 === 0 ? "#6f6e82" : "#a3a3b3") : "#8a5a2c";
        ctx.fillRect(x, y, stone ? 1 : 2, stone ? 1 : 2);
      }
  };
  ctx.fillStyle = stone ? "#4a4860" : "#5c3a1d";
  ctx.fillRect(30, 28, SW - 60, 6);
  wall(30, 26, SW - 31, 31);
  ctx.fillStyle = "#1b1626";
  ctx.fillRect(30, 33, SW - 60, 1);
  // side walls and a front wall with a gate
  for (const x of [30, SW - 34]) {
    ctx.fillStyle = stone ? "#4a4860" : "#5c3a1d";
    ctx.fillRect(x, 28, 4, SH - 34);
    wall(x, 28, x + 3, SH - 8);
  }
  for (const [x0, x1] of [[30, SW / 2 - 14], [SW / 2 + 14, SW - 31]]) {
    ctx.fillStyle = stone ? "#4a4860" : "#5c3a1d";
    ctx.fillRect(x0, SH - 9, x1 - x0, 5);
    wall(x0, SH - 9, x1, SH - 6);
  }
  const put = (name, cx, by, k) => {
    const s = spriteCanvas(name);
    const x = Math.round(cx - s.width / 2);
    const y = Math.round(by - s.height);
    ctx.fillStyle = "rgba(20,30,20,0.25)";
    ctx.fillRect(x + 2, by - 2, s.width - 4, 3);
    ctx.drawImage(s, x, y);
    if (k) HITS.push({ k, x, y, w: s.width, h: s.height });
  };
  HITS = [];
  // watchtowers on the corners
  const towerSpots = [[34, 40], [SW - 34, 40], [34, SH - 8], [SW - 34, SH - 8], [SW / 2 + 70, 40]];
  for (let i = 0; i < Math.min(b.towers, 5); i++) put("tower_def", towerSpots[i][0], towerSpots[i][1], "towers");
  // keep grows
  const keepSprite = ["tower_stone", "tower_blue", "tower_gold", "castle", "castle"][Math.min(4, b.keep - 1)];
  put(keepSprite, SW / 2, 82, "keep");
  if (b.keep >= 5) {
    ctx.fillStyle = "#f6c33b";
    ctx.fillRect(SW / 2 - 1, 6, 2, 2);
  }
  // barracks
  put(b.barracks >= 2 ? "house" : "tent_red", 78, 112, "barracks");
  if (b.barracks >= 3) put("tent_blue", 56, 128, "barracks");
  if (b.barracks >= 4) put("tent_red", 100, 130, "barracks");
  // training grounds: dummies
  for (let i = 0; i < b.training; i++) {
    const x = 62 + i * 9;
    const y = 140;
    ctx.fillStyle = "#1b1626";
    ctx.fillRect(x - 1, y - 12, 5, 13);
    ctx.fillStyle = "#b98146";
    ctx.fillRect(x, y - 11, 3, 11);
    ctx.fillStyle = "#e0b278";
    ctx.fillRect(x - 2, y - 9, 7, 3);
    ctx.fillStyle = "#e23c3c";
    ctx.fillRect(x + 1, y - 10, 1, 1);
  }
  HITS.push({ k: "training", x: 56, y: 126, w: b.training * 9 + 8, h: 16 });
  // vault
  put(b.vault >= 3 ? "house_gold" : "house_blue", SW - 82, 114, "vault");
  // trophy room
  put("house_purple", SW - 92, 142, "trophy");
  // banner with keep level
  ctx.fillStyle = "#1b1626";
  ctx.fillRect(6, 6, 52, 14);
  ctx.fillStyle = "#3e74d6";
  ctx.fillRect(7, 7, 50, 12);
  ctx.fillStyle = "#fff";
  ctx.font = "12px 'Jersey 10', sans-serif";
  ctx.fillText(`KEEP LV ${b.keep}`, 10, 17);
}
