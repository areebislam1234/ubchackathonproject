// The Bag: everything bosses have dropped. Materials, training manuals, upgrade scrolls and relics.
import { MATERIALS, MATERIAL_GOLD_VALUE, MATERIAL_KEYS, MATERIAL_MAX_SHARE, RELICS, UNITS, UNIT_KEYS } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { act, esc, fmt, openSheet, toast } from "../ui.js";
import { openFortress } from "./fortress.js";

let picked = null; // the slot whose details are open
const SEEN_KEY = "stakeclash.bagSeen";

/** Total number of things in the bag, used for the "new items" badge on the dock. */
export function bagCount(m) {
  const inv = m?.inventory;
  if (!inv) return 0;
  return MATERIAL_KEYS.reduce((s, k) => s + (inv.materials[k] ?? 0), 0) + UNIT_KEYS.reduce((s, k) => s + (inv.manuals[k] ?? 0), 0) + (inv.scrolls ?? 0) + Object.keys(inv.relics ?? {}).length * 10;
}
export function unseenCount(m) {
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(`${SEEN_KEY}.${m.id}`) ?? 0);
  } catch {
    /* storage blocked: treat everything as seen */
    return 0;
  }
  return Math.max(0, bagCount(m) - seen);
}
function markSeen(m) {
  try {
    localStorage.setItem(`${SEEN_KEY}.${m.id}`, String(bagCount(m)));
  } catch {
    /* fine */
  }
}

const MATERIAL_ICON = { timber: "chest", stone: "castle", iron: "shield" };

export function openInventory(G) {
  const m = G.me;
  const inv = m.inventory ?? { materials: {}, manuals: {}, scrolls: 0, relics: {} };
  markSeen(m);
  G.renderBagBadge?.();
  const slot = (key, art, count, rarity, label) =>
    `<button class="bag-slot ${rarity} ${picked === key ? "on" : ""} ${count ? "" : "empty"}" data-slot="${key}" title="${esc(label)}" aria-label="${esc(label)}: ${count}">${art}${count > 1 ? `<span class="bag-n">${count}</span>` : ""}</button>`;
  const mats = MATERIAL_KEYS.map((k) => slot(`mat:${k}`, icon(MATERIAL_ICON[k], 3), inv.materials[k] ?? 0, "common", MATERIALS[k].name)).join("");
  const manuals = UNIT_KEYS.map((k) => slot(`man:${k}`, `<img src="${spriteUrl(`${k}_0`, 2)}" alt="" width="32" height="32">`, inv.manuals[k] ?? 0, "rare", `${UNITS[k].name} manual`)).join("");
  const scrolls = slot("scroll", icon("scroll", 3), inv.scrolls ?? 0, "epic", "Upgrade scroll");
  const owned = Object.keys(inv.relics ?? {});
  const relics = Object.keys(RELICS)
    .map((k) => slot(`relic:${k}`, icon(owned.includes(k) ? "crown" : "lock", 3), owned.includes(k) ? 1 : 0, owned.includes(k) ? RELICS[k].minTier : "", owned.includes(k) ? RELICS[k].name : "Undiscovered relic"))
    .join("");
  const totalMats = MATERIAL_KEYS.reduce((s, k) => s + (inv.materials[k] ?? 0), 0);
  const body = openSheet(
    "bag",
    `
    <h2>Bag</h2>
    <p class="sub">Spoils from boss lairs. Materials cut building costs, manuals and scrolls level up units for free, and relics give permanent bonuses.</p>
    <h3>Materials <span class="note">${fmt(totalMats)} · each saves ${MATERIAL_GOLD_VALUE} gold on an upgrade (up to ${Math.round(MATERIAL_MAX_SHARE * 100)}%)</span></h3>
    <div class="bag-grid">${mats}</div>
    <h3>Training manuals</h3>
    <div class="bag-grid">${manuals}</div>
    <h3>Upgrade scrolls</h3>
    <div class="bag-grid">${scrolls}</div>
    <h3>Relics <span class="note">${owned.length}/${Object.keys(RELICS).length}</span></h3>
    <div class="bag-grid">${relics}</div>
    <div id="bag-detail">${detail(G, inv)}</div>
  `,
  );
  for (const b of body.querySelectorAll("[data-slot]"))
    b.addEventListener("click", () => {
      picked = picked === b.dataset.slot ? null : b.dataset.slot;
      sfx("click");
      openInventory(G);
    });
  for (const b of body.querySelectorAll("[data-use]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const [use, unit] = b.dataset.use.split(":");
        const r = await api("/api/army/upgrade", { body: { unit, use } });
        sfx("upgrade");
        toast(`${UNITS[unit].name} trained to level ${r.level}`, "good");
        await G.refreshMe();
        openInventory(G);
      }),
    );
  body.querySelector("[data-fortress]")?.addEventListener("click", () => openFortress(G));
}

function detail(G, inv) {
  const m = G.me;
  if (!picked) return `<div class="coach">Pick an item to see what it does.</div>`;
  const [kind, key] = picked.split(":");
  if (kind === "mat") {
    const n = inv.materials[key] ?? 0;
    return `<div class="coach"><b>${esc(MATERIALS[key].name)}</b> ×${n}. ${esc(MATERIALS[key].desc)} Spend materials from the Fortress screen: tick "use materials" on an upgrade. <button class="btn btn-small btn-go" data-fortress style="margin-left:6px">Open Fortress</button></div>`;
  }
  if (kind === "man") {
    const n = inv.manuals[key] ?? 0;
    const lvl = m.unitLevels[key] ?? 1;
    const capped = lvl >= m.buildings.training;
    return `<div class="coach"><b>${esc(UNITS[key].name)} training manual</b> ×${n}. Raises ${esc(UNITS[key].name)} one level for free (currently Lv ${lvl}).
      ${n ? `<button class="btn btn-small btn-blue" data-use="manual:${key}" ${capped ? "disabled" : ""} style="margin-left:6px">Use</button>` : ""}${capped ? ` <span class="note">Upgrade the Training Grounds first (cap Lv ${m.buildings.training}).</span>` : ""}</div>`;
  }
  if (kind === "scroll") {
    const n = inv.scrolls ?? 0;
    const opts = UNIT_KEYS.filter((k) => m.derived.unlocked.includes(k))
      .map((k) => `<button class="btn btn-small btn-blue" data-use="scroll:${k}" ${(m.unitLevels[k] ?? 1) >= m.buildings.training || !n ? "disabled" : ""}>${esc(UNITS[k].name)} Lv ${m.unitLevels[k]}</button>`)
      .join(" ");
    return `<div class="coach"><b>Upgrade scroll</b> ×${n}. Raises any unit one level for free, up to your Training Grounds level.<div class="row" style="margin-top:6px;flex-wrap:wrap">${opts}</div></div>`;
  }
  if (kind === "relic") {
    const r = RELICS[key];
    const have = inv.relics?.[key];
    if (!have) return `<div class="coach">An undiscovered relic. ${r.minTier[0].toUpperCase() + r.minTier.slice(1)} bosses and stronger can drop it.</div>`;
    return `<div class="coach"><b>${esc(r.name)}</b>. ${esc(r.desc)} Always active.</div>`;
  }
  return "";
}
