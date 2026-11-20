// Battle replay. Re-runs the server's deterministic battle from its seed and armies, so the
// fight you watch is exactly the fight that scored.
import { FIELD_H, FIELD_W, simulate } from "/shared/battle.js";
import { noise2, rand2 } from "/shared/rng.js";
import { BOSSES, UNITS } from "/shared/rules.js";
import { RGB } from "/shared/sprites.js";
import { sfx } from "../audio.js";
import { spriteCanvas } from "../gfx.js";
import { $, esc, fmt } from "../ui.js";

const W = 320;
const H = 168;
const TOP = 22;
const SX = W / FIELD_W;
const SY = (H - TOP - 4) / FIELD_H;
let running = null;
// How large each boss tier is drawn on the battlefield (regular units are 16px).
const BOSS_BATTLE_SCALE = { common: 1.15, rare: 1.45, epic: 1.75, legendary: 2.1 };
export const battleOpen = () => !$("battle").hidden;

export function openBattle(G, rec, { loot = 0, onDone, doneLabel = "Back to the bounty", lootHtml = "" } = {}) {
  const sim = simulate({ attacker: { units: rec.attacker.units, levels: rec.attacker.levels, boosts: rec.attacker.boosts, vigor: rec.attacker.vigor }, defender: rec.defender, seed: rec.seed, record: true });
  const el = $("battle");
  el.innerHTML = `
    <div class="battle-top"><span class="blue">${esc(rec.attacker.name)}</span><span class="vs">vs</span><span class="red">${esc(rec.defender.name)}</span></div>
    <canvas id="battle-canvas" width="${W * 4}" height="${H * 4}"></canvas>
    <div class="battle-ctl"><button class="btn btn-small btn-ghost" data-speed="1">1×</button><button class="btn btn-small btn-ghost" data-speed="2">2×</button><button class="btn btn-small btn-ghost" data-speed="4">4×</button><button class="btn btn-small btn-gold" id="b-skip">Skip to result</button></div>`;
  el.hidden = false;
  const canvas = $("battle-canvas");
  const ctx = canvas.getContext("2d");
  const bg = background(rec.seed);
  const st = { t: 0, speed: 2, done: false, lastTick: -1, deadAt: new Map(), shots: [], booms: [], swingAt: new Map(), holdUntil: 0 };
  // Legendary bosses get a moment to announce themselves before the fight starts.
  const champ = rec.defender.champions?.[0];
  const bossDef = champ ? BOSSES[champ.look] : null;
  if (bossDef?.tier === "legendary") {
    st.holdUntil = performance.now() + 1900;
    const card = document.createElement("div");
    card.className = "boss-intro";
    card.innerHTML = `<span>${esc(bossDef.name)}</span><b>awakens</b>`;
    el.append(card);
    sfx("rumble");
    setTimeout(() => card.remove(), 1900);
  }
  running = st;
  for (const b of el.querySelectorAll("[data-speed]")) b.onclick = () => (st.speed = Number(b.dataset.speed));
  $("b-skip").onclick = () => (st.t = sim.frames.length - 1);
  const evByTick = new Map();
  for (const e of sim.events) {
    if (!evByTick.has(e.t)) evByTick.set(e.t, []);
    evByTick.get(e.t).push(e);
  }
  let last = performance.now();
  const sounds = { swing: 0, shoot: 0, boom: 0, die: 0 };
  const frame = (now) => {
    if (running !== st) return;
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (!st.done && now >= st.holdUntil) st.t = Math.min(sim.frames.length - 1, st.t + dt * 10 * st.speed);
    const tick = Math.max(0, Math.floor(st.t));
    for (let k = st.lastTick + 1; k <= tick; k++)
      for (const e of evByTick.get(k) ?? []) {
        if (e.k === "die") st.deadAt.set(e.id, k);
        if (e.k === "swing") st.swingAt.set(e.id, k);
        if (e.k === "shoot") (st.shots.push(e), st.swingAt.set(e.id, k));
        if (e.k === "boom") st.booms.push(e);
        const s = e.k === "shoot" ? (e.type === "siege" || e.type === "boss" ? "boom" : "shoot") : e.k;
        if (tick - k < 3 && now - (sounds[s] ?? 0) > 90) {
          sounds[s] = now;
          sfx(s === "shoot" ? "arrow" : s === "boom" ? "boom" : s === "die" ? "die" : "swing");
        }
      }
    st.lastTick = tick;
    draw(ctx, bg, sim, st, tick);
    if (!st.done && tick >= sim.frames.length - 1) {
      st.done = true;
      setTimeout(() => showResult(G, rec, loot, onDone, doneLabel, lootHtml), 500);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function draw(ctx, bg, sim, st, tick) {
  const S = ctx.canvas.width / W;
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.drawImage(bg, 0, 0);
  const f = sim.frames[tick];
  const pos = (id, t = tick) => {
    const fr = sim.frames[Math.max(0, Math.min(sim.frames.length - 1, t))];
    return [fr[id * 3] * SX, TOP + fr[id * 3 + 1] * SY];
  };
  // HP totals
  const tot = [0, 0];
  const max = [0, 0];
  sim.roster.forEach((u, i) => {
    tot[u.team] += f[i * 3 + 2];
    max[u.team] += 1;
  });
  hpBar(ctx, 6, 6, 120, tot[0] / max[0], "#3e74d6");
  hpBar(ctx, W - 126, 6, 120, tot[1] / max[1], "#e23c3c");
  sim.roster.forEach((u, i) => {
    if (u.type !== "boss") return;
    hpBar(ctx, W / 2 - 50, 15, 100, f[i * 3 + 2], "#f6c33b", 3);
  });
  // bodies (y-sorted)
  const order = sim.roster.map((u, i) => i).sort((a, b) => f[a * 3 + 1] - f[b * 3 + 1]);
  for (const i of order) {
    const u = sim.roster[i];
    const [x, y] = pos(i);
    const dead = st.deadAt.get(i);
    if (u.type === "boss") {
      drawBoss(ctx, u, i, x, y, f, st, tick);
      continue;
    }
    if (f[i * 3 + 2] <= 0) {
      if (dead !== undefined && tick - dead < 12) {
        ctx.fillStyle = `rgba(243,234,219,${1 - (tick - dead) / 12})`;
        for (const [dx, dy] of [[-3, -3], [3, -3], [0, 0], [-3, 3], [3, 3], [-1, -1], [1, 1], [1, -1], [-1, 1]]) ctx.fillRect(Math.round(x + dx), Math.round(y - 6 + dy), 1, 1);
      } else if (u.type !== "tower") {
        ctx.fillStyle = "rgba(60,30,20,0.35)";
        ctx.fillRect(Math.round(x - 3), Math.round(y - 1), 6, 2);
      }
      continue;
    }
    let spr;
    if (u.type === "tower") spr = spriteCanvas("tower_def");
    else {
      const swing = st.swingAt.get(i);
      const hit = swing !== undefined && tick - swing < 3 ? 1 : 0;
      spr = spriteCanvas(`${u.type}${u.team ? "_red" : ""}_${hit}`);
    }
    ctx.fillStyle = "rgba(20,30,20,0.3)";
    ctx.fillRect(Math.round(x - 5), Math.round(y - 1), 10, 2);
    const bob = u.type !== "tower" && Math.floor((tick + i) / 3) % 2 ? -1 : 0;
    ctx.drawImage(spr, Math.round(x - spr.width / 2), Math.round(y - spr.height + 1 + bob));
    const hp = f[i * 3 + 2];
    if (hp < 1) hpBar(ctx, Math.round(x - 6), Math.round(y - spr.height - 2), 12, hp, hp > 0.5 ? "#4fa83a" : hp > 0.25 ? "#f6c33b" : "#e23c3c", 2);
  }
  // projectiles
  st.shots = st.shots.filter((s) => tick <= s.t + s.eta);
  for (const s of st.shots) {
    const p = (tick - s.t) / s.eta;
    const [x0, y0] = pos(s.id, s.t);
    const [x1, y1] = pos(s.target, s.t + s.eta);
    const arc = s.type === "siege" ? -18 * 4 * p * (1 - p) : -4 * 4 * p * (1 - p);
    const x = x0 + (x1 - x0) * p;
    const y = y0 - 8 + (y1 - y0) * p + arc;
    if (s.type === "boss") {
      ctx.fillStyle = "#1b1626";
      ctx.fillRect(Math.round(x - 3), Math.round(y - 3), 6, 6);
      ctx.fillStyle = tick % 2 ? "#f07c4f" : "#e23c3c";
      ctx.fillRect(Math.round(x - 2), Math.round(y - 2), 4, 4);
      ctx.fillStyle = "#f6c33b";
      ctx.fillRect(Math.round(x - 1), Math.round(y - 1), 2, 2);
    } else if (s.type === "siege") {
      ctx.fillStyle = "#1b1626";
      ctx.fillRect(Math.round(x - 2), Math.round(y - 2), 4, 4);
      ctx.fillStyle = "#a3a3b3";
      ctx.fillRect(Math.round(x - 1), Math.round(y - 1), 2, 2);
    } else {
      ctx.fillStyle = "#f3e2b8";
      const dx = Math.sign(x1 - x0) || 1;
      ctx.fillRect(Math.round(x - 2 * dx), Math.round(y), 4, 1);
      ctx.fillStyle = "#1b1626";
      ctx.fillRect(Math.round(x + 2 * dx), Math.round(y), 1, 1);
    }
  }
  st.booms = st.booms.filter((b) => tick - b.t < 7);
  for (const b of st.booms) {
    const r = 2 + (tick - b.t) * 2;
    const x = b.x * SX;
    const y = TOP + b.y * SY;
    ctx.fillStyle = (tick - b.t) % 2 ? "#f6c33b" : "#f07c4f";
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      ctx.fillRect(Math.round(x + Math.cos(ang) * r), Math.round(y - 4 + Math.sin(ang) * r * 0.6), 2, 2);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawBoss(ctx, u, i, x, y, f, st, tick) {
  const def = BOSSES[u.look];
  const sc = BOSS_BATTLE_SCALE[def?.tier] ?? 1.2;
  const swing = st.swingAt.get(i);
  const hit = swing !== undefined && tick - swing < 4 ? 1 : 0;
  const spr = spriteCanvas(`boss_${u.look}_${hit}`);
  const w = Math.round(spr.width * sc);
  const h = Math.round(spr.height * sc);
  const hp = f[i * 3 + 2];
  if (hp <= 0) {
    const dead = st.deadAt.get(i);
    if (dead !== undefined && tick - dead < 20) {
      ctx.globalAlpha = 1 - (tick - dead) / 20;
      ctx.drawImage(spr, Math.round(x - w / 2), Math.round(y - h + 1 + (tick - dead)), w, h);
      ctx.globalAlpha = 1;
    }
    return;
  }
  ctx.fillStyle = "rgba(20,30,20,0.35)";
  ctx.fillRect(Math.round(x - w * 0.35), Math.round(y - 2), Math.round(w * 0.7), 3);
  ctx.drawImage(spr, Math.round(x - w / 2), Math.round(y - h + 1), w, h);
}

function hpBar(ctx, x, y, w, frac, color, h = 5) {
  ctx.fillStyle = "#1b1626";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = "#3a3348";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.round(w * Math.max(0, frac)), h);
}

function background(seed) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(W, H);
  const tones = [RGB.h, [100, 190, 65], RGB.G];
  const dirt = [RGB.y, RGB.s, RGB.S];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const n = noise2(x / 9, y / 9, seed % 9973) * 0.6 + noise2(x / 3, y / 3, 77) * 0.4 + (rand2(x, y, 5) - 0.5) * 0.12;
      const band = Math.abs(y - (TOP + (H - TOP) / 2)) < 16 + noise2(x / 14, 3, 9) * 10;
      const set = band && noise2(x / 20, y / 20, 4) > 0.42 ? dirt : tones;
      const col = y < TOP - 2 ? RGB.k : n < 0.33 ? set[0] : n < 0.68 ? set[1] : set[2];
      const o = (y * W + x) * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = "#3a3348";
  ctx.fillRect(0, TOP - 2, W, 2);
  return c;
}

function showResult(G, rec, loot, onDone, doneLabel = "Back to the bounty", lootHtml = "") {
  const r = rec.result;
  const win = r.winner === "attacker";
  sfx(win ? "victory" : "defeat");
  const lost = Object.entries(r.lost)
    .map(([k, n]) => `${n} ${UNITS[k]?.name ?? k}`)
    .join(", ");
  const card = document.createElement("div");
  card.className = `result-card panel parchment ${win ? "win" : "loss"}`;
  card.innerHTML = `
    <h2>${win ? "Victory!" : "Repelled"}</h2>
    <p class="sub">${win ? `You broke ${esc(rec.defender.name)}.` : `${esc(rec.defender.name)} held the line.`}</p>
    <div class="facts" style="grid-template-columns:repeat(3,1fr)">
      <div class="fact"><b>${r.destruction}%</b><span>Destroyed</span></div>
      <div class="fact"><b>${r.survival}%</b><span>Survived</span></div>
      <div class="fact"><b>+${fmt(r.score)}</b><span>Score</span></div>
    </div>
    ${lootHtml || `<p class="note">${Math.round(r.destruction * 10)} for damage${win ? " + 300 win bonus" : ""} + ${Math.round(r.survival * 2)} for survivors${loot ? ` · looted ${loot} gold` : ""}.</p>`}
    <p class="note">${lost ? `Fallen: ${esc(lost)}.` : "No losses."}</p>
    <button class="btn btn-gold btn-big" id="b-done">${esc(doneLabel)}</button>`;
  $("battle").append(card);
  $("b-done").onclick = () => {
    running = null;
    $("battle").hidden = true;
    $("battle").innerHTML = "";
    onDone?.();
  };
}
