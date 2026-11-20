// Army management: train, disband and level up units.
import { armyPower } from "/shared/battle.js";
import { COUNTERS, DRILLS, MASTERY, UNITS, UNIT_KEYS, drillBonus, masteryBonus, unitMult } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { openFormation } from "./formation.js";
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

function masteryRow(m, k) {
  const rank = m.mastery?.ranks?.[k] ?? 0;
  const next = m.mastery?.next?.[k];
  return `<div class="row"><span class="stats">${icon("bolt", 1)} Mastery ${rank}/${MASTERY.maxRank} · +${Math.round(masteryBonus(rank) * 100)}%</span>${next ? `<button class="btn btn-crystal btn-small" data-act="mastery:${k}" ${(m.might ?? 0) >= next ? "" : "disabled"} title="Bought with Might from converted investment yield">Rank up<span class="cost">${next} Might</span></button>` : ""}</div>`;
}

function drillRow(m, k) {
  const pts = m.drills?.units?.[k] ?? 0;
  const pool = m.drills?.pool ?? 0;
  const full = pts >= DRILLS.maxPerUnit;
  return `<div class="row"><span class="stats">Drills ${pts}/${DRILLS.maxPerUnit} · +${Math.round(drillBonus(pts) * 1000) / 10}%</span>${pool > 0 && !full ? `<button class="btn btn-gold btn-small" data-act="drill:${k}:1">+1 drill</button>${pool >= 5 && pts + 5 <= DRILLS.maxPerUnit ? `<button class="btn btn-gold btn-small" data-act="drill:${k}:5">+5</button>` : ""}` : ""}</div>`;
}

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
    <div class="row" style="margin:8px 0"><button class="btn btn-gold" id="open-formation">Formation &amp; orders</button><span class="note">${m.formation?.manual ? "Hand-placed formation" : `Preset: ${esc(m.formation?.preset ?? "shieldwall")}`} · order ${esc(m.formation?.order ?? "hold")}</span></div>
    ${drillBanner(m)}
    <div class="cards" style="margin-top:12px">${UNIT_KEYS.map((k) => unitCard(G, k)).join("")}</div>
  `,
  );
  body.querySelector("#open-formation")?.addEventListener("click", () => openFormation(G));
  for (const b of body.querySelectorAll("[data-act]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const [kind, unit, n] = b.dataset.act.split(":");
        if (kind === "train") await api("/api/army/train", { body: { unit, count: Number(n) } });
        if (kind === "mastery") {
          const r = await api("/api/army/mastery", { body: { unit } });
          toast(`${UNITS[unit].name} Mastery rank ${r.mastery.ranks[unit]}: +${Math.round(masteryBonus(r.mastery.ranks[unit]) * 100)}% HP and damage`, "good");
        }
        if (kind === "drill") {
          await api("/api/army/drill", { body: { unit, count: Number(n) } });
          toast(`${UNITS[unit].name} drilled: +${Math.round(drillBonus((m.drills?.units?.[unit] ?? 0) + Number(n)) * 1000) / 10}% HP and damage`, "good");
        }
        if (kind === "disband") await api("/api/army/disband", { body: { unit, count: Number(n) } });
        if (kind === "up" || kind === "manual") {
          const r = await api("/api/army/upgrade", { body: { unit, use: kind === "manual" ? "manual" : undefined } });
          toast(`${UNITS[unit].name} trained to level ${r.level}`, "good");
        }
        sfx(kind === "up" || kind === "manual" || kind === "drill" || kind === "mastery" ? "upgrade" : "coin");
        await G.refreshMe();
        openArmy(G);
      }),
    );
}

function drillBanner(m) {
  const d = m.drills;
  if (!d) return "";
  const mastery = `<div class="coach">${icon("bolt", 2)} <b>Mastery</b>: the main way to strengthen troops. Each rank adds +${MASTERY.perRank * 100}% HP and damage to a unit type (up to +${Math.round(MASTERY.perRank * MASTERY.maxRank * 100)}%), paid in Might from realized investment yield. You have <b>${fmt(m.might ?? 0)}</b> Might. Get more in the Treasury (T).</div>`;
  return `${mastery}<div class="coach">${icon("helmet", 2)} <b>Drills</b>: minor upgrades earned from bosses, each +${d.perPoint * 100}% HP and damage for one unit type (up to +${Math.round(d.maxPerUnit * d.perPoint * 100)}%). <b>${d.pool}</b> point${d.pool === 1 ? "" : "s"} to assign · ${d.todayLeft} more can be earned today.</div>`;
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
    ${locked ? "" : masteryRow(m, k)}
    ${locked ? "" : drillRow(m, k)}
    ${
      locked
        ? `<span class="note">Unlocks at Barracks level ${u.unlock}.</span>`
        : `<div class="row">
      <button class="btn btn-go btn-small" data-act="train:${k}:1" ${room >= u.housing && m.gold >= u.cost ? "" : "disabled"}>Train<span class="cost">${u.cost}g</span></button>
      <button class="btn btn-go btn-small" data-act="train:${k}:5" ${room >= u.housing * 5 && m.gold >= u.cost * 5 ? "" : "disabled"}>×5<span class="cost">${u.cost * 5}g</span></button>
      <button class="btn btn-ghost btn-small" data-act="disband:${k}:1" ${n ? "" : "disabled"} title="Free up housing">−1</button>
    </div>
    <div class="row"><button class="btn btn-blue btn-small" data-act="up:${k}" ${canUp && m.gold >= upCost ? "" : "disabled"}>Level up<span class="cost">${fmt(upCost)}g</span></button>${(m.inventory?.manuals?.[k] ?? 0) > 0 ? `<button class="btn btn-gold btn-small" data-act="manual:${k}" ${canUp ? "" : "disabled"} title="Use a training manual from your Bag">Manual<span class="cost">×${m.inventory.manuals[k]}</span></button>` : ""}${canUp ? "" : `<span class="note">Training Grounds cap: Lv ${m.buildings.training}</span>`}</div>`
    }
  </div>`;
}
