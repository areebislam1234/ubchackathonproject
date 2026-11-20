// The world map: search the realms for bounties. Unexplored land stays blank parchment;
// bounties nobody has found yet show as rumour circles you have to go and search.
import { FOG_H, FOG_W, REALMS } from "/shared/world.js";
import { sfx } from "./audio.js";
import { icon, spriteCanvas } from "./gfx.js";
import { $, esc, timeLeft, toast } from "./ui.js";

let G = null;
let state = null;
export const mapOpen = () => !$("mapview").hidden;
export function closeMap() {
  if (!mapOpen()) return;
  $("mapview").hidden = true;
  cancelAnimationFrame(state?.raf);
  sfx("close");
}

const STATUS_LABEL = { upcoming: "Upcoming", active: "Active", revealed: "Revealed", resolved: "Settled" };
const STATUS_COLOR = { upcoming: "#7d7a90", active: "#e23c3c", revealed: "#f6c33b", resolved: "#2d6e2b" };
const LAIR_COLOR = { common: "#d0d0dc", rare: "#4f8ee0", epic: "#8f52d4", legendary: "#f6c33b" };

export function openMap(g, { travel = false } = {}) {
  G = g;
  const hx = Math.floor(G.view.hero.x / 16);
  const hy = Math.floor(G.view.hero.y / 16);
  state = { travel, zoom: 1, cx: hx, cy: hy, filterRealm: new Set(), filterStatus: new Set(), query: "", selected: null, fog: makeFog() };
  $("mapview").innerHTML = `
    <div class="map-wrap panel parchment">
      <div class="map-stage"><canvas id="map-canvas" aria-label="World map"></canvas></div>
      <aside class="map-side">
        <div class="row spread"><h2>${travel ? "Waystones" : "World Map"}</h2><button class="close-x" id="map-close" aria-label="Close map" style="float:none;margin:0;position:static">✕</button></div>
        <p class="sub" style="margin:0">${travel ? "Pick an attuned waystone to travel there instantly." : "Search the realms for sealed bounties. Dashed circles are rumours: walk into them to find the camp."}</p>
        <div>
          <input id="map-q" type="search" placeholder="Search by bounty ID or realm" aria-label="Search bounties" style="width:100%" />
          <div class="chips" id="chips-realm" style="margin-top:6px">${REALMS.map((r) => `<button class="chip" data-realm="${r.id}" aria-pressed="false" title="${esc(r.name)}">${esc(r.category)}</button>`).join("")}</div>
          <div class="chips" id="chips-status" style="margin-top:5px">${["active", "upcoming", "revealed", "joined"].map((s) => `<button class="chip" data-status="${s}" aria-pressed="false">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>
        </div>
        <div class="results" id="map-results"></div>
        <div class="map-actions" id="map-actions"></div>
      </aside>
    </div>`;
  $("mapview").hidden = false;
  sfx("open");
  $("map-close").onclick = closeMap;
  $("mapview").onclick = (e) => e.target === $("mapview") && closeMap();
  $("map-q").oninput = (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderList();
  };
  for (const b of document.querySelectorAll("#chips-realm .chip, #chips-status .chip"))
    b.onclick = () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      const set = b.dataset.realm ? state.filterRealm : state.filterStatus;
      const key = b.dataset.realm ?? b.dataset.status;
      on ? set.add(key) : set.delete(key);
      sfx("click");
      renderList();
    };
  bindCanvas();
  renderList();
  renderActions();
  const loop = () => {
    draw();
    state.raf = requestAnimationFrame(loop);
  };
  loop();
}

function makeFog() {
  const c = document.createElement("canvas");
  c.width = FOG_W;
  c.height = FOG_H;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(FOG_W, FOG_H);
  const ex = G.view.explored;
  for (let i = 0; i < FOG_W * FOG_H; i++) {
    if (ex[i]) continue;
    img.data[i * 4] = 232;
    img.data[i * 4 + 1] = 211;
    img.data[i * 4 + 2] = 160;
    img.data[i * 4 + 3] = 212; // unexplored: the coastline and realms show faintly, nothing else
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function filtered() {
  const q = state.query;
  return G.bounties
    .filter((b) => b.status !== "resolved" || b.entered)
    .filter((b) => !state.filterRealm.size || state.filterRealm.has(b.realm))
    .filter((b) => !state.filterStatus.size || state.filterStatus.has(b.status) || (state.filterStatus.has("joined") && b.entered))
    .filter((b) => {
      if (!q) return true;
      const r = REALMS.find((x) => x.id === b.realm);
      return b.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q);
    })
    .sort((a, b) => Number(b.entered) - Number(a.entered) || Number(b.discovered) - Number(a.discovered) || order(a) - order(b));
}
const order = (b) => (b.status === "active" ? b.endsAt : b.status === "upcoming" ? 1e15 + b.startsAt : 2e15);

function renderList() {
  const list = state.travel ? [] : filtered();
  const towns = state.travel ? G.world.towns : [];
  const el = $("map-results");
  const home = G.me.home
    ? `<button class="result ${state.selected?.home ? "focus" : ""}" data-home="1"><span class="r1">${icon("flag", 2)} Your fortress</span><span>Recall home any time you're not in combat (H)</span></button>`
    : "";
  el.innerHTML =
    home +
    towns
      .map((t) => {
        const r = REALMS.find((x) => x.id === t.realm);
        const att = G.me.attuned.includes(t.name);
        return `<button class="result ${state.selected?.town === t.name ? "focus" : ""}" data-town="${esc(t.name)}">
          <span class="r1">${icon("castle", 2)} ${esc(t.name)}</span><span>${esc(r.name)} · ${att ? "Attuned" : '<span class="rumor">Not attuned: walk there and touch the stone</span>'}</span></button>`;
      })
      .join("") +
    list
      .map((b) => {
        const r = REALMS.find((x) => x.id === b.realm);
        const when = b.status === "active" ? `${timeLeft(b.endsAt - G.now())} left` : b.status === "upcoming" ? `opens in ${timeLeft(b.startsAt - G.now())}` : STATUS_LABEL[b.status];
        return `<button class="result ${state.selected?.id === b.id ? "focus" : ""}" data-id="${b.id}">
          <span class="r1">${esc(b.id)} <span class="tag ${b.tier}">${b.tier}</span>${b.featured ? '<span class="tag featured">Featured</span>' : ""}<span class="tag status-${b.status}">${STATUS_LABEL[b.status]}</span></span>
          <span>${esc(r.category)} · ${esc(r.name)} · ${when} · ${b.participants}/${b.maxPlayers}${b.entered ? " · <b>You're in</b>" : ""}</span>
          ${b.discovered ? "" : '<span class="rumor">Rumoured. Search the dashed circle to find the camp.</span>'}
        </button>`;
      })
      .join("");
  if (!el.innerHTML) el.innerHTML = `<p class="note">${state.travel ? "" : "No bounties match. Clear a filter, or explore further."}</p>`;
  for (const b of el.querySelectorAll("[data-id]")) b.onclick = () => select({ id: b.dataset.id });
  for (const b of el.querySelectorAll("[data-town]")) b.onclick = () => select({ town: b.dataset.town });
  for (const b of el.querySelectorAll("[data-home]")) b.onclick = () => select({ home: true });
}

function select(sel) {
  state.selected = sel;
  sfx("click");
  const b = sel.id ? G.bounties.find((x) => x.id === sel.id) : null;
  const t = sel.town ? G.world.towns.find((x) => x.name === sel.town) : null;
  const l = sel.lair ? G.lairs.find((x) => x.id === sel.lair) : null;
  if (l) {
    state.cx = l.x;
    state.cy = l.y;
  }
  if (sel.home && G.me.home) {
    state.cx = G.me.home.x;
    state.cy = G.me.home.y;
  }
  if (b) {
    state.cx = b.discovered ? b.x : b.rumor.x;
    state.cy = b.discovered ? b.y : b.rumor.y;
  } else if (t) {
    state.cx = t.x;
    state.cy = t.y;
  }
  renderList();
  renderActions();
}

function renderActions() {
  const el = $("map-actions");
  const sel = state.selected;
  const legend = `<div class="legend">${icon("pin", 1)} found bounty · dashed ring: rumour · ${icon("castle", 1)} waystone · ${icon("flag", 1)} your fortress · ${icon("skull", 1)} boss lair · faded parchment: unexplored</div>`;
  if (!sel) return void (el.innerHTML = legend);
  if (sel.home) {
    el.innerHTML = `<button class="btn btn-blue" id="act-home">Recall home</button><button class="btn btn-ghost" id="act-walk">Set course</button>${legend}`;
    $("act-home").onclick = () => (closeMap(), G.recallHome());
    $("act-walk").onclick = () => G.setCourse(G.me.home.x, G.me.home.y + 1) && closeMap();
    return;
  }
  if (sel.town) {
    const t = G.world.towns.find((x) => x.name === sel.town);
    const att = G.me.attuned.includes(t.name);
    el.innerHTML = `<button class="btn btn-blue" id="act-travel" ${att ? "" : "disabled"}>Travel to ${esc(t.name)}</button><button class="btn btn-ghost" id="act-walk">Set course</button>${legend}`;
    $("act-travel").onclick = () => (G.travelTo(t), closeMap());
    $("act-walk").onclick = () => G.setCourse(t.x, t.y + 1) && closeMap();
    return;
  }
  if (sel.lair) {
    const l = G.lairs.find((x) => x.id === sel.lair);
    if (!l) return void (el.innerHTML = legend);
    const ws = G.world.towns.filter((t) => G.me.attuned.includes(t.name)).sort((p, q) => Math.hypot(p.x - l.x, p.y - l.y) - Math.hypot(q.x - l.x, q.y - l.y))[0];
    el.innerHTML = `
      <button class="btn btn-gold" id="act-open">${esc(l.name)} · ${esc(l.tierName)}</button>
      <div class="row"><button class="btn btn-go" id="act-walk" style="flex:1">Set course</button>${ws ? `<button class="btn btn-blue" id="act-ws" style="flex:1">Waystone: ${esc(ws.name)}</button>` : ""}</div>
      ${legend}`;
    $("act-open").onclick = () => (closeMap(), G.openLair(l.id));
    $("act-walk").onclick = () => G.setCourse(l.x, l.y + 1) && (closeMap(), toast(`Marching on ${l.name}`, "good"));
    if (ws) $("act-ws").onclick = () => (G.travelTo(ws), closeMap());
    return;
  }
  const b = G.bounties.find((x) => x.id === sel.id);
  if (!b) return void (el.innerHTML = legend);
  const realmTowns = G.world.towns.filter((t) => G.me.attuned.includes(t.name));
  const target = b.discovered ? { x: b.x, y: b.y } : b.rumor;
  const nearest = realmTowns.sort((p, q) => Math.hypot(p.x - target.x, p.y - target.y) - Math.hypot(q.x - target.x, q.y - target.y))[0];
  el.innerHTML = `
    ${b.discovered ? `<button class="btn btn-gold" id="act-open">Open ${esc(b.id)}</button>` : ""}
    <div class="row"><button class="btn btn-go" id="act-walk" style="flex:1">Set course</button>${nearest ? `<button class="btn btn-blue" id="act-ws" style="flex:1" title="Teleport to the attuned waystone nearest this bounty">Waystone: ${esc(nearest.name)}</button>` : ""}</div>
    ${legend}`;
  if (b.discovered) $("act-open").onclick = () => (closeMap(), G.openBounty(b.id));
  $("act-walk").onclick = () => {
    if (G.setCourse(target.x, target.y + (b.discovered ? 1 : 0))) {
      closeMap();
      toast(b.discovered ? `Marching to ${b.id}` : `Heading into the rumoured area. Keep your eyes open.`, "good");
    }
  };
  if (nearest) $("act-ws").onclick = () => (G.travelTo(nearest), closeMap());
}

// ── Canvas ────────────────────────────────────────────────────────────
function bindCanvas() {
  const c = $("map-canvas");
  let drag = null;
  c.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: state.cx, cy: state.cy, moved: false };
    c.setPointerCapture(e.pointerId);
  };
  c.onpointermove = (e) => {
    if (!drag) return;
    const s = scale();
    const dx = (e.clientX - drag.x) * devicePixelRatio;
    const dy = (e.clientY - drag.y) * devicePixelRatio;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    state.cx = drag.cx - dx / s;
    state.cy = drag.cy - dy / s;
  };
  c.onpointerup = (e) => {
    if (drag && !drag.moved) clickAt(e);
    drag = null;
  };
  c.onwheel = (e) => {
    e.preventDefault();
    state.zoom = Math.max(1, Math.min(6, state.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
  };
}

function scale() {
  const c = $("map-canvas");
  return Math.min(c.width / G.world.W, c.height / G.world.H) * state.zoom;
}
function toScreen(x, y) {
  const c = $("map-canvas");
  const s = scale();
  return [c.width / 2 + (x - state.cx) * s, c.height / 2 + (y - state.cy) * s];
}

function clickAt(e) {
  const c = $("map-canvas");
  const rect = c.getBoundingClientRect();
  const px = (e.clientX - rect.left) * devicePixelRatio;
  const py = (e.clientY - rect.top) * devicePixelRatio;
  let best = null;
  let bd = 22 * devicePixelRatio;
  if (G.me.home) {
    const [x, y] = toScreen(G.me.home.x + 0.5, G.me.home.y);
    const d = Math.hypot(x - px, y - py);
    if (d < bd) (bd = d), (best = { home: true });
  }
  for (const t of G.world.towns) {
    const [x, y] = toScreen(t.x + 0.5, t.y);
    const d = Math.hypot(x - px, y - py);
    if (d < bd) (bd = d), (best = { town: t.name });
  }
  if (!state.travel)
    for (const l of G.lairs ?? []) {
      const [x, y] = toScreen(l.x + 0.5, l.y + 0.5);
      const d = Math.hypot(x - px, y - py);
      if (d < bd) (bd = d), (best = { lair: l.id });
    }
  if (!state.travel)
    for (const b of G.bounties) {
      const p = b.discovered ? { x: b.x, y: b.y } : b.rumor;
      if (!p) continue;
      const [x, y] = toScreen(p.x + 0.5, p.y + 0.5);
      const d = Math.hypot(x - px, y - py);
      const r = b.discovered ? 22 : b.rumor.r * scale();
      if (d < Math.max(bd, r) && d < bd + (b.discovered ? 0 : r)) (bd = d), (best = { id: b.id });
    }
  if (best) select(best);
}

function draw() {
  const c = $("map-canvas");
  if (!c) return;
  const w = Math.floor(c.clientWidth * devicePixelRatio);
  const h = Math.floor(c.clientHeight * devicePixelRatio);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#e8d3a0";
  ctx.fillRect(0, 0, w, h);
  const s = scale();
  const [ox, oy] = toScreen(0, 0);
  ctx.drawImage(G.thumb, Math.round(ox), Math.round(oy), Math.round(G.world.W * s), Math.round(G.world.H * s));
  ctx.drawImage(state.fog, Math.round(ox), Math.round(oy), Math.round(G.world.W * s), Math.round(G.world.H * s));
  // parchment grain on unexplored land
  ctx.fillStyle = "rgba(160,120,70,0.14)";
  for (let y = 0; y < h; y += 6) for (let x = (y / 6) % 2 ? 3 : 0; x < w; x += 6) ctx.fillRect(x, y, 1, 1);
  const dp = devicePixelRatio;
  // realm names
  ctx.textAlign = "center";
  ctx.font = `${Math.round(22 * dp)}px "Jersey 10", sans-serif`;
  for (const t of G.world.towns) {
    const r = REALMS.find((x) => x.id === t.realm);
    const [x, y] = toScreen(t.x + 0.5, t.y - 9);
    ctx.fillStyle = "rgba(42,26,14,0.75)";
    ctx.fillText(r.name.toUpperCase() === r.name ? r.name : r.name, x + 2 * dp, y + 2 * dp);
    ctx.fillStyle = "#fff8e6";
    ctx.fillText(r.name, x, y);
  }
  // towns / waystones
  const castle = spriteCanvas("icon_castle");
  for (const t of G.world.towns) {
    const [x, y] = toScreen(t.x + 0.5, t.y);
    const att = G.me.attuned.includes(t.name);
    const S = Math.round(16 * dp);
    if (state.travel && att) {
      ctx.fillStyle = "rgba(123,168,242,0.55)";
      ctx.fillRect(x - S, y - S, S * 2, S * 2);
    }
    ctx.globalAlpha = att || !state.travel ? 1 : 0.45;
    ctx.drawImage(castle, Math.round(x - S / 2), Math.round(y - S / 2), S, S);
    ctx.globalAlpha = 1;
    if (state.selected?.town === t.name) ring(ctx, x, y, 14 * dp, "#1b1626");
  }
  // bounties
  if (!state.travel) {
    const shown = new Set(filtered().map((b) => b.id));
    for (const b of G.bounties) {
      if (!shown.has(b.id)) continue;
      if (b.discovered) {
        const [x, y] = toScreen(b.x + 0.5, b.y + 0.5);
        const S = Math.round((b.tier === "epic" ? 13 : b.tier === "rare" ? 11 : 9) * dp);
        ctx.fillStyle = "#1b1626";
        ctx.fillRect(Math.round(x - S / 2) - 2 * dp, Math.round(y - S / 2) - 2 * dp, S + 4 * dp, S + 4 * dp);
        ctx.fillStyle = b.entered ? "#3e74d6" : STATUS_COLOR[b.status];
        ctx.fillRect(Math.round(x - S / 2), Math.round(y - S / 2), S, S);
        if (b.featured) {
          ctx.fillStyle = "#fff3a6";
          ctx.fillRect(Math.round(x - 1.5 * dp), Math.round(y - 1.5 * dp), Math.round(3 * dp), Math.round(3 * dp));
        }
        if (state.selected?.id === b.id) ring(ctx, x, y, S, "#1b1626");
      } else {
        const [x, y] = toScreen(b.rumor.x + 0.5, b.rumor.y + 0.5);
        const r = b.rumor.r * s;
        ctx.setLineDash([5 * dp, 4 * dp]);
        ctx.lineWidth = 2 * dp;
        ctx.strokeStyle = state.selected?.id === b.id ? "#1b1626" : "rgba(92,58,29,0.8)";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(92,58,29,0.85)";
        ctx.font = `${Math.round(24 * dp)}px "Jersey 10", sans-serif`;
        ctx.fillText("?", x, y + 8 * dp);
      }
    }
  }
  // boss lairs: diamonds sized and coloured by tier
  if (!state.travel)
    for (const l of G.lairs ?? []) {
      const [x, y] = toScreen(l.x + 0.5, l.y + 0.5);
      const r = Math.round(({ common: 6, rare: 7, epic: 9, legendary: 11 }[l.tier] ?? 6) * dp);
      const diamond = (rr, color) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y - rr);
        ctx.lineTo(x + rr, y);
        ctx.lineTo(x, y + rr);
        ctx.lineTo(x - rr, y);
        ctx.fill();
      };
      diamond(r + 3 * dp, "#1b1626");
      diamond(r, l.readyAt > G.now() ? "#6f6e82" : LAIR_COLOR[l.tier]);
      const sk = spriteCanvas("icon_skull");
      const S = Math.round(r * 1.1);
      ctx.drawImage(sk, Math.round(x - S / 2), Math.round(y - S / 2.4), S, S);
      if (state.selected?.lair === l.id) ring(ctx, x, y, r + 6 * dp, "#1b1626");
    }
  // your fortress
  if (G.me.home) {
    const flag = spriteCanvas("icon_flag");
    const [x, y] = toScreen(G.me.home.x + 0.5, G.me.home.y);
    const S = Math.round(16 * dp);
    ctx.fillStyle = "#3e74d6";
    ctx.fillRect(Math.round(x - S / 2) - 2 * dp, Math.round(y - S / 2) - 2 * dp, S + 4 * dp, S + 4 * dp);
    ctx.drawImage(flag, Math.round(x - S / 2), Math.round(y - S / 2), S, S);
    if (state.selected?.home) ring(ctx, x, y, 14 * dp, "#1b1626");
  }
  // hero
  const [hx, hy] = toScreen(G.view.hero.x / 16, G.view.hero.y / 16);
  if (Math.floor(performance.now() / 350) % 2) {
    ctx.fillStyle = "#1b1626";
    ctx.fillRect(hx - 6 * dp, hy - 6 * dp, 12 * dp, 12 * dp);
    ctx.fillStyle = "#fff";
    ctx.fillRect(hx - 4 * dp, hy - 4 * dp, 8 * dp, 8 * dp);
  }
  // planned route
  const path = G.view.path;
  if (path?.length) {
    ctx.fillStyle = "#1b1626";
    for (let i = 0; i < path.length; i += 4) {
      const [x, y] = toScreen(path[i].x / 16, path[i].y / 16);
      ctx.fillRect(x - dp, y - dp, 2 * dp, 2 * dp);
    }
  }
}

function ring(ctx, x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * devicePixelRatio;
  ctx.strokeRect(Math.round(x - r), Math.round(y - r), Math.round(r * 2), Math.round(r * 2));
}
