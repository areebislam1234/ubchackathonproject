// A boss lair: who lives here, how strong it is, and what it guards.
import { armyPower } from "/shared/battle.js";
import { BOSS_TIERS, DRILLS, INTEL_CATEGORIES, RELICS, UNITS, UNIT_KEYS } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { act, closeSheet, currentSheet, esc, fmt, openSheet, timeLeft, toast } from "../ui.js";
import { openBattle } from "./battle.js";
import { planPicker } from "./formation.js";

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
    <div class="coach">${verdict} Siege and Shieldguards hit bosses 50% harder. Its guards stand in their own formation; pick yours below.</div>
    <h3>Guards</h3>
    <p class="stats">${UNIT_KEYS.filter((k) => d.army.units[k]).map((k) => `${d.army.units[k]} ${UNITS[k].name}`).join(" · ")} · level ${d.army.levels.infantry}${d.army.towers ? ` · ${d.army.towers} tower${d.army.towers > 1 ? "s" : ""}` : ""}</p>
    <h3>Spoils</h3>
    <p class="note">${icon("helmet", 1)} <b>${DRILLS.perTier[d.tier]} drill point${DRILLS.perTier[d.tier] > 1 ? "s" : ""}</b>: a minor army upgrade (+${DRILLS.perPoint * 100}% HP and damage per point for the unit you choose). You can earn ${DRILLS.dailyCap} a day; ${G.me.drills?.todayLeft ?? DRILLS.dailyCap} left today.${BOSS_TIERS[d.tier].loot.relic ? ` ${icon("crown", 1)} ${Math.round(BOSS_TIERS[d.tier].loot.relic * 100)}% chance of a relic.` : ""} ${icon(cat?.icon ?? "scroll", 1)} ${Math.round(BOSS_TIERS[d.tier].intel.chance * 100)}% chance of a <b>${esc(cat?.name ?? "")} intelligence report</b>. After every attempt it retreats for ${d.cooldownMin} minutes.</p>
    <div id="lair-plan"></div>
    <div class="row" id="lair-actions">${actionHtml(G, d, wait)}</div>
  `,
  );
  const body = document.getElementById("sheet-body");
  cur.plan = planPicker(G, body.querySelector("#lair-plan"));
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
  const r = await api(`/api/bosses/${d.id}/challenge`, { body: { ...cur.plan(), requestId: cur.requestId, pos: hero } });
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
  const parts = [];
  if (l.drillsLanded) parts.push([`${icon("helmet", 2)} <b>${l.drillsLanded} drill point${l.drillsLanded > 1 ? "s" : ""}</b>: assign them to a unit in the Army screen (R)${l.drillsLanded < l.drills ? ` · daily limit reached, ${l.drills - l.drillsLanded} didn't land` : ""}`, ""]);
  else if (l.drills) parts.push([`${icon("hourglass", 2)} You've earned today's ${DRILLS.dailyCap} drill points. Bosses still drop relics and intel; drills reset at midnight UTC.`, ""]);
  if (l.relic) parts.push([`${icon("crown", 2)} Relic: <b>${esc(RELICS[l.relic].name)}</b>. ${esc(RELICS[l.relic].desc)}`, "legendary"]);
  if (l.intel) parts.push([`${icon("eye", 2)} <b>${esc(l.intel.rarity[0].toUpperCase() + l.intel.rarity.slice(1))} intelligence report</b> recovered. Open Intel (I) to read it.`, l.intel.rarity]);
  return `<div class="loot-list">${parts.map(([x, cls]) => `<div class="loot-item ${cls}">${x}</div>`).join("")}</div>`;
}
