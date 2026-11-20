// StakeClash client: boots the world, signs you in, runs the HUD and wires every screen.
import { FOG_CELL, FOG_W, REALMS, TILE, generateWorld } from "/shared/world.js";
import { api, saveToken, session } from "./api.js";
import { sfx, sound } from "./audio.js";
import { icon, spriteUrl } from "./gfx.js";
import { worldThumbnail } from "./terrain.js";
import { $, closeSheet, currentSheet, esc, fmt, timeLeft, toast } from "./ui.js";
import { WorldView } from "./world-view.js";
import { openMap, closeMap, mapOpen } from "./map.js";
import { openBounty, refreshBountySheet } from "./screens/bounty.js";
import { openFortress } from "./screens/fortress.js";
import { openArmy } from "./screens/army.js";
import { openProfile } from "./screens/profile.js";
import { battleOpen } from "./screens/battle.js";
import { openDev } from "./screens/dev.js";
import { openLair, refreshLairSheet } from "./screens/lair.js";
import { openInventory, unseenCount } from "./screens/inventory.js";
import { openIntel } from "./screens/intel.js";
import { openTreasury } from "./screens/treasury.js";
import { openColosseum } from "./screens/colosseum.js";
import { openOdds } from "./screens/odds.js";
import { crierShout, initCrier } from "./crier.js";

// Shared game context handed to every screen.
export const G = {
  cfg: null,
  me: null,
  bounties: [],
  lairs: [],
  world: null,
  view: null,
  thumb: null,
  now: () => Date.now() + (G.clockSkew ?? 0),
  clockSkew: 0,
  refreshMe,
  refreshBounties,
  refreshLairs,
  openBounty: (id) => openBounty(G, id),
  openLair: (id) => openLair(G, id),
  openIntel: (id) => openIntel(G, id),
  openColosseum: (opts) => openColosseum(G, opts),
  openOdds: (market) => openOdds(G, market),
  travelTo,
  setCourse,
};

// ── Boot ──────────────────────────────────────────────────────────────
for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = icon(el.dataset.icon, el.closest(".dock") ? 3 : 2);

const t0 = performance.now();
G.world = generateWorld();
G.thumb = worldThumbnail(G.world);
G.view = new WorldView($("world"), G.world, {
  onExplore,
  onNear,
  onInteract,
  onArrive: () => {
    if (G.view.pendingCamp) {
      const id = G.view.pendingCamp;
      G.view.pendingCamp = null;
      openBounty(G, id);
    }
    if (G.view.pendingLair) {
      const id = G.view.pendingLair;
      G.view.pendingLair = null;
      openLair(G, id);
    }
  },
});
G.view.paused = true;
G.view.zoom = 3;
G.view.start();
console.log(`world ready in ${Math.round(performance.now() - t0)}ms`);

// Title screen: a slow fly-over of the capital.
let attract = true;
(function drift() {
  if (!attract) return;
  G.view.cam.free = true;
  G.view.cam.x += 0.25;
  G.view.cam.y += Math.sin(performance.now() / 4000) * 0.08;
  requestAnimationFrame(drift);
})();

session.onLogout = () => location.reload();
G.cfg = await api("/api/config").catch(() => ({}));

// ── Sign in / create account ──────────────────────────────────────────
let authMode = "signin";
function setAuthMode(mode) {
  authMode = mode;
  $("tab-signin").setAttribute("aria-pressed", String(mode === "signin"));
  $("tab-create").setAttribute("aria-pressed", String(mode === "create"));
  $("confirm-row").hidden = mode !== "create";
  $("login-pass2").required = mode === "create";
  $("login-pass").autocomplete = mode === "create" ? "new-password" : "current-password";
  $("login-submit").textContent = mode === "create" ? "Raise your banner" : "Enter the realm";
  $("auth-hint").textContent = mode === "create" ? "Pick a name nobody has taken and a password of 8+ characters." : "Welcome back, warlord.";
}
$("tab-signin").addEventListener("click", () => setAuthMode("signin"));
$("tab-create").addEventListener("click", () => setAuthMode("create"));
$("pw-toggle").addEventListener("click", () => {
  const show = $("login-pass").type === "password";
  for (const id of ["login-pass", "login-pass2"]) $(id).type = show ? "text" : "password";
  $("pw-toggle").textContent = show ? "Hide" : "Show";
  $("pw-toggle").setAttribute("aria-pressed", String(show));
});
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-submit");
  const name = $("login-name").value;
  const password = $("login-pass").value;
  if (authMode === "create" && password !== $("login-pass2").value) return toast("The passwords don't match.", "bad");
  btn.disabled = true;
  try {
    const r = await api(authMode === "create" ? "/api/register" : "/api/login", { body: { name, password } });
    session.token = r.token;
    saveToken(r.token);
    G.me = await api("/api/me");
    sfx("enter");
    if (r.passwordSet) toast("Password saved. Use it to sign in from now on.", "good");
    startGame();
  } catch (err) {
    toast(err.message, "bad");
    $("auth-hint").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

export async function logOut() {
  await api("/api/logout", { body: {} }).catch(() => {});
  saveToken(null);
  session.token = null;
  location.reload();
}
G.logOut = logOut;

function startGame() {
  attract = false;
  $("title").hidden = true;
  $("hud").hidden = false;
  $("btn-dev").hidden = !G.cfg.devTools;
  const v = G.view;
  // every visit starts at your fortress gate (the server puts you there on sign-in)
  const pos = G.me.home ? { x: G.me.home.x, y: G.me.home.y + 2 } : (G.me.pos ?? G.world.spawn);
  v.setExplored(Uint8Array.from(atob(G.me.explored), (c) => c.charCodeAt(0)));
  v.setAttuned(G.me.attuned);
  v.setHome(G.me.home, G.me.buildings.keep);
  v.teleport(pos.x, pos.y);
  v.paused = false;
  renderHud();
  refreshBounties();
  refreshLairs();
  setInterval(refreshBounties, 2500);
  setInterval(refreshMe, 4000);
  setInterval(refreshLairs, 10000);
  setInterval(pollFeed, 3000);
  setInterval(flushExplore, 1500);
  setInterval(drawMinimap, 200);
  setInterval(tickPrompt, 1000);
  pollFeed();
  initCrier(G);
  setTimeout(() => $("help-hint")?.remove(), 14000);
}

// ── State refresh ─────────────────────────────────────────────────────
async function refreshMe() {
  try {
    G.me = await api("/api/me");
    renderHud();
  } catch {
    /* offline for a moment */
  }
}

async function refreshBounties() {
  try {
    const r = await api("/api/bounties");
    G.clockSkew = r.now - Date.now();
    G.bounties = r.bounties;
    G.view.setCamps(G.bounties.filter((b) => b.discovered && b.status !== "resolved").map((b) => ({ id: b.id, x: b.x, y: b.y, tier: b.tier, status: b.status, entered: b.entered, featured: b.featured })));
    if (currentSheet() === "bounty") refreshBountySheet(G);
  } catch {
    /* offline for a moment */
  }
}

async function refreshLairs() {
  try {
    const r = await api("/api/bosses");
    G.lairs = r.lairs;
    G.view.setLairs(G.lairs.map((l) => ({ id: l.id, tier: l.tier, x: l.x, y: l.y, readyAt: l.readyAt, name: l.name })));
    if (currentSheet() === "lair") refreshLairSheet(G);
  } catch {
    /* offline for a moment */
  }
}

function renderHud() {
  const m = G.me;
  if (!m) return;
  $("hud-name").textContent = m.name;
  $("hud-keep").textContent = m.buildings.keep;
  $("hud-trophies").innerHTML = `${icon("trophy", 1)} ${fmt(m.trophies)} trophies`;
  $("gold-val").textContent = fmt(m.gold);
  $("gold-fill").style.width = `${Math.min(100, (m.gold / m.derived.vaultCap) * 100)}%`;
  $("crystal-val").textContent = fmt(m.crystals);
  $("usdc-val").textContent = `$${((m.usdc ?? 0) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  $("might-val").textContent = fmt(m.might ?? 0);
  G.view.setAttuned(m.attuned);
  G.view.setHome(m.home, m.buildings.keep);
  renderBagBadge();
}

function renderBagBadge() {
  const n = G.me ? unseenCount(G.me) : 0;
  const el = $("bag-badge");
  el.hidden = !n;
  el.textContent = n > 99 ? "99+" : String(n);
  // unread intelligence reports
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(`stakeclash.intelSeen.${G.me?.id}`) ?? 0);
  } catch {
    seen = G.me?.intelCount ?? 0;
  }
  const unread = Math.max(0, (G.me?.intelCount ?? 0) - seen);
  $("intel-badge").hidden = !unread;
  $("intel-badge").textContent = String(unread);
}
G.renderBagBadge = renderBagBadge;

// ── Exploration ───────────────────────────────────────────────────────
const pending = new Set();
let lastPos = null;
let lastRealm = null;
function onExplore(cells, pos) {
  for (const c of cells) pending.add(c);
  lastPos = pos;
  const realm = REALMS[G.world.realm[pos.y * G.world.W + pos.x]];
  if (realm && realm.id !== lastRealm) {
    lastRealm = realm.id;
    $("mm-realm").textContent = realm.name;
    showRealmTitle(realm);
  }
}
let realmTimer = null;
function showRealmTitle(r) {
  const el = $("realm-title");
  el.innerHTML = `<h2>${esc(r.name)}</h2><p>${esc(r.category)} bounties surface here · ${esc(r.blurb)}</p>`;
  el.classList.add("show");
  clearTimeout(realmTimer);
  realmTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
let flushing = false;
async function flushExplore() {
  if (flushing || (!pending.size && !lastPos)) return;
  flushing = true;
  const cells = [...pending];
  pending.clear();
  try {
    const r = await api("/api/explore", { body: { cells, pos: lastPos } });
    if (r.lairs?.length) {
      await refreshLairs();
      for (const id of r.lairs) {
        const l = G.lairs.find((x) => x.id === id);
        if (!l) continue;
        if (l.tier === "legendary") {
          sfx("rumble");
          G.view.shake(900);
        } else sfx("discover");
        toast(`Boss sighted: ${l.name} · ${l.tierName}`, l.tier === "legendary" || l.tier === "epic" ? "bad" : "gold");
      }
    }
    if (r.discovered?.length) {
      sfx("discover");
      await refreshBounties();
      for (const id of r.discovered) {
        const b = G.bounties.find((x) => x.id === id);
        toast(`Bounty sighted: ${id}${b ? ` · ${b.tier[0].toUpperCase() + b.tier.slice(1)}${b.featured ? " · Featured" : ""}` : ""}`, "gold");
      }
    }
  } catch {
    for (const c of cells) pending.add(c);
  } finally {
    flushing = false;
  }
}

// ── Interaction ───────────────────────────────────────────────────────
let nearTarget = null;
function onNear(t) {
  nearTarget = t;
  tickPrompt();
}
function tickPrompt() {
  const el = $("prompt");
  const t = nearTarget;
  if (!t || G.view.paused) return void (el.hidden = true);
  if (t.kind === "camp") {
    const b = G.bounties.find((x) => x.id === t.camp.id) ?? t.camp;
    const when = b.status === "upcoming" ? `opens in ${timeLeft(b.startsAt - G.now())}` : b.status === "active" ? `${timeLeft(b.endsAt - G.now())} left` : b.status === "revealed" ? "question revealed" : "settled";
    el.innerHTML = `<kbd>E</kbd><span class="p-main">${esc(b.id)}</span><span>${b.tier[0].toUpperCase() + b.tier.slice(1)}${b.featured ? " · Featured" : ""}${b.hot ? " · Hot market" : ""} · ${when} · ${b.participants ?? 0}/${b.maxPlayers ?? "?"} warlords</span>`;
  } else if (t.kind === "lair") {
    const l = G.lairs.find((x) => x.id === t.lair.id) ?? t.lair;
    const wait = (l.readyAt ?? 0) - G.now();
    el.innerHTML = `<kbd>E</kbd><span class="p-main">${esc(l.name)}</span><span>${esc(l.tierName ?? l.tier)} boss · ${wait > 0 ? `back in ${timeLeft(wait)}` : "ready to fight"}</span>`;
  } else if (t.kind === "home") {
    el.innerHTML = `<kbd>E</kbd><span class="p-main">Your fortress</span><span>Keep level ${G.me.buildings.keep} · upgrade buildings and train troops</span>`;
  } else {
    const attuned = G.me?.attuned.includes(t.town.name);
    el.innerHTML = `<kbd>E</kbd><span class="p-main">Waystone of ${esc(t.town.name)}</span><span>${attuned ? "Fast travel" : "Touch to attune"}</span>`;
  }
  el.hidden = false;
}
$("prompt").addEventListener("click", () => G.view.interact());

async function onInteract(t) {
  if (t.kind === "camp") return openBounty(G, t.camp.id);
  if (t.kind === "lair") return openLair(G, t.lair.id);
  if (t.kind === "home") return openFortress(G);
  if (t.kind === "waystone") {
    if (!G.me.attuned.includes(t.town.name)) {
      const r = await api("/api/attune", { body: { town: t.town.name } }).catch(() => null);
      if (r) {
        G.me.attuned = r.attuned;
        G.view.setAttuned(r.attuned);
        sfx("waystone");
        toast(`Waystone of ${t.town.name} attuned. You can travel here from the map.`, "good");
      }
      return;
    }
    openMap(G, { travel: true });
  }
}

// ── Recall home ───────────────────────────────────────────────────────
let recalling = null;
async function recallHome() {
  if (recalling) return;
  if (battleOpen()) return toast("Finish the battle first.", "bad");
  const left = (G.me?.combatUntil ?? 0) - G.now();
  if (left > 0) return toast(`You're still in combat. You can recall home in ${Math.ceil(left / 1000)}s.`, "bad");
  const start = { x: G.view.hero.x, y: G.view.hero.y };
  const CHANNEL = 1500;
  const t0 = performance.now();
  $("recall").hidden = false;
  $("recall-text").textContent = "Recalling home… move to cancel";
  sfx("waystone");
  recalling = setInterval(async () => {
    const moved = Math.hypot(G.view.hero.x - start.x, G.view.hero.y - start.y) > 2;
    const p = Math.min(1, (performance.now() - t0) / CHANNEL);
    $("recall-fill").style.width = `${p * 100}%`;
    if (moved) return stopRecall("Recall cancelled.");
    if (p < 1) return;
    clearInterval(recalling);
    try {
      const at = await api("/api/recall", { body: {} });
      G.view.teleport(at.x, at.y);
      lastPos = at;
      stopRecall();
      toast("Home sweet fortress.", "good");
    } catch (e) {
      stopRecall(e.message);
    }
  }, 50);
}
function stopRecall(msg) {
  clearInterval(recalling);
  recalling = null;
  $("recall").hidden = true;
  if (msg) toast(msg, "bad");
}
G.recallHome = recallHome;
$("btn-home").addEventListener("click", recallHome);

function setCourse(x, y) {
  const ok = G.view.setCourse(x, y, { far: true });
  if (!ok) toast("No path there from here. Try a waystone.", "bad");
  return ok;
}

function travelTo(town) {
  sfx("waystone");
  G.view.teleport(town.waystone.x, town.waystone.y);
  lastPos = { x: town.waystone.x, y: town.waystone.y };
}

// ── Minimap ───────────────────────────────────────────────────────────
const mm = $("minimap").getContext("2d");
function drawMinimap() {
  if (!G.view || $("hud").hidden) return;
  const R = 56; // tiles each side
  const hx = Math.floor(G.view.hero.x / TILE);
  const hy = Math.floor(G.view.hero.y / TILE);
  const s = 168 / (R * 2);
  mm.imageSmoothingEnabled = false;
  mm.fillStyle = "#2b5cb8";
  mm.fillRect(0, 0, 168, 168);
  mm.drawImage(G.thumb, hx - R, hy - R, R * 2, R * 2, 0, 0, 168, 168);
  // fog
  mm.fillStyle = "rgba(27,22,38,0.62)";
  const ex = G.view.explored;
  for (let cy = Math.floor((hy - R) / FOG_CELL); cy <= Math.floor((hy + R) / FOG_CELL); cy++)
    for (let cx = Math.floor((hx - R) / FOG_CELL); cx <= Math.floor((hx + R) / FOG_CELL); cx++) {
      if (cx < 0 || cy < 0 || cx >= FOG_W || cy >= FOG_W) continue;
      if (ex[cy * FOG_W + cx]) continue;
      mm.fillRect(Math.floor((cx * FOG_CELL - hx + R) * s), Math.floor((cy * FOG_CELL - hy + R) * s), Math.ceil(FOG_CELL * s), Math.ceil(FOG_CELL * s));
    }
  const COLORS = { upcoming: "#a3a3b3", active: "#e23c3c", revealed: "#f6c33b", resolved: "#4fa83a" };
  for (const b of G.bounties) {
    if (b.discovered) {
      const x = Math.round((b.x - hx + R) * s);
      const y = Math.round((b.y - hy + R) * s);
      mm.fillStyle = "#1b1626";
      mm.fillRect(x - 4, y - 4, 9, 9);
      mm.fillStyle = b.entered ? "#3e74d6" : COLORS[b.status];
      mm.fillRect(x - 3, y - 3, 7, 7);
    } else if (b.rumor) {
      const x = (b.rumor.x - hx + R) * s;
      const y = (b.rumor.y - hy + R) * s;
      mm.strokeStyle = "rgba(255,243,166,0.8)";
      mm.setLineDash([3, 3]);
      mm.beginPath();
      mm.arc(x, y, b.rumor.r * s, 0, Math.PI * 2);
      mm.stroke();
      mm.setLineDash([]);
    }
  }
  const LAIR_COLORS = { common: "#d0d0dc", rare: "#4f8ee0", epic: "#8f52d4", legendary: "#f6c33b" };
  for (const l of G.lairs) {
    const x = Math.round((l.x - hx + R) * s);
    const y = Math.round((l.y - hy + R) * s);
    if (x < -6 || y < -6 || x > 174 || y > 174) continue;
    const r = l.tier === "legendary" ? 5 : l.tier === "epic" ? 4 : 3;
    mm.fillStyle = "#1b1626";
    mm.beginPath();
    mm.moveTo(x, y - r - 2);
    mm.lineTo(x + r + 2, y);
    mm.lineTo(x, y + r + 2);
    mm.lineTo(x - r - 2, y);
    mm.fill();
    mm.fillStyle = l.readyAt > G.now() ? "#6f6e82" : LAIR_COLORS[l.tier];
    mm.beginPath();
    mm.moveTo(x, y - r);
    mm.lineTo(x + r, y);
    mm.lineTo(x, y + r);
    mm.lineTo(x - r, y);
    mm.fill();
  }
  if (G.me?.home) {
    const x = Math.round((G.me.home.x - hx + R) * s);
    const y = Math.round((G.me.home.y - hy + R) * s);
    mm.fillStyle = "#1b1626";
    mm.fillRect(x - 4, y - 4, 9, 9);
    mm.fillStyle = "#3e74d6";
    mm.fillRect(x - 3, y - 3, 7, 7);
    mm.fillStyle = "#f6c33b";
    mm.fillRect(x - 1, y - 1, 3, 3);
  }
  if (Math.floor(performance.now() / 400) % 2) {
    mm.fillStyle = "#fff";
    mm.fillRect(84 - 3, 84 - 3, 6, 6);
    mm.fillStyle = "#1b1626";
    mm.fillRect(84 - 1, 84 - 1, 2, 2);
  }
}
$("minimap").addEventListener("click", () => openMap(G));

// ── Feed ──────────────────────────────────────────────────────────────
let feedSince = 0;
let tickerMarket = null;
const TICKER_LABEL = { chain: "On Solana", crier: "Town crier", duel: "Colosseum", battle: "Battle", boss: "Bosses", economy: "Treasury" };
$("ticker").addEventListener("click", (e) => {
  if (tickerMarket && !(e.target instanceof HTMLAnchorElement)) openOdds(G, tickerMarket);
});
async function pollFeed() {
  try {
    const r = await api(`/api/feed?since=${feedSince}`);
    if (!r.items.length) return;
    const first = feedSince === 0;
    feedSince = r.items[r.items.length - 1].at;
    const last = r.items[r.items.length - 1];
    $("ticker-text").innerHTML = `${esc(last.kind === "crier" ? last.text.replace(/^Town crier: /, "") : last.text)}${last.explorer ? ` <a href="${esc(last.explorer)}" target="_blank" rel="noopener">view tx</a>` : ""}`;
    $("ticker-label").textContent = TICKER_LABEL[last.kind] ?? "Realm news";
    tickerMarket = last.kind === "crier" ? last.market : null;
    $("ticker").classList.toggle("clickable", !!tickerMarket);
    if (first) return;
    for (const it of r.items) {
      if (it.kind === "crier") crierShout(it);
      if (it.player !== G.me?.id) continue;
      if (it.kind === "chain") toast(it.text, "good");
      if (it.kind === "defend") toast(it.text, "good");
      if (it.kind === "badge") (toast(it.text, "gold"), sfx("coin"));
    }
  } catch {
    /* ignore */
  }
}

// ── Dock + keys ───────────────────────────────────────────────────────
$("btn-map").addEventListener("click", () => openMap(G));
$("btn-fortress").addEventListener("click", () => openFortress(G));
$("btn-army").addEventListener("click", () => openArmy(G));
$("btn-bag").addEventListener("click", () => openInventory(G));
$("btn-intel").addEventListener("click", () => openIntel(G));
$("btn-bank").addEventListener("click", () => openTreasury(G));
$("res-usdc").addEventListener("click", () => openTreasury(G, "overview"));
$("res-might").addEventListener("click", () => openTreasury(G, "overview"));
$("btn-profile").addEventListener("click", () => openProfile(G));
$("btn-arena").addEventListener("click", () => openColosseum(G));
$("btn-odds").addEventListener("click", () => openOdds(G));
$("btn-dev").addEventListener("click", () => openDev(G));
$("hud-chief").addEventListener("click", () => openProfile(G));
$("sheet-close").addEventListener("click", closeSheet);
$("sheet").addEventListener("click", (e) => e.target === $("sheet") && closeSheet());
$("btn-sound").addEventListener("click", () => {
  const on = sound.toggle();
  $("btn-sound").setAttribute("aria-pressed", String(on));
  $("sound-label").textContent = on ? "♪" : "✕";
});
$("sound-label").textContent = sound.on ? "♪" : "✕";

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || $("hud").hidden) return;
  const k = e.key.toLowerCase();
  if (k === "escape") {
    if (battleOpen()) return;
    if (!$("sheet").hidden) closeSheet();
    else if (mapOpen()) closeMap();
    return;
  }
  if (!$("sheet").hidden || mapOpen() || battleOpen()) return;
  if (k === "m") openMap(G);
  if (k === "h") recallHome();
  if (k === "`" && G.cfg.devTools) openDev(G);
  if (k === "f") openFortress(G);
  if (k === "r") openArmy(G);
  if (k === "b") openInventory(G);
  if (k === "i") openIntel(G);
  if (k === "t") openTreasury(G);
  if (k === "p") openProfile(G);
  if (k === "k") openColosseum(G);
  if (k === "o") openOdds(G);
});

// Pause walking while any overlay is up.
const obs = new MutationObserver(() => {
  const busy = !$("sheet").hidden || mapOpen() || battleOpen();
  G.view.paused = busy || $("hud").hidden;
  if (busy) G.view.keys.clear();
  tickPrompt();
});
for (const id of ["sheet", "mapview", "battle"]) obs.observe($(id), { attributes: true, attributeFilter: ["hidden"] });

void spriteUrl;
window.__stakeclash = G; // handy for debugging and the end-to-end test

// Restore this tab's session last: startGame needs everything above to exist. (Restoring it
// earlier ran startGame before the exploration state was set up, which threw, was swallowed,
// and left the game paused: the hero couldn't move after reopening the site.)
if (session.token) {
  G.me = await api("/api/me").catch(() => null);
  if (G.me) startGame();
}
