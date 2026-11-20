// Formations: the 3x3 grid your army fights in, the tactical order, and the presets. Used by the
// Formation screen and by attack prep (bounties and boss lairs).
import { CLASSES, ORDERS, ORDER_KEYS, PRESETS, PRESET_KEYS, UNITS, UNIT_CLASS, UNIT_KEYS, autoFormation, formationArmy } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { spriteUrl } from "../gfx.js";
import { act, esc, openSheet, toast } from "../ui.js";

const ROWS = ["Front", "Mid", "Back"];
const LANES = ["Left", "Centre", "Right"];
const CLASS_COLOR = { guardian: "#7ba8f2", raider: "#f07c4f", ranger: "#8ad14e", artillery: "#c49bf2", support: "#fff3a6" };

let draft = null; // { slots, order, preset, manual }
let picked = 0;

/** Lane-by-lane notes: which backline troops a Guardian covers, and which would be exposed. */
function laneNotes(slots) {
  return [0, 1, 2].map((lane) => {
    const front = slots[lane];
    const behind = [slots[3 + lane], slots[6 + lane]].filter(Boolean);
    const guard = [front, slots[3 + lane]].find((s) => s && UNIT_CLASS[s.unit] === "guardian");
    if (!behind.length) return `${LANES[lane]}: ${front ? "front only" : "empty"}`;
    if (guard) return `${LANES[lane]}: ${UNITS[guard.unit].name} cover the troops behind`;
    if (front) return `${LANES[lane]}: front holds, but nobody absorbs hits for the troops behind`;
    return `${LANES[lane]}: exposed (no frontline: troops behind take +25% damage)`;
  });
}

export function formationGrid(slots, { selectable = false, selected = -1 } = {}) {
  return `<div class="fgrid" role="grid" aria-label="Formation: front row nearest the enemy">
    <div class="fgrid-enemy">▲ enemy ▲</div>
    ${[0, 1, 2]
      .map(
        (row) => `<div class="fgrid-row"><span class="fgrid-label">${ROWS[row]}</span>${[0, 1, 2]
          .map((lane) => {
            const i = row * 3 + lane;
            const s = slots[i];
            const cls = s ? UNIT_CLASS[s.unit] : null;
            return `<button class="fslot ${i === selected ? "on" : ""} ${s ? "" : "empty"}" ${selectable ? `data-slot="${i}"` : "disabled"} style="${cls ? `border-color:${CLASS_COLOR[cls]}` : ""}" aria-label="${ROWS[row]} ${LANES[lane]}: ${s ? `${s.n} ${UNITS[s.unit].name}` : "empty"}">
              ${s ? `<img src="${spriteUrl(`${s.unit}_0`, 2)}" alt="" width="32" height="32"><b>×${s.n}</b><span>${esc(UNITS[s.unit].name)}</span>` : `<span>empty</span>`}
            </button>`;
          })
          .join("")}</div>`,
      )
      .join("")}
  </div>`;
}

const orderChips = (cur) => `<div class="chips">${ORDER_KEYS.map((k) => `<button class="chip" data-order="${k}" aria-pressed="${cur === k}" title="${esc(ORDERS[k].desc)}">${esc(ORDERS[k].name)}</button>`).join("")}</div><p class="note" id="f-order-desc">${esc(ORDERS[cur]?.desc ?? "")}</p>`;
const presetChips = (cur) => `<div class="chips">${PRESET_KEYS.map((k) => `<button class="chip" data-preset="${k}" aria-pressed="${cur === k}" title="${esc(PRESETS[k].desc)}">${esc(PRESETS[k].name)}</button>`).join("")}</div>`;

/** The Formation screen: pick a preset, place troops by hand, pick an order, save. */
export function openFormation(G) {
  const m = G.me;
  draft ??= { slots: m.formation.slots.map((s) => (s ? { ...s } : null)), order: m.formation.order, preset: m.formation.preset ?? null, manual: m.formation.manual };
  const placed = formationArmy(draft);
  const left = Object.fromEntries(UNIT_KEYS.map((k) => [k, (m.army[k] ?? 0) - (placed[k] ?? 0)]));
  const sel = draft.slots[picked];
  const body = openSheet(
    "formation",
    `
    <h2>Formation</h2>
    <p class="sub">Where each stack stands changes the fight. Guardians in front absorb part of the damage aimed at troops behind them in their lane; a lane with no frontline leaves its backline exposed (+25% damage). Raiders dive at the backline, and from a wing lane they slip past half the Guardians' protection. Artillery punishes big stacks. This formation also defends you inside bounties.</p>
    <h3>Preset</h3>
    ${presetChips(draft.manual ? null : draft.preset)}
    <p class="note">${esc(draft.manual ? "Hand-placed formation." : (PRESETS[draft.preset]?.desc ?? ""))}</p>
    <div class="fgrid-wrap">
      ${formationGrid(draft.slots, { selectable: true, selected: picked })}
      <div class="fpanel">
        <h4>${ROWS[Math.floor(picked / 3)]} ${LANES[picked % 3]}</h4>
        ${sel ? `<p class="stats">${sel.n} ${esc(UNITS[sel.unit].name)} · ${esc(CLASSES[UNIT_CLASS[sel.unit]].name)}</p><div class="stepper"><button class="btn btn-small btn-ghost" data-n="-1">−</button><output>${sel.n}</output><button class="btn btn-small btn-ghost" data-n="1" ${left[sel.unit] > 0 ? "" : "disabled"}>+</button><button class="btn btn-small btn-ghost" data-clear>Clear</button></div>` : `<p class="note">Empty. Put a unit here:</p>`}
        <div class="fpick">${UNIT_KEYS.filter((k) => (m.army[k] ?? 0) > 0)
          .map((k) => `<button class="btn btn-small ${sel?.unit === k ? "btn-gold" : "btn-ghost"}" data-unit="${k}" ${left[k] > 0 || sel?.unit === k ? "" : "disabled"} title="${esc(CLASSES[UNIT_CLASS[k]].role)}"><img src="${spriteUrl(`${k}_0`, 1)}" alt="" width="16" height="16"> ${esc(UNITS[k].name)} <span class="note">${left[k]} left</span></button>`)
          .join("")}</div>
        <ul class="lane-notes">${laneNotes(draft.slots).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
        ${Object.values(left).some((n) => n > 0) ? `<p class="note">Not placed: ${UNIT_KEYS.filter((k) => left[k] > 0).map((k) => `${left[k]} ${esc(UNITS[k].name)}`).join(", ")}. Unplaced troops stay home.</p>` : ""}
      </div>
    </div>
    <h3>Tactical order</h3>
    ${orderChips(draft.order)}
    <h3>Classes</h3>
    <div class="class-cards">${Object.entries(CLASSES)
      .map(([k, c]) => `<div class="class-card" style="border-color:${CLASS_COLOR[k]}"><b>${esc(c.name)}</b> <span class="note">${UNIT_KEYS.filter((u) => UNIT_CLASS[u] === k).map((u) => esc(UNITS[u].name)).join(", ")}</span><p>${esc(c.role)}</p>${c.strong.length ? `<p class="note">Strong vs ${c.strong.map((s) => CLASSES[s].name).join(", ")}</p>` : ""}${c.weak.length ? `<p class="note">Weak vs ${c.weak.map((s) => CLASSES[s].name).join(", ")}</p>` : ""}</div>`)
      .join("")}</div>
    <div class="row" style="margin-top:12px"><button class="btn btn-go btn-big" id="f-save">Save formation</button><button class="btn btn-ghost" id="f-reset">Discard changes</button></div>
  `,
    { onClose: () => (draft = null) },
  );
  const rerender = () => openFormation(G);
  for (const b of body.querySelectorAll("[data-slot]")) b.addEventListener("click", () => ((picked = Number(b.dataset.slot)), sfx("click"), rerender()));
  for (const b of body.querySelectorAll("[data-preset]"))
    b.addEventListener("click", () => {
      const f = autoFormation(m.army, b.dataset.preset, PRESETS[b.dataset.preset].order);
      draft = { slots: f.slots, order: f.order, preset: b.dataset.preset, manual: false };
      sfx("click");
      rerender();
    });
  for (const b of body.querySelectorAll("[data-order]")) b.addEventListener("click", () => ((draft.order = b.dataset.order), sfx("click"), rerender()));
  for (const b of body.querySelectorAll("[data-unit]"))
    b.addEventListener("click", () => {
      const k = b.dataset.unit;
      if (draft.slots[picked]?.unit === k) return;
      draft.slots[picked] = { unit: k, n: Math.max(1, Math.min(left[k], Math.ceil((m.army[k] ?? 0) / 3))) };
      draft.manual = true;
      sfx("click");
      rerender();
    });
  for (const b of body.querySelectorAll("[data-n]"))
    b.addEventListener("click", () => {
      const s = draft.slots[picked];
      s.n = Math.max(0, s.n + Number(b.dataset.n));
      if (!s.n) draft.slots[picked] = null;
      draft.manual = true;
      rerender();
    });
  body.querySelector("[data-clear]")?.addEventListener("click", () => ((draft.slots[picked] = null), (draft.manual = true), rerender()));
  body.querySelector("#f-reset").addEventListener("click", () => ((draft = null), rerender()));
  body.querySelector("#f-save").addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const payload = draft.manual ? { slots: draft.slots, order: draft.order } : { preset: draft.preset, order: draft.order };
      G.me = await api("/api/army/formation", { body: payload });
      draft = null;
      sfx("upgrade");
      toast("Formation saved. It's also how you defend inside bounties.", "good");
      rerender();
    }),
  );
}

/** Attack prep: choose this fight's formation (saved or a preset) and order. Returns the plan getter. */
export function planPicker(G, host) {
  const m = G.me;
  const state = { preset: null, order: m.formation.order };
  const render = () => {
    const f = state.preset ? autoFormation(m.army, state.preset, state.order) : { ...m.formation, order: state.order };
    host.innerHTML = `
      <h3>Formation</h3>
      <div class="chips"><button class="chip" data-p="" aria-pressed="${!state.preset}">My formation</button>${PRESET_KEYS.map((k) => `<button class="chip" data-p="${k}" aria-pressed="${state.preset === k}" title="${esc(PRESETS[k].desc)}">${esc(PRESETS[k].name)}</button>`).join("")}</div>
      <div class="fgrid-wrap compact">${formationGrid(f.slots)}<div class="fpanel"><ul class="lane-notes">${laneNotes(f.slots).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div></div>
      <h3>Order</h3>
      ${orderChips(state.order)}`;
    for (const b of host.querySelectorAll("[data-p]"))
      b.addEventListener("click", () => {
        state.preset = b.dataset.p || null;
        if (state.preset) state.order = PRESETS[state.preset].order;
        else state.order = m.formation.order;
        sfx("click");
        render();
      });
    for (const b of host.querySelectorAll("[data-order]")) b.addEventListener("click", () => ((state.order = b.dataset.order), sfx("click"), render()));
  };
  render();
  return () => (state.preset ? { preset: state.preset, order: state.order } : { order: state.order });
}
