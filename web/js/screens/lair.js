// A boss lair: who lives here, how strong it is, and what it guards.
import { armyPower } from "/shared/battle.js";
import { INTEL_CATEGORIES, UNITS, UNIT_KEYS } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { act, closeSheet, currentSheet, esc, fmt, openSheet, timeLeft, toast } from "../ui.js";
import { openBattle } from "./battle.js";

let cur = null; // { id, data, send, requestId }
const reachFor = (scale) => 4 + (scale - 1) * 1.5;
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

export async function openLair(G, id) {
  try {
    const data = await api(`/api/bosses/${id}`);
    const me = G.me;
    cur = { id, data, send: Object.fromEntries(UNIT_KEYS.map((k) => [k, me.army[k] ?? 0])), requestId: newRequestId() };
    render(G);
  } catch (e) {
    toast(e.message, "bad");
  }
}

export async function refreshLairSheet(G) {
  if (!cur || currentSheet() !== "lair") return;
  try {
    cur.data = await api(`/api/bosses/${cur.id}`);
    render(G);
  } catch {
    /* keep what we have */
  }
}

function render(G) {
  const d = cur.data;
  const me = G.me;
  for (const k of UNIT_KEYS) cur.send[k] = Math.min(cur.send[k] ?? 0, me.army[k] ?? 0);
  const mine = armyPower(cur.send, me.unitLevels);
  const wait = d.readyAt - G.now();
  const portraitScale = { common: 4, rare: 5, epic: 6, legendary: 7 }[d.tier] ?? 4;
  const odds = mine / Math.max(1, mine + d.power);
  const verdict = odds > 0.62 ? "Your army should handle this." : odds > 0.48 ? "A close fight. Counters will decide it." : odds > 0.35 ? "Dangerous. Bring more troops or stronger levels." : "This boss will crush your current army.";
  const champ = d.army.champion;
  const cat = INTEL_CATEGORIES[d.intel.category];
  openSheet(
    "lair",
    `
    <div class="lair-head tier-${d.tier}">
      <div class="lair-portrait"><img src="${spriteUrl(`boss_${d.id}_0`, portraitScale)}" alt="" style="max-width:100%"></div>
      <div>
        <span class="tier-chip" style="background:${d.color}">${esc(d.tierName)} boss</span>
        <h2 style="margin:6px 0 2px">${esc(d.name)}</h2>
        <p class="sub" style="margin:0 0 6px">${esc(d.lore)}</p>
        <p class="note">${esc(d.realmName)} · Suggested Keep ${d.minKeep}+ · ${d.kills ? `Defeated ${d.kills}×` : "Never defeated by you"}</p>
      </div>
    </div>
    <div class="facts" style="grid-template-columns:repeat(4,1fr)">
      <div class="fact"><b>${fmt(champ.hp)}</b><span>Boss HP</span></div>
      <div class="fact"><b>${fmt(d.power)}</b><span>Lair power</span></div>
      <div class="fact"><b>${fmt(mine)}</b><span>Your power</span></div>
      <div class="fact"><b>${wait > 0 ? timeLeft(wait) : "Ready"}</b><span>${wait > 0 ? "Returns in" : "Status"}</span></div>
    </div>
    <div class="coach">${verdict} Siege and Tanks hit bosses hard; arrows barely scratch them.</div>
    <h3>Guards</h3>
    <p class="stats">${UNIT_KEYS.filter((k) => d.army.units[k]).map((k) => `${d.army.units[k]} ${UNITS[k].name}`).join(" · ")} · level ${d.army.levels.infantry}${d.army.towers ? ` · ${d.army.towers} tower${d.army.towers > 1 ? "s" : ""}` : ""}</p>
    <h3>Spoils</h3>
    <p class="note">${icon("coin", 1)} Gold, building materials and training manuals${d.tier !== "common" ? ", with a chance of upgrade scrolls and rare relics" : ""}. ${icon(cat?.icon ?? "scroll", 1)} Sometimes carries a <b>${esc(cat?.name ?? "")} intelligence report</b>. The stronger the boss, the better the odds. After every attempt it retreats for ${d.cooldownMin} minutes.</p>
    <h3>Your strike force</h3>
    <div class="cards" id="lair-send">${
      UNIT_KEYS.filter((k) => (me.army[k] ?? 0) > 0)
        .map(
          (k) => `<div class="card"><div class="row"><img src="${spriteUrl(`${k}_0`, 3)}" width="48" height="48" alt=""><div><h4>${UNITS[k].name}</h4><span class="stats">Lv ${me.unitLevels[k]}</span></div></div>
        <div class="stepper"><button class="btn btn-small btn-ghost" data-k="${k}" data-d="-1">−</button><output id="ln-${k}">${cur.send[k]}</output><button class="btn btn-small btn-ghost" data-k="${k}" data-d="1">+</button><span class="note">of ${me.army[k]}</span></div></div>`,
        )
        .join("") || `<p class="note">You have no units. Train some in the Army screen (R).</p>`
    }</div>
    <div class="row" id="lair-actions">${actionHtml(G, d, wait)}</div>
  `,
  );
  const body = document.getElementById("sheet-body");
  for (const b of body.querySelectorAll("[data-k]"))
    b.addEventListener("click", () => {
      const k = b.dataset.k;
      cur.send[k] = Math.max(0, Math.min(me.army[k] ?? 0, cur.send[k] + Number(b.dataset.d)));
      sfx("click");
      render(G);
    });
  body.querySelector("#lair-go")?.addEventListener("click", (e) => act(e.currentTarget, () => fight(G)));
  body.querySelector("#lair-walk")?.addEventListener("click", () => {
    if (G.setCourse(d.x, d.y + 1)) {
      G.view.pendingLair = d.id;
      closeSheet();
    }
  });
}

function heroDistance(G, d) {
  const hx = Math.floor(G.view.hero.x / 16);
  const hy = Math.floor((G.view.hero.y - 2) / 16);
  return Math.hypot(hx - d.x, hy - d.y);
}

function actionHtml(G, d, wait) {
  const far = heroDistance(G, d) > reachFor(d.scale);
  const none = !UNIT_KEYS.some((k) => cur.send[k] > 0);
  if (wait > 0) return `<button class="btn btn-big" disabled>Returns in ${timeLeft(wait)}</button><span class="note">Every attempt, won or lost, sends the boss back to its den for ${d.cooldownMin} minutes.</span>`;
  if (far) return `<button class="btn btn-go btn-big" id="lair-walk">Set course to the lair</button><span class="note">You need to stand at the lair to challenge it.</span>`;
  return `<button class="btn btn-fight btn-big" id="lair-go" ${none ? "disabled" : ""}>Challenge ${esc(d.name)}</button><span class="note">Units that fall are lost.</span>`;
}

async function fight(G) {
  const d = cur.data;
  const hero = { x: Math.floor(G.view.hero.x / 16), y: Math.floor((G.view.hero.y - 2) / 16) };
  // The same request id is reused if this click is retried, so the server never pays twice.
  const r = await api(`/api/bosses/${d.id}/challenge`, { body: { units: cur.send, requestId: cur.requestId, pos: hero } });
  cur.requestId = newRequestId();
  closeSheet();
  openBattle(G, r.battle, {
    doneLabel: "Back to the world",
    lootHtml: lootHtml(r),
    onDone: async () => {
      await Promise.all([G.refreshMe(), G.refreshLairs()]);
    },
  });
}

export function lootHtml(r) {
  if (!r.win) return `<p class="note">The boss drove you off. It retreats to its den for a while; train up and come back.</p>`;
  const l = r.loot ?? {};
  const parts = [`${icon("coin", 2)} <b>${fmt(l.goldLanded ?? l.gold ?? 0)}</b> gold${l.goldLanded < l.gold ? ` (vault full: ${fmt(l.gold - l.goldLanded)} lost)` : ""}`];
  return `<div class="loot-list">${parts.map((x) => `<div class="loot-item">${x}</div>`).join("")}</div>`;
}
