// Class abilities: unlocked once with Might, up to MAX_LOADOUT brought into each battle.
// Used by the Army screen (unlock and choose the saved loadout) and attack prep (this fight only).
import { ABILITIES, ABILITY_KEYS, CLASSES, MAX_LOADOUT, UNIT_CLASS } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon } from "../gfx.js";
import { act, esc, fmt, toast } from "../ui.js";

const CLASS_ORDER = ["guardian", "raider", "ranger", "artillery", "support"];
const classOpen = (m, cls) => (m.derived?.unlocked ?? []).some((u) => UNIT_CLASS[u] === cls);

/** The Abilities panel for the Army screen. */
export function abilityPanel(m) {
  const ab = m.abilities ?? { unlocked: [], loadout: [] };
  const might = m.might ?? 0;
  const cards = CLASS_ORDER.map((cls) => {
    const keys = ABILITY_KEYS.filter((k) => ABILITIES[k].cls === cls);
    const open = classOpen(m, cls);
    return `<div class="ab-class"><h4>${esc(CLASSES[cls]?.name ?? cls)}</h4>${keys
      .map((k) => {
        const a = ABILITIES[k];
        const have = ab.unlocked.includes(k);
        const brought = ab.loadout.includes(k);
        const btn = have
          ? `<button class="btn btn-small ${brought ? "btn-gold" : "btn-ghost"}" data-ab="bring:${k}" aria-pressed="${brought}" ${!brought && ab.loadout.length >= MAX_LOADOUT ? "title='Leave another ability first'" : ""}>${brought ? "Bringing" : "Bring"}</button>`
          : open
            ? `<button class="btn btn-crystal btn-small" data-ab="unlock:${k}" ${might >= a.cost ? "" : "disabled"}>Unlock<span class="cost">${fmt(a.cost)} Might</span></button>`
            : `<span class="note">Needs a ${esc(CLASSES[cls]?.name ?? cls)} unit</span>`;
        return `<div class="ab-card ${have ? "have" : ""} ${brought ? "on" : ""}"><div class="row spread"><b>${esc(a.name)}</b>${btn}</div><span class="stats">${esc(a.desc)}</span><span class="note">Answer: ${esc(a.counter)}</span></div>`;
      })
      .join("")}</div>`;
  }).join("");
  return `<div class="coach">${icon("bolt", 2)} <b>Abilities</b>: Might buys new tricks, not bigger numbers. Unlock class abilities once, then bring up to <b>${MAX_LOADOUT}</b> into each battle (they also defend you inside bounties). An ability only works if that class is on the field. You have <b>${fmt(might)}</b> Might; get more in the Treasury (T). Gold pays for troops, levels and buildings.</div>
    <div class="ab-grid">${cards}</div>`;
}

/** Wire the panel's buttons. `rerender` reopens the screen after a change. */
export function bindAbilityPanel(G, body, rerender) {
  for (const b of body.querySelectorAll("[data-ab]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const [kind, id] = b.dataset.ab.split(":");
        const ab = G.me.abilities ?? { loadout: [] };
        if (kind === "unlock") {
          await api("/api/army/ability", { body: { id } });
          toast(`${ABILITIES[id].name} unlocked`, "good");
          sfx("upgrade");
        } else {
          const has = ab.loadout.includes(id);
          if (!has && ab.loadout.length >= MAX_LOADOUT) throw new Error(`You can bring ${MAX_LOADOUT}. Leave one first.`);
          await api("/api/army/loadout", { body: { abilities: has ? ab.loadout.filter((k) => k !== id) : [...ab.loadout, id] } });
          sfx("click");
        }
        await G.refreshMe();
        rerender();
      }),
    );
}

/** Loadout chips for attack prep: returns the current pick and calls onChange on toggle. */
export function loadoutChips(m, picked) {
  const ab = m.abilities ?? { unlocked: [] };
  if (!ab.unlocked.length) return `<h3>Abilities</h3><p class="note">No abilities yet. Unlock them with Might in the Army screen (R).</p>`;
  return `<h3>Abilities <span class="note">(bring up to ${MAX_LOADOUT})</span></h3><div class="chips">${ab.unlocked
    .map((k) => `<button class="chip" data-abl="${k}" aria-pressed="${picked.includes(k)}" title="${esc(ABILITIES[k].desc)}">${esc(ABILITIES[k].name)}</button>`)
    .join("")}</div>`;
}
