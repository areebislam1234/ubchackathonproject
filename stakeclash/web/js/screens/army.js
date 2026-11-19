// Army management: train, disband and level up units.
import { armyPower } from "/shared/battle.js";
import { COUNTERS, UNITS, UNIT_KEYS, unitMult } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { act, esc, fmt, openSheet, toast } from "../ui.js";

const beats = (k) =>
  Object.entries(COUNTERS[k] ?? {})
    .filter(([, m]) => m > 1)
    .map(([t]) => (t === "tower" ? "towers" : UNITS[t]?.name))
    .join(", ");
const weakTo = (k) =>
  Object.entries(COUNTERS)
    .filter(([a, m]) => a !== "tower" && (m[k] ?? 1) > 1)
    .map(([a]) => UNITS[a].name)
    .join(", ");

export function openArmy(G) {
  const m = G.me;
  const d = m.derived;
  const body = openSheet(
    "army",
    `
    <h2>Army</h2>
    <p class="sub">Your army fights your attacks and, frozen at the moment you enter, defends you inside each bounty. Units that fall in an attack are gone, so keep training.</p>
    <div class="row spread"><b style="font:400 22px var(--display)">Housing ${d.housing}/${d.capacity}</b><span class="note">${icon("coin", 2)} ${fmt(m.gold)} gold · power ${armyPower(m.army, m.unitLevels)}</span></div>
    <div class="capbar"><i style="width:${Math.min(100, (d.housing / d.capacity) * 100)}%"></i></div>
    <div class="cards" style="margin-top:12px">${UNIT_KEYS.map((k) => unitCard(G, k)).join("")}</div>
  `,
  );
  for (const b of body.querySelectorAll("[data-act]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const [kind, unit, n] = b.dataset.act.split(":");
        if (kind === "train") await api("/api/army/train", { body: { unit, count: Number(n) } });
        if (kind === "disband") await api("/api/army/disband", { body: { unit, count: Number(n) } });
        if (kind === "up") {
          const r = await api("/api/army/upgrade", { body: { unit } });
          toast(`${UNITS[unit].name} trained to level ${r.level}`, "good");
        }
        sfx(kind === "up" ? "upgrade" : "coin");
        await G.refreshMe();
        openArmy(G);
      }),
    );
}

function unitCard(G, k) {
  const m = G.me;
  const u = UNITS[k];
  const lvl = m.unitLevels[k] ?? 1;
  const locked = !m.derived.unlocked.includes(k);
  const n = m.army[k] ?? 0;
  const mult = unitMult(lvl);
  const room = m.derived.capacity - m.derived.housing;
  const upCost = m.derived.unitUpgradeCosts[k];
  const canUp = lvl < m.buildings.training;
  return `<div class="card ${locked ? "locked" : ""}">
    <div class="art"><img src="${spriteUrl(`${k}_0`, 4)}" width="${(k === "cavalry" || k === "siege" ? 20 : 16) * 4}" height="64" alt=""></div>
    <div class="row spread"><h4>${esc(u.name)}</h4><span class="tag">${locked ? `Barracks ${u.unlock}` : `Lv ${lvl} · ×${n}`}</span></div>
    <span class="stats">${esc(u.role)}</span>
    <span class="stats"><span>HP ${Math.round(u.hp * mult)}</span><span>Dmg ${Math.round(u.dmg * mult)}</span><span>Range ${u.range}</span><span>Speed ${u.speed}</span><span>Housing ${u.housing}</span></span>
    <span class="stats">${beats(k) ? `Strong vs ${beats(k)}` : ""}${weakTo(k) ? ` · Weak to ${weakTo(k)}` : ""}</span>
    ${
      locked
        ? `<span class="note">Unlocks at Barracks level ${u.unlock}.</span>`
        : `<div class="row">
      <button class="btn btn-go btn-small" data-act="train:${k}:1" ${room >= u.housing && m.gold >= u.cost ? "" : "disabled"}>Train<span class="cost">${u.cost}g</span></button>
      <button class="btn btn-go btn-small" data-act="train:${k}:5" ${room >= u.housing * 5 && m.gold >= u.cost * 5 ? "" : "disabled"}>×5<span class="cost">${u.cost * 5}g</span></button>
      <button class="btn btn-ghost btn-small" data-act="disband:${k}:1" ${n ? "" : "disabled"} title="Free up housing">−1</button>
    </div>
    <div class="row"><button class="btn btn-blue btn-small" data-act="up:${k}" ${canUp && m.gold >= upCost ? "" : "disabled"}>Level up<span class="cost">${fmt(upCost)}g</span></button>${canUp ? "" : `<span class="note">Training Grounds cap: Lv ${m.buildings.training}</span>`}</div>`
    }
  </div>`;
}
