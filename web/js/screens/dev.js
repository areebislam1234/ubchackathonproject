// Dev panel for demos: edit your warlord, jump around the world, and steer bounties.
import { BADGES, BADGE_IDS, BOSSES, BOSS_TIERS, BUILDINGS, MATERIAL_KEYS, RELIC_KEYS, UNITS, UNIT_KEYS } from "/shared/rules.js";
import { REALMS, placeBossLairs } from "/shared/world.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { act, closeSheet, esc, fmt, openSheet, timeLeft, toast } from "../ui.js";

let tab = "warlord";
let confirmReset = false;

async function setPlayer(G, patch, msg) {
  await api("/api/dev/player", { body: patch });
  await G.refreshMe();
  if (msg) toast(msg, "good");
  sfx("coin");
}

export async function openDev(G) {
  const tabs = [
    ["warlord", "Warlord"],
    ["world", "World"],
    ["bounties", "Bounties"],
    ["bosses", "Bosses"],
  ];
  const html = `
    <h2>Dev tools</h2>
    <p class="sub">For demos. Changes apply to your warlord instantly. Turn this panel off with <code>DEV_TOOLS=off</code> before sharing the game publicly.</p>
    <div class="chips" style="margin-bottom:12px">${tabs.map(([k, l]) => `<button class="chip" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div>
    <div id="dtab">${tab === "warlord" ? warlordTab(G) : tab === "world" ? worldTab(G) : tab === "bosses" ? bossesTab(G) : await bountiesTab(G)}</div>`;
  const body = openSheet("dev", html);
  for (const b of body.querySelectorAll("[data-tab]"))
    b.addEventListener("click", () => {
      tab = b.dataset.tab;
      confirmReset = false;
      sfx("click");
      openDev(G);
    });
  wire(G, body);
}

// ── Warlord ───────────────────────────────────────────────────────────
function stepper(attr, value, label) {
  return `<span class="stepper"><button class="btn btn-small btn-ghost" ${attr} data-d="-1" aria-label="Lower ${esc(label)}">−</button><output>${value}</output><button class="btn btn-small btn-ghost" ${attr} data-d="1" aria-label="Raise ${esc(label)}">+</button></span>`;
}

function warlordTab(G) {
  const m = G.me;
  return `
    <h3>Resources</h3>
    <div class="dev-grid">
      <label>Gold<input id="d-gold" type="number" min="0" value="${m.gold}"></label>
      <label>Crystals<input id="d-crystals" type="number" min="0" value="${m.crystals}"></label>
      <label>Trophies<input id="d-trophies" type="number" min="0" value="${m.trophies}"></label>
      <button class="btn btn-go btn-small" id="d-save">Set</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn btn-small btn-gold" data-add-gold="1000">+1,000 gold</button>
      <button class="btn btn-small btn-gold" data-add-gold="10000">+10,000 gold</button>
      <button class="btn btn-small btn-crystal" data-add-crystals="100">+100 crystals</button>
      <button class="btn btn-small btn-crystal" data-add-crystals="1000">+1,000 crystals</button>
      <button class="btn btn-small btn-fight" id="d-max">Max everything</button>
    </div>
    <p class="note">Gold above your Vault's capacity stays, but new income only fills up to the cap.</p>
    <h3>Fortress</h3>
    <table class="board"><tbody>${Object.entries(BUILDINGS)
      .filter(([k]) => k !== "trophy")
      .map(([k, def]) => `<tr><td>${esc(def.name)}</td><td class="num">${stepper(`data-bld="${k}"`, `${m.buildings[k]}/${def.max}`, def.name)}</td></tr>`)
      .join("")}</tbody></table>
    <h3>Army</h3>
    <table class="board"><thead><tr><th>Unit</th><th class="num">Count</th><th class="num">Level</th></tr></thead><tbody>${UNIT_KEYS.map(
      (k) =>
        `<tr><td>${esc(UNITS[k].name)}</td><td class="num">${stepper(`data-army="${k}"`, m.army[k] ?? 0, `${UNITS[k].name} count`)} <button class="btn btn-small btn-ghost" data-army10="${k}">+10</button></td><td class="num">${stepper(`data-ulvl="${k}"`, m.unitLevels[k] ?? 1, `${UNITS[k].name} level`)}</td></tr>`,
    ).join("")}</tbody></table>
    <h3>Badges</h3>
    <div class="row">${BADGE_IDS.map((id) => `<button class="btn btn-small ${m.badges[id] ? "btn-ghost" : "btn-gold"}" data-badge="${id}" ${m.badges[id] ? "disabled" : ""}>${esc(BADGES[id].name)}</button>`).join("")}</div>
    <p class="note">Granted badges mint to your wallet like earned ones.</p>
    <h3>Reset</h3>
    <button class="btn btn-small btn-fight" id="d-reset">${confirmReset ? "Click again to reset everything" : "Reset my progress"}</button>
    <span class="note">Gold, crystals, trophies, fortress and army go back to a new warlord's. Your account, wallet and badges stay.</span>`;
}

// ── World ─────────────────────────────────────────────────────────────
function worldTab(G) {
  const hx = Math.floor(G.view.hero.x / 16);
  const hy = Math.floor(G.view.hero.y / 16);
  return `
    <h3>Map</h3>
    <div class="row">
      <button class="btn btn-small btn-go" id="d-reveal">Reveal the whole map and attune every waystone</button>
      <button class="btn btn-small btn-blue" id="d-combat">Clear combat cooldown</button>
    </div>
    <h3>Teleport</h3>
    <div class="row">
      ${G.me.home ? `<button class="btn btn-small btn-blue" data-tp="${G.me.home.x},${G.me.home.y + 2}">Your fortress</button>` : ""}
      ${G.world.towns.map((t) => `<button class="btn btn-small btn-ghost" data-tp="${t.waystone.x},${t.waystone.y}">${esc(t.name)} · ${esc(REALMS.find((r) => r.id === t.realm).category)}</button>`).join("")}
    </div>
    <div class="dev-grid" style="margin-top:8px">
      <label>X (0–383)<input id="d-x" type="number" min="0" max="383" value="${hx}"></label>
      <label>Y (0–383)<input id="d-y" type="number" min="0" max="383" value="${hy}"></label>
      <button class="btn btn-small btn-go" id="d-go">Teleport</button>
    </div>
    <p class="note">You're at ${hx}, ${hy}. Teleports land on the nearest walkable tile.</p>`;
}

// ── Bounties ──────────────────────────────────────────────────────────
async function bountiesTab(G) {
  const { bounties, now } = await api("/api/dev/bounties");
  const when = (b) => (b.status === "upcoming" ? `opens in ${timeLeft(b.startsAt - now)}` : b.status === "active" ? `${timeLeft(b.endsAt - now)} left` : b.status);
  return `
    <h3>Spawn a bounty</h3>
    <div class="dev-grid">
      <label>Realm<select id="d-realm">${REALMS.map((r) => `<option value="${r.id}">${esc(r.name)} (${esc(r.category)})</option>`).join("")}</select></label>
      <label>Tier<select id="d-tier"><option value="">Random</option><option value="common">Common</option><option value="rare">Rare</option><option value="epic">Epic</option></select></label>
      <label class="check"><input id="d-feat" type="checkbox"> Featured</label>
      <button class="btn btn-small btn-go" id="d-spawn">Spawn and go there</button>
    </div>
    <h3>Every live bounty <span class="note">(questions shown here only)</span></h3>
    <table class="board"><thead><tr><th>Bounty</th><th>Status</th><th></th></tr></thead><tbody>${bounties
      .map(
        (b) => `<tr><td><b>${esc(b.id)}</b> <span class="tag ${b.tier}">${b.tier}</span>${b.featured ? ' <span class="tag featured">F</span>' : ""}<br><span class="note">${esc(REALMS.find((r) => r.id === b.realm).name)} · ${b.participants} in · ${esc(b.question)}</span></td>
        <td>${esc(when(b))}</td>
        <td class="num"><span class="row" style="justify-content:flex-end;gap:4px">
          <button class="btn btn-small btn-blue" data-goto="${b.id}" data-x="${b.x}" data-y="${b.y}">Go</button>
          ${b.status === "upcoming" ? `<button class="btn btn-small btn-ghost" data-dev-act="start" data-id="${b.id}">Start</button>` : ""}
          ${b.status === "active" ? `<button class="btn btn-small btn-ghost" data-dev-act="end" data-id="${b.id}">End</button>` : ""}
          ${b.status === "revealed" && G.cfg.mockGemini ? `<button class="btn btn-small btn-ghost" data-dev-act="settle-yes" data-id="${b.id}">YES</button><button class="btn btn-small btn-ghost" data-dev-act="settle-no" data-id="${b.id}">NO</button>` : ""}
        </span></td></tr>`,
      )
      .join("")}</tbody></table>`;
}

// ── Wiring ────────────────────────────────────────────────────────────
// ── Bosses ────────────────────────────────────────────────────────────
let allLairs = null;
function bossesTab(G) {
  allLairs ??= placeBossLairs(G.world, BOSSES);
  const found = new Set(G.lairs.map((l) => l.id));
  const order = { legendary: 0, epic: 1, rare: 2, common: 3 };
  const rows = [...allLairs].sort((a, b) => order[a.tier] - order[b.tier] || a.realm.localeCompare(b.realm));
  return `
    <h3>Loot</h3>
    <div class="row" style="flex-wrap:wrap">
      <button class="btn btn-small btn-go" id="d-loot">Fill the Bag: 30 materials, a manual per unit, 3 scrolls</button>
      <button class="btn btn-small btn-gold" id="d-relics">Grant every relic</button>
      <button class="btn btn-small btn-blue" id="d-cool">Reset all boss cooldowns</button>
      <button class="btn btn-small btn-gold" id="d-drills">+12 drill points, reset today's limit</button>
    </div>
    <h3>Intelligence</h3>
    <div class="row" style="flex-wrap:wrap">
      <span class="note">Next boss win drops a report of rarity:</span>
      ${["common", "rare", "epic", "legendary"].map((r) => `<button class="btn btn-small btn-ghost" data-intel="${r}">${r}</button>`).join("")}
    </div>
    <p class="note">Arena Plains bosses carry sports intel, Ironvein crypto, Goldmarsh economics, the rest general (politics, weather, commodities, culture).</p>
    <h3>Every lair <span class="note">(${found.size}/${allLairs.length} found)</span></h3>
    <table class="board"><thead><tr><th>Boss</th><th>Tier</th><th>Realm</th><th></th></tr></thead><tbody>${rows
      .map((l) => `<tr><td>${esc(BOSSES[l.id].name)}${found.has(l.id) ? "" : ' <span class="note">(unfound)</span>'}</td><td>${esc(BOSS_TIERS[l.tier].name)}</td><td>${esc(REALMS.find((r) => r.id === l.realm)?.name ?? l.realm)}</td><td><button class="btn btn-small btn-blue" data-lair="${l.x},${l.y}">Go</button></td></tr>`)
      .join("")}</tbody></table>`;
}

function teleport(G, x, y) {
  G.view.teleport(x, y);
  closeSheet();
  sfx("waystone");
  setTimeout(() => G.refreshBounties(), 1800);
}

function wire(G, body) {
  const on = (sel, fn) => body.querySelector(sel)?.addEventListener("click", (e) => act(e.currentTarget, fn));
  const each = (sel, fn) => body.querySelectorAll(sel).forEach((b) => b.addEventListener("click", (e) => act(e.currentTarget, () => fn(b))));
  const rerender = () => openDev(G);
  // warlord
  on("#d-save", async () => {
    await setPlayer(G, { gold: body.querySelector("#d-gold").value, crystals: body.querySelector("#d-crystals").value, trophies: body.querySelector("#d-trophies").value }, "Resources set.");
    rerender();
  });
  each("[data-add-gold]", async (b) => (await setPlayer(G, { gold: G.me.gold + Number(b.dataset.addGold) }), rerender()));
  each("[data-add-crystals]", async (b) => (await setPlayer(G, { crystals: G.me.crystals + Number(b.dataset.addCrystals) }), rerender()));
  on("#d-max", async () => {
    await setPlayer(
      G,
      {
        gold: 50000,
        crystals: 2000,
        buildings: { keep: 5, barracks: 5, training: 5, vault: 5, towers: 5 },
        unitLevels: Object.fromEntries(UNIT_KEYS.map((k) => [k, 5])),
        army: { infantry: 12, archer: 10, tank: 4, cavalry: 4, siege: 2 },
      },
      "Maxed out: 50k gold, every building and unit at level 5.",
    );
    rerender();
  });
  each("[data-bld]", async (b) => {
    const k = b.dataset.bld;
    await setPlayer(G, { buildings: { [k]: G.me.buildings[k] + Number(b.dataset.d) } });
    rerender();
  });
  each("[data-army]", async (b) => {
    const k = b.dataset.army;
    await setPlayer(G, { army: { [k]: (G.me.army[k] ?? 0) + Number(b.dataset.d) } });
    rerender();
  });
  each("[data-army10]", async (b) => {
    const k = b.dataset.army10;
    await setPlayer(G, { army: { [k]: (G.me.army[k] ?? 0) + 10 } });
    rerender();
  });
  each("[data-ulvl]", async (b) => {
    const k = b.dataset.ulvl;
    await setPlayer(G, { unitLevels: { [k]: (G.me.unitLevels[k] ?? 1) + Number(b.dataset.d) } });
    rerender();
  });
  each("[data-badge]", async (b) => {
    await api("/api/dev/badge", { body: { badge: b.dataset.badge } });
    await G.refreshMe();
    toast(`Granted ${BADGES[b.dataset.badge].name}.`, "gold");
    rerender();
  });
  on("#d-reset", async () => {
    if (!confirmReset) {
      confirmReset = true;
      return rerender();
    }
    confirmReset = false;
    await api("/api/dev/reset", { body: {} });
    await G.refreshMe();
    toast("Progress reset.", "good");
    rerender();
  });
  // world
  on("#d-reveal", async () => {
    await api("/api/dev/reveal", { body: {} });
    await G.refreshMe();
    G.view.setExplored(Uint8Array.from(atob(G.me.explored), (c) => c.charCodeAt(0)));
    await G.refreshBounties();
    toast("The whole map is revealed and every waystone is attuned.", "good");
    sfx("discover");
  });
  on("#d-combat", async () => {
    await api("/api/dev/clear-combat", { body: {} });
    await G.refreshMe();
    toast("Combat cooldown cleared. You can recall home.", "good");
  });
  each("[data-tp]", async (b) => {
    const [x, y] = b.dataset.tp.split(",").map(Number);
    teleport(G, x, y);
  });
  on("#d-go", async () => teleport(G, Number(body.querySelector("#d-x").value), Number(body.querySelector("#d-y").value)));
  // bounties
  on("#d-spawn", async () => {
    const r = await api("/api/dev/spawn", { body: { realm: body.querySelector("#d-realm").value, tier: body.querySelector("#d-tier").value, featured: body.querySelector("#d-feat").checked || undefined } });
    toast(`Spawned ${r.id}.`, "good");
    teleport(G, r.x, r.y + 2);
  });
  each("[data-goto]", async (b) => teleport(G, Number(b.dataset.x), Number(b.dataset.y) + 2));
  // bosses
  each("[data-lair]", async (b) => {
    const [x, y] = b.dataset.lair.split(",").map(Number);
    teleport(G, x, y + 3);
    setTimeout(() => G.refreshLairs(), 1800);
  });
  on("#d-loot", async () => {
    const inv = G.me.inventory ?? { materials: {}, manuals: {}, scrolls: 0 };
    await setPlayer(G, { inventory: { materials: Object.fromEntries(MATERIAL_KEYS.map((k) => [k, (inv.materials[k] ?? 0) + 10])), manuals: Object.fromEntries(UNIT_KEYS.map((k) => [k, (inv.manuals[k] ?? 0) + 1])), scrolls: (inv.scrolls ?? 0) + 3 } }, "Bag filled.");
    rerender();
  });
  on("#d-drills", async () => (await setPlayer(G, { drills: { pool: (G.me.drills?.pool ?? 0) + 12, resetToday: true } }, "12 drill points added; today's limit reset."), rerender()));
  on("#d-relics", async () => (await setPlayer(G, { inventory: { relics: RELIC_KEYS } }, "Every relic granted."), rerender()));
  on("#d-cool", async () => {
    await api("/api/dev/boss-cooldowns", { body: {} });
    await G.refreshLairs();
    toast("Every boss is back in its lair.", "good");
  });
  each("[data-intel]", async (b) => {
    await api("/api/dev/next-intel", { body: { rarity: b.dataset.intel } });
    toast(`Your next boss win drops a ${b.dataset.intel} intelligence report.`, "good");
  });
  each("[data-dev-act]", async (b) => {
    const [k, side] = b.dataset.devAct.split("-");
    if (k === "start") await api(`/api/dev/start/${b.dataset.id}`, { body: {} });
    if (k === "end") (await api(`/api/dev/end/${b.dataset.id}`, { body: {} }), sfx("reveal"));
    if (k === "settle") await api(`/api/dev/settle/${b.dataset.id}`, { body: { side } });
    await Promise.all([G.refreshMe(), G.refreshBounties()]);
    toast(`${b.dataset.id}: ${k === "settle" ? `settled ${side.toUpperCase()}` : k === "end" ? "battles ended, question revealed" : "battles started"}.`, "good");
    rerender();
  });
}
