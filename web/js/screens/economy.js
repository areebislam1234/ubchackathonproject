// The Economic Board (L), public warlord profiles, Colosseum scouting and Warlord dossiers.
// Every number comes from the server's QuickNode indexer. Until the on-chain program is deployed the
// indexer runs on the game's own events, and the board says so plainly.
import { ABILITIES, INFO_RELIC, UNITS, UNIT_KEYS } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon } from "../gfx.js";
import { act, ago, esc, fmt, openSheet, toast } from "../ui.js";

let tab = "gold";
const usd = (micro) => `$${(micro / 1e6).toFixed(2)}`;

/** Net flow per hour over the last day, as diverging bars around zero. */
function flowChart(points, { label, money = false }) {
  const W = 480;
  const H = 120;
  const max = Math.max(1, ...points.map((p) => Math.abs(p.v)));
  const bw = W / points.length;
  const mid = H / 2;
  const bars = points
    .map((p, i) => {
      const h = Math.round((Math.abs(p.v) / max) * (mid - 6));
      const y = p.v >= 0 ? mid - h : mid;
      const tip = `${new Date(p.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${p.v >= 0 ? "+" : "−"}${money ? usd(Math.abs(p.v)) : fmt(Math.abs(p.v))}`;
      return p.v ? `<rect x="${(i * bw + 1).toFixed(1)}" y="${y}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(1, h)}" class="${p.v >= 0 ? "in" : "out"}"><title>${esc(tip)}</title></rect>` : "";
    })
    .join("");
  return `<figure class="flow"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"><line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="axis"/>${bars}</svg>
    <figcaption><span>24 h ago</span><span>${esc(label)}</span><span>now</span></figcaption></figure>`;
}

const tile = (value, label, hint = "") => `<div class="fact"${hint ? ` title="${esc(hint)}"` : ""}><b>${value}</b><span>${esc(label)}</span></div>`;

function sources(list) {
  if (!list?.length) return `<p class="note">No transactions yet.</p>`;
  return `<ul class="src-list">${list
    .map((s) => `<li><span class="rcpt ${s.status === "local" ? "wait" : "ok"}">${s.status === "local" ? "local" : s.status === "finalized" ? "finalized" : "confirmed"}</span> ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="mono">${esc(s.signature.slice(0, 16))}…</a>` : `<span class="mono">${esc(s.signature)}</span>`}</li>`)
    .join("")}</ul>`;
}

function holders(list) {
  if (!list?.length) return "";
  return `<h3>Largest holders</h3><table class="table"><tbody>${list.map((h, i) => `<tr><td>${i + 1}. ${h.playerId ? `<a href="#" data-profile="${esc(h.playerId)}">${esc(h.name)}</a>` : esc(h.name)}</td><td class="num">${fmt(h.balance)}</td></tr>`).join("")}</tbody></table>`;
}

function goldTab(g) {
  return `<div class="facts" style="grid-template-columns:repeat(3,1fr)">
      ${tile(fmt(g.supply), "Gold in existence", `Source: ${g.supplySource}`)}
      ${tile(fmt(g.minted), "Minted (income)")}
      ${tile(fmt(g.burned), "Burned (spending)")}
      ${tile(fmt(g.spentOnUpgrades), "Spent on unit levels")}
      ${tile(fmt(g.escrowed), "Held in stakes")}
      ${tile(fmt(g.transactions), "Transactions")}
    </div>
    ${flowChart(g.history, { label: "Gold minted minus burned, per hour" })}
    <p class="note">Gold is earned in play and spent on troops, unit levels and buildings. Income and spending are netted and settled on-chain every 30 seconds.</p>
    ${holders(g.holders)}
    <h3>Verify</h3>${sources(g.sources)}`;
}

function mightTab(m) {
  return `<div class="facts" style="grid-template-columns:repeat(3,1fr)">
      ${tile(fmt(m.supply), "Might in existence", `Source: ${m.supplySource}`)}
      ${tile(fmt(m.mintedFromYield), "Minted from realized yield")}
      ${tile(fmt(m.spentOnAbilities), "Spent on abilities")}
      ${tile(fmt(m.escrowed), "Held in duel stakes")}
      ${tile(fmt(m.rewardsPaid), "Paid to duel winners")}
      ${tile(fmt(m.burnedInDuels), "Burned in duels (5%)")}
    </div>
    ${flowChart(m.history, { label: "Might minted minus burned, per hour" })}
    <p class="note">Might comes only from realized investment yield (1 USDC = 100 Might) and Colosseum winnings. It unlocks class abilities${m.migrated ? `; ${fmt(m.migrated)} was carried over from balances that existed before the program` : ""}.</p>
    ${m.popularAbilities?.length ? `<h3>Most unlocked abilities</h3><p class="chips">${m.popularAbilities.map((a) => `<span class="chip" aria-pressed="false">${esc(a.ability)} ×${a.n}</span>`).join("")}</p>` : ""}
    ${m.yieldRecords?.length ? `<h3>Yield converted</h3><table class="table"><tbody>${m.yieldRecords.map((y) => `<tr><td>${esc(y.player)}</td><td class="num">${usd(y.usdc)} → ${fmt(y.might)} Might</td><td>${y.url ? `<a href="${esc(y.url)}" target="_blank" rel="noopener">tx</a>` : `<span class="note">local</span>`}</td></tr>`).join("")}</tbody></table>` : ""}
    ${holders(m.holders)}
    <h3>Verify</h3>${sources(m.sources)}`;
}

function usdcTab(u) {
  return `<div class="facts" style="grid-template-columns:repeat(3,1fr)">
      ${tile(usd(u.deposited), `Deposited (${u.deposits})`)}
      ${tile(usd(u.withdrawn), `Withdrawn (${u.withdrawals})`)}
      ${tile(usd(u.realizedYield), "Realized yield")}
      ${tile(usd(u.convertedToMight), "Converted into Might")}
    </div>
    ${flowChart(u.history, { label: "USDC deposited minus withdrawn, per hour", money: true })}
    <p class="note">${esc(u.sourceNote)} <span class="testmoney">Devnet test USDC: no real money</span></p>
    <h3>Verify</h3>${sources(u.sources)}`;
}

export async function openEconomy(G, which) {
  if (which) tab = which;
  const body = openSheet("economy", `<h2>Economic Board</h2><p class="note">Loading…</p>`);
  let d;
  try {
    d = await api("/api/economy");
  } catch (e) {
    body.innerHTML = `<h2>Economic Board</h2><p class="note">${esc(e.message)}</p>`;
    return;
  }
  const live = d.chain.mode === "chain";
  const banner = live
    ? `<div class="coach">${icon("chart", 2)} <b>On-chain.</b> Read from the Fortune Front program through QuickNode (Streams, RPC backfill, WebSocket). ${fmt(d.finalized)} of ${fmt(d.events)} events finalized.</div>`
    : `<div class="coach warn">${icon("chart", 2)} <b>Not on-chain yet.</b> ${/not deployed/.test(d.chain.reason) ? "The Fortune Front program isn't deployed yet" : `The Fortune Front program can't be used right now (${esc(d.chain.reason)})`}, so these numbers come from the game's own records of the same events. They switch to on-chain data, with explorer links, once the program is live.</div>`;
  const tabs = [["gold", "Gold"], ["might", "Might"], ["usdc", "USDC"]].map(([k, n]) => `<button class="chip" data-etab="${k}" aria-pressed="${tab === k}">${n}</button>`).join("");
  body.innerHTML = `
    <h2>Economic Board</h2>
    <p class="sub">Where the realm's money is: how much exists, where it came from, where it went.</p>
    ${banner}
    <div class="chips">${tabs}</div>
    ${tab === "gold" ? goldTab(d.gold) : tab === "might" ? mightTab(d.might) : usdcTab(d.usdc)}
    <p class="note">Program ${esc(d.chain.program)} · ${d.chain.queued} action${d.chain.queued === 1 ? "" : "s"} waiting to send${d.chain.failed ? ` · ${d.chain.failed} failed` : ""}${d.index.backfilledAt ? ` · last backfill ${ago(d.index.backfilledAt)}` : ""}</p>`;
  for (const b of body.querySelectorAll("[data-etab]")) b.addEventListener("click", () => (sfx("click"), openEconomy(G, b.dataset.etab)));
  bindProfileLinks(G, body);
}

// ── Public profiles ───────────────────────────────────────────────────
export function bindProfileLinks(G, root) {
  for (const a of root.querySelectorAll("[data-profile]"))
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openPublicProfile(G, a.dataset.profile);
    });
}

/** A warlord's public stats as a card (also used by Colosseum scouting). */
export function publicCard(s, { compact = false } = {}) {
  const kinds = [["bounty", "Bounties"], ["boss", "Bosses"], ["duel", "Duels"]];
  const levels = UNIT_KEYS.filter((k) => (s.unitLevels[k] ?? 1) > 1)
    .map((k) => `${esc(UNITS[k].name)} ${s.unitLevels[k]}`)
    .join(" · ");
  return `<div class="pub-card">
    <div class="row spread"><h3 style="margin:0">${esc(s.name)}</h3><span class="tag">Keep ${s.keep} · ${fmt(s.trophies)} trophies</span></div>
    <div class="facts" style="grid-template-columns:repeat(4,1fr)">
      ${tile(fmt(s.battles), "Battles")}
      ${tile(`${s.wins}–${s.losses}`, "Won–lost")}
      ${tile(s.winRate === null ? "–" : `${s.winRate}%`, "Win rate")}
      ${tile(usd(s.realizedYield), "Realized yield")}
    </div>
    <p class="stats">${kinds.map(([k, n]) => `${n} ${s.byKind[k].wins}–${s.byKind[k].losses}`).join(" · ")}</p>
    <p class="stats">${icon("coin", 1)} ${fmt(s.gold)} Gold · ${icon("bolt", 1)} ${fmt(s.might)} Might</p>
    ${levels ? `<p class="stats">Unit levels: ${levels}</p>` : ""}
    ${s.abilities.length ? `<p class="stats">Abilities: ${s.abilities.map(esc).join(", ")}</p>` : ""}
    ${
      compact
        ? ""
        : `${s.recent.length ? `<h4>Recent battles</h4><ul class="src-list">${s.recent.map((r) => `<li>${r.won ? "▲ Won" : "▼ Lost"} ${esc(r.kind)} ${esc(r.context)} (+${fmt(r.score)}) ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">tx</a>` : ""}</li>`).join("")}</ul>` : ""}
           ${s.progression.length ? `<h4>Progression</h4><ul class="src-list">${s.progression.map((p) => `<li>${esc(p.unit)} → level ${p.level}${p.drills ? `, ${p.drills} drills` : ""}</li>`).join("")}</ul>` : ""}`
    }
    <p class="note">Public record · ${esc(s.source)}. Formations, orders and loadouts stay secret: only a ${esc(INFO_RELIC.name)} reveals those.</p>
  </div>`;
}

export async function openPublicProfile(G, id) {
  const body = openSheet("public-profile", `<p class="note">Loading…</p>`);
  try {
    const s = await api(`/api/players/${encodeURIComponent(id)}/public`);
    body.innerHTML = `<h2>Warlord</h2>${publicCard(s)}`;
  } catch (e) {
    body.innerHTML = `<p class="note">${esc(e.message)}</p>`;
  }
}

/** Colosseum: fill a placeholder with the opponent's public stats. */
export async function scoutInto(el) {
  if (!el?.dataset.player) return;
  try {
    const s = await api(`/api/players/${encodeURIComponent(el.dataset.player)}/public`);
    el.innerHTML = `<h3>Scouting report</h3>${publicCard(s, { compact: true })}`;
  } catch {
    el.innerHTML = "";
  }
}

// ── Warlord dossiers (Information Relics) ─────────────────────────────
function dossierView(entry) {
  const d = entry.data;
  const grid = d.lastFormation
    ? `<div class="mini-grid">${d.lastFormation.map((s) => `<span class="${s ? "" : "empty"}">${s ? `${esc(UNITS[s.unit]?.name ?? s.unit)} ×${s.n}` : "·"}</span>`).join("")}</div>`
    : "";
  return `<div class="dossier-sheet panel parchment">
    <div class="row spread"><h3 style="margin:0">${esc(d.name)}</h3><span class="note">read ${ago(entry.at)}</span></div>
    <p class="stats">${d.battles} battle${d.battles === 1 ? "" : "s"} studied · ${d.attackWinRate === null ? "no attacks seen" : `wins ${d.attackWinRate}% of attacks`} · ${d.defenseWinRate === null ? "no defences seen" : `holds ${d.defenseWinRate}% of defences`}</p>
    <h4>Tendencies</h4><ul class="report-list">${d.tendencies.map((t) => `<li class="good"><span>◆</span> ${esc(t)}</li>`).join("")}</ul>
    <p class="stats">Orders: ${d.orders.map((o) => `${esc(o.order)} ×${o.n}`).join(", ") || "–"}</p>
    <p class="stats">Abilities: ${d.abilities.map((a) => `${esc(a.ability)} ×${a.n}`).join(", ") || "none seen"}</p>
    <p class="stats">Army: ${d.mix.map((m) => `${esc(m.cls)} ${m.share}%`).join(", ")}</p>
    ${grid ? `<h4>Last formation seen (front row on top)</h4>${grid}` : ""}
  </div>`;
}

export async function openDossiers(G) {
  const body = openSheet("dossiers", `<p class="note">Loading…</p>`);
  const d = await api("/api/dossiers");
  body.innerHTML = `
    <h2>Warlord dossiers</h2>
    <p class="sub">${esc(INFO_RELIC.desc)}</p>
    <div class="coach">${icon("eye", 2)} ${esc(INFO_RELIC.name)}: you hold <b>${d.spyglasses}</b>. Rare and stronger bosses drop them.</div>
    <form class="row" id="dos-form"><input id="dos-target" placeholder="Rival's name" maxlength="20" autocomplete="off" aria-label="Rival's name"><button class="btn btn-gold" ${d.spyglasses ? "" : "disabled"}>Use a Spyglass</button></form>
    ${d.dossiers.length ? d.dossiers.map(dossierView).join("") : `<p class="note">No dossiers yet.</p>`}`;
  body.querySelector("#dos-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const target = body.querySelector("#dos-target").value.trim();
    if (!target) return;
    act(body.querySelector("#dos-form button"), async () => {
      await api("/api/dossiers", { body: { target } });
      toast(`The Spyglass reveals ${target}'s habits`, "good");
      sfx("upgrade");
      openDossiers(G);
    });
  });
}

void ABILITIES;
