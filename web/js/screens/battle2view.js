// Replay of an engine-2 battle: two 3x3 formations, every hit, heal, interception and splash played
// in order. The browser re-runs the same deterministic battle from the record, so what you watch is
// exactly what scored. Ends with the combat report: why the battle went the way it did.
import { simulate2 } from "/shared/battle2.js";
import { ABILITIES, ORDERS, UNITS } from "/shared/rules.js";
import { sfx } from "../audio.js";
import { spriteCanvas } from "../gfx.js";
import { $, esc, fmt } from "../ui.js";

const W = 320;
const H = 176;
const LANE_Y = [62, 104, 146];
const ROW_X = [[122, 86, 50], [198, 234, 270]]; // [team][row]
let running = null;

function slotPos(team, s) {
  if (s.idx === 9) return [team ? 302 : 18, LANE_Y[1]];
  if (s.idx === 10) return [team ? 252 : 68, LANE_Y[1] + 2];
  return [ROW_X[team][Math.floor(s.idx / 3)], LANE_Y[s.idx % 3]];
}
const spriteOf = (team, s, hit) => (s.unit === "tower" ? "tower_def" : s.unit === "boss" ? `boss_${s.look}_${hit}` : `${s.unit}${team ? "_red" : ""}_${hit}`);

export const battle2Open = () => running !== null;

export function openBattle2(G, rec, { onDone, doneLabel = "Back", lootHtml = "" } = {}) {
  const sim = simulate2({
    attacker: { units: rec.attacker.units, levels: rec.attacker.levels, boosts: rec.attacker.boosts, vigor: rec.attacker.vigor, formation: rec.attacker.formation },
    defender: rec.defender,
    seed: rec.seed,
    record: true,
  });
  const abNames = (list) => (list ?? []).map((k) => ABILITIES[k]?.name ?? k).join(", ");
  const el = $("battle");
  el.innerHTML = `
    <div class="battle-top"><span class="blue">${esc(rec.attacker.name)} <small class="order-badge">${esc(ORDERS[sim.orders[0]]?.name ?? "")}</small></span><span class="vs">vs</span><span class="red"><small class="order-badge">${esc(ORDERS[sim.orders[1]]?.name ?? "")}</small> ${esc(rec.defender.name)}</span></div>
    <div style="position:relative"><canvas id="battle-canvas" width="${W * 4}" height="${H * 4}"></canvas><div class="ab-banner" id="b2-ab" hidden></div></div>
    <div class="battle-ctl"><span class="note" id="b2-round" style="color:#fff">Round 1</span><button class="btn btn-small btn-ghost" data-speed="1">1×</button><button class="btn btn-small btn-ghost" data-speed="2">2×</button><button class="btn btn-small btn-ghost" data-speed="4">4×</button><button class="btn btn-small btn-gold" id="b-skip">Skip to result</button></div>`;
  el.hidden = false;
  const ctx = $("battle-canvas").getContext("2d");
  // live state, rebuilt from the snapshot and the events
  const slots = sim.slots.map((side, team) => side.map((s) => ({ ...s, team, unitHp: Math.max(1, Math.floor(s.hpMax / s.n)), hp: s.hpMax, flash: 0, kind: "" })));
  const find = (team, idx) => slots[team].find((s) => s.idx === idx);
  const st = { i: 0, t: 0, speed: 2, shots: [], done: false };
  let bannerTimer = 0;
  const banner = (text) => {
    const b = $("b2-ab");
    if (!b) return;
    b.textContent = text;
    b.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (b.hidden = true), 2200);
  };
  const [myAb, theirAb] = sim.abilities ?? [[], []];
  if (myAb.length || theirAb.length) banner(`Abilities: ${abNames(myAb) || "none"} vs ${abNames(theirAb) || "none"}`);
  running = st;
  for (const b of el.querySelectorAll("[data-speed]")) b.onclick = () => (st.speed = Number(b.dataset.speed));
  $("b-skip").onclick = () => {
    while (st.i < sim.events.length) apply(sim.events[st.i++]);
    st.shots = [];
  };
  function apply(e) {
    const src = find(e.t, e.from);
    const own = e.k === "heal" || e.k === "revive";
    const dst = own ? find(e.t, e.to) : find(1 - e.t, e.to);
    if (!dst) return;
    if (e.k === "revive") {
      dst.hp = e.amount;
      banner(`${e.t === 0 ? "Your" : "Their"} ${UNITS[dst.unit]?.name ?? dst.unit} revived! (Revive)`);
    } else if (e.k === "heal") dst.hp = Math.min(dst.hpMax, dst.hp + e.amount);
    else dst.hp = Math.max(0, dst.hp - e.amount);
    dst.flash = 1;
    dst.kind = e.k;
    if (src) src.swing = 1;
    $("b2-round").textContent = `Round ${e.r}`;
    return { src, dst };
  }
  let last = performance.now();
  let acc = 0;
  const step = (now) => {
    if (running !== st) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt * st.speed;
    while (acc > 0.32 && st.i < sim.events.length) {
      acc -= 0.32;
      const e = sim.events[st.i++];
      const r = apply(e);
      if (r?.src && r.dst) st.shots.push({ from: slotPos(r.src.team, r.src), to: slotPos(r.dst.team, r.dst), k: e.k, t: 0 });
      sfx(e.k === "heal" || e.k === "revive" ? "click" : e.k === "splash" ? "boom" : e.kill ? "die" : "swing");
    }
    for (const side of slots) for (const s of side) (s.flash = Math.max(0, s.flash - dt * 3)), (s.swing = Math.max(0, (s.swing ?? 0) - dt * 4));
    st.shots = st.shots.filter((x) => (x.t += dt * st.speed * 3) < 1);
    draw(ctx, slots, st.shots);
    if (!st.done && st.i >= sim.events.length && !st.shots.length) {
      st.done = true;
      setTimeout(() => showResult2(G, rec, sim, onDone, doneLabel, lootHtml), 600);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function draw(ctx, slots, shots) {
  const S = ctx.canvas.width / W;
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.imageSmoothingEnabled = false;
  // field: grass, lanes, the line between the armies
  ctx.fillStyle = "#4f9a3a";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#58a541";
  for (const y of LANE_Y) ctx.fillRect(0, y - 14, W, 26);
  ctx.fillStyle = "rgba(255,243,166,0.25)";
  ctx.fillRect(W / 2 - 1, 30, 2, H - 34);
  ctx.fillStyle = "#1b1626";
  ctx.font = "8px 'Pixelify Sans', sans-serif";
  ctx.textAlign = "center";
  ["Back", "Mid", "Front"].forEach((t, i) => (ctx.fillText(t, ROW_X[0][2 - i], 26), ctx.fillText(t, ROW_X[1][2 - i], 26)));
  for (const side of slots)
    for (const s of side) {
      const [x, y] = slotPos(s.team, s);
      const n = s.hp <= 0 ? 0 : Math.ceil(s.hp / s.unitHp);
      if (n <= 0) {
        ctx.fillStyle = "rgba(60,30,20,0.35)";
        ctx.fillRect(x - 8, y + 2, 16, 3);
        continue;
      }
      const spr = spriteCanvas(spriteOf(s.team, s, s.swing > 0.5 ? 1 : 0));
      const big = s.unit === "boss" ? 2 : 1;
      const shown = s.unit === "boss" || s.unit === "tower" ? 1 : Math.min(3, n);
      for (let k = shown - 1; k >= 0; k--) {
        const ox = (k - (shown - 1) / 2) * 7 * (s.team ? -1 : 1);
        const oy = -k * 3;
        ctx.drawImage(spr, Math.round(x - (spr.width * big) / 2 + ox), Math.round(y - spr.height * big + 4 + oy), spr.width * big, spr.height * big);
      }
      if (s.flash > 0) {
        ctx.fillStyle = s.kind === "heal" || s.kind === "revive" ? `rgba(138,209,78,${s.flash * 0.6})` : s.kind === "intercept" ? `rgba(123,168,242,${s.flash * 0.7})` : `rgba(226,60,60,${s.flash * 0.5})`;
        ctx.fillRect(x - 12, y - 18 * big, 24, 20 * big);
      }
      // count and health
      const frac = s.hp / s.hpMax;
      ctx.fillStyle = "#1b1626";
      ctx.fillRect(x - 11, y + 6, 22, 4);
      ctx.fillStyle = frac > 0.5 ? "#4fa83a" : frac > 0.25 ? "#f6c33b" : "#e23c3c";
      ctx.fillRect(x - 10, y + 7, Math.round(20 * frac), 2);
      if (s.unit !== "boss" && s.unit !== "tower") {
        ctx.fillStyle = "#fff";
        ctx.fillText(`×${n}`, x + (s.team ? -13 : 13), y + 2);
      }
    }
  for (const sh of shots) {
    const x = sh.from[0] + (sh.to[0] - sh.from[0]) * sh.t;
    const y = sh.from[1] - 8 + (sh.to[1] - sh.from[1]) * sh.t - Math.sin(sh.t * Math.PI) * 10;
    ctx.fillStyle = sh.k === "heal" ? "#8ad14e" : sh.k === "splash" ? "#f07c4f" : sh.k === "intercept" ? "#7ba8f2" : "#fff3a6";
    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function showResult2(G, rec, sim, onDone, doneLabel, lootHtml) {
  const r = rec.result;
  const win = r.winner === "attacker";
  sfx(win ? "victory" : "defeat");
  const rep = r.report ?? sim.report;
  const lost = Object.entries(r.lost)
    .map(([k, n]) => `${n} ${UNITS[k]?.name ?? k}`)
    .join(", ");
  const factors = (rep?.factors ?? [])
    .map((f) => `<li class="${(f.helped === "attacker") === true ? "good" : "bad"}"><span>${f.helped === "attacker" ? "▲" : "▼"}</span> ${esc(f.text)}</li>`)
    .join("");
  const card = document.createElement("div");
  card.className = `result-card panel parchment ${win ? "win" : "loss"}`;
  card.innerHTML = `
    <h2>${win ? "Victory!" : "Defeat"}</h2>
    <p class="sub">${win ? `You broke ${esc(rec.defender.name)} in ${r.ticks} rounds.` : `${esc(rec.defender.name)} held the field.`} Orders: ${esc(rep?.orders?.[0] ?? "")} vs ${esc(rep?.orders?.[1] ?? "")}.</p>
    <div class="facts" style="grid-template-columns:repeat(3,1fr)">
      <div class="fact"><b>${r.destruction}%</b><span>Destroyed</span></div>
      <div class="fact"><b>${r.survival}%</b><span>Survived</span></div>
      <div class="fact"><b>+${fmt(r.score)}</b><span>Score</span></div>
    </div>
    ${factors ? `<h3 style="margin:8px 0 4px">Why it went this way</h3><ul class="report-list">${factors}</ul>` : ""}
    ${lootHtml}
    <p class="note">${lost ? `Fallen: ${esc(lost)}.` : "No losses."}${rep?.theirLosses?.length ? ` Enemy: ${esc(rep.theirLosses.join(", "))}.` : ""}</p>
    <p class="note decided">${rec.chain ? (rec.chain.mode === "chain" ? `Decided on Solana${rec.chain.slot ? ` in slot ${fmt(rec.chain.slot)}` : ""}${rec.chain.url ? ` · <a href="${esc(rec.chain.url)}" target="_blank" rel="noopener">verify</a>` : ""}` : "Decided by the simulated chain (test mode)") : "Decided by the game server (the on-chain program isn't deployed yet)"} · seed ${rec.seed}</p>
    <button class="btn btn-gold btn-big" id="b-done">${esc(doneLabel)}</button>`;
  $("battle").append(card);
  $("b-done").onclick = () => {
    running = null;
    $("battle").hidden = true;
    $("battle").innerHTML = "";
    onDone?.();
  };
}
