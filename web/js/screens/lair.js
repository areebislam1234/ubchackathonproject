// A boss lair: who lives here, how strong it is, and what it guards.
import { armyPower } from "/shared/battle.js";
import { INTEL_CATEGORIES, UNITS, UNIT_KEYS } from "/shared/rules.js";
import { api } from "../api.js";
import { icon, spriteUrl } from "../gfx.js";
import { currentSheet, esc, fmt, openSheet, timeLeft, toast } from "../ui.js";

let cur = null; // { id, data }

export async function openLair(G, id) {
  try {
    const data = await api(`/api/bosses/${id}`);
    cur = { id, data };
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
  const mine = armyPower(me.army, me.unitLevels);
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
    <div id="lair-actions"></div>
  `,
  );
}
