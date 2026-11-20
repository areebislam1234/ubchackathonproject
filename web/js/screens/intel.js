// Intelligence: reports recovered from bosses. Each one is about a specific market, filled with live
// data where it could be fetched and clearly stamped SAMPLE where it couldn't.
import { BOSSES, INTEL_CATEGORIES } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { ago, currentSheet, esc, openSheet, toast } from "../ui.js";

const RARITY_ORDER = { legendary: 0, epic: 1, rare: 2, common: 3 };
const RARITY_COLOR = { common: "#a3a3b3", rare: "#4f8ee0", epic: "#8f52d4", legendary: "#f6c33b" };
const WHY = { "your-call": "your open call", "your-bounty": "a bounty you fought in", "open-market": "an open market" };
const state = { sort: "newest", cat: null, rarity: null, open: null, reports: [], timer: null };

export async function openIntel(G, id) {
  if (id) state.open = id;
  try {
    state.reports = (await api("/api/intel")).reports;
  } catch (e) {
    return toast(e.message, "bad");
  }
  try {
    localStorage.setItem(`stakeclash.intelSeen.${G.me?.id}`, String(state.reports.length));
  } catch {
    /* storage blocked */
  }
  G.renderBagBadge?.();
  render(G);
  schedule(G);
}

/** While any report is still decoding, check back every couple of seconds. */
function schedule(G) {
  clearTimeout(state.timer);
  if (!state.reports.some((r) => r.status === "compiling")) return;
  state.timer = setTimeout(async () => {
    if (currentSheet() !== "intel") return;
    try {
      const before = state.reports.filter((r) => r.status === "ready").length;
      state.reports = (await api("/api/intel")).reports;
      if (state.reports.filter((r) => r.status === "ready").length > before) sfx("reveal");
      render(G);
    } catch {
      /* try again */
    }
    schedule(G);
  }, 2000);
}

function sorted() {
  let list = state.reports.filter((r) => (!state.cat || r.category === state.cat) && (!state.rarity || r.rarity === state.rarity));
  if (state.sort === "rarity") list = [...list].sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity] || b.collectedAt - a.collectedAt);
  else if (state.sort === "category") list = [...list].sort((a, b) => a.category.localeCompare(b.category) || b.collectedAt - a.collectedAt);
  else list = [...list].sort((a, b) => b.collectedAt - a.collectedAt);
  return list;
}

function stamp(r) {
  if (r.status === "compiling") return `<span class="stamp decoding">Decoding…</span>`;
  if (r.live) return `<span class="stamp live">Live data</span>`;
  if (r.partial) return `<span class="stamp partial">Live + sample</span>`;
  return `<span class="stamp sample">Sample data</span>`;
}

function render(G) {
  const r = state.open ? state.reports.find((x) => x.id === state.open) : null;
  const body = openSheet("intel", r ? detail(r) : list(G));
  for (const b of body.querySelectorAll("[data-open]"))
    b.addEventListener("click", () => {
      state.open = b.dataset.open;
      sfx("open");
      render(G);
    });
  body.querySelector("#intel-back")?.addEventListener("click", () => {
    state.open = null;
    sfx("close");
    render(G);
  });
  for (const b of body.querySelectorAll("[data-sort]"))
    b.addEventListener("click", () => {
      state.sort = b.dataset.sort;
      sfx("click");
      render(G);
    });
  for (const b of body.querySelectorAll("[data-cat]"))
    b.addEventListener("click", () => {
      state.cat = state.cat === b.dataset.cat ? null : b.dataset.cat;
      sfx("click");
      render(G);
    });
  for (const b of body.querySelectorAll("[data-rar]"))
    b.addEventListener("click", () => {
      state.rarity = state.rarity === b.dataset.rar ? null : b.dataset.rar;
      sfx("click");
      render(G);
    });
}

function list() {
  const all = state.reports;
  const items = sorted();
  const chip = (attr, key, label, on) => `<button class="chip" data-${attr}="${key}" aria-pressed="${on}">${label}</button>`;
  return `
    <h2>Intelligence</h2>
    <p class="sub">Reports recovered from boss lairs. Each one is about a real market: one you've made a call on, a bounty you fought in, or an open market in that boss's realm. Harder bosses drop deeper reports.</p>
    <div class="row spread" style="flex-wrap:wrap;gap:6px">
      <div class="chips">${chip("sort", "newest", "Newest", state.sort === "newest")}${chip("sort", "rarity", "Rarity", state.sort === "rarity")}${chip("sort", "category", "Category", state.sort === "category")}</div>
      <span class="note">${all.length} report${all.length === 1 ? "" : "s"} collected</span>
    </div>
    <div class="chips" style="margin:6px 0">${Object.entries(INTEL_CATEGORIES)
      .map(([k, c]) => chip("cat", k, `${icon(c.icon, 1)} ${c.name}`, state.cat === k))
      .join("")}</div>
    <div class="chips" style="margin-bottom:10px">${["legendary", "epic", "rare", "common"].map((k) => chip("rar", k, k[0].toUpperCase() + k.slice(1), state.rarity === k)).join("")}</div>
    ${
      items.length
        ? `<div class="dossiers">${items.map(card).join("")}</div>`
        : `<div class="coach">${all.length ? "No reports match those filters." : "No reports yet. Defeat bosses in their lairs: Arena Plains bosses carry sports intel, Ironvein crypto, Goldmarsh economics, and the other realms carry general intel. Legendary bosses drop reports most often."}</div>`
    }`;
}

function card(r) {
  const cat = INTEL_CATEGORIES[r.category] ?? INTEL_CATEGORIES.general;
  return `<button class="dossier r-${r.rarity}" data-open="${esc(r.id)}">
    <span class="dossier-top"><span class="dossier-cat">${icon(cat.icon, 2)} ${esc(r.topic)}</span><span class="dossier-rar" style="background:${RARITY_COLOR[r.rarity]}">${esc(r.rarity)}</span></span>
    <b class="dossier-title">${esc(r.title)}</b>
    ${r.market ? `<span class="dossier-q">${esc(r.market.question)}</span>` : ""}
    <span class="dossier-foot">${stamp(r)}<span class="note">${ago(r.collectedAt)} · ${esc(r.bossName)}</span></span>
  </button>`;
}

function detail(r) {
  const cat = INTEL_CATEGORIES[r.category] ?? INTEL_CATEGORIES.general;
  const boss = BOSSES[r.boss];
  const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return `
    <button class="btn btn-small btn-ghost" id="intel-back">← All reports</button>
    <div class="report r-${r.rarity}">
      <div class="report-head">
        ${boss ? `<img src="${spriteUrl(`boss_${r.boss}_0`, 2)}" alt="" class="report-boss">` : ""}
        <div>
          <span class="dossier-cat">${icon(cat.icon, 2)} ${esc(cat.name)} · ${esc(r.topic)}</span>
          <h2 style="margin:4px 0">${esc(r.title)}</h2>
          ${stamp(r)} <span class="dossier-rar" style="background:${RARITY_COLOR[r.rarity]}">${esc(r.rarity)}</span>
        </div>
      </div>
      ${
        r.market
          ? `<div class="coach">Relevant to <b>${esc(r.market.question)}</b>${r.market.eventTitle && r.market.eventTitle !== r.market.question ? ` (${esc(r.market.eventTitle)})` : ""}, ${WHY[r.market.why] ?? "an open market"}.${r.market.practice ? " This is a practice market from the game's mock Gemini server; the data about its subject is real where it says live." : ""}</div>`
          : r.status === "ready"
            ? `<div class="coach">No open market in this category could be matched, so this is a general ${esc(r.topic.toLowerCase())} report.</div>`
            : ""
      }
      ${r.status === "compiling" ? `<div class="coach decoding-box">Decoding the report… gathering live data for this market. It'll appear here in a few seconds.</div>` : r.sections.map(section).join("")}
      <p class="note report-meta">Recovered from ${esc(r.bossName)} · collected ${when(r.collectedAt)}${r.dataAsOf ? ` · data as of ${when(r.dataAsOf)}` : ""}</p>
    </div>`;
}

function section(s) {
  const tag = s.live ? "" : ` <span class="stamp sample small">Sample</span>`;
  const h = `<h3>${esc(s.heading)}${tag}</h3>`;
  if (s.kind === "facts") return `<section class="rsec">${h}<div class="rfacts">${s.facts.map((f) => `<div class="rfact ${f.tone ?? ""}"><span>${esc(f.label)}</span><b>${esc(f.value)}</b></div>`).join("")}</div></section>`;
  if (s.kind === "table")
    return `<section class="rsec">${h}<div class="rtable-wrap"><table class="board rtable"><thead><tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${s.rows
      .map((row, i) => `<tr class="${i === s.highlight ? "me" : ""}">${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div></section>`;
  if (s.kind === "series") return `<section class="rsec">${h}${chart(s)}</section>`;
  if (s.kind === "list") return `<section class="rsec">${h}<ul class="rlist">${s.items.map((it) => `<li>${esc(it.title)}${it.meta ? ` <span class="note">${esc(it.meta)}</span>` : ""}</li>`).join("")}</ul></section>`;
  return `<section class="rsec">${h}<p>${esc(s.text)}</p></section>`;
}

/** A small pixel bar chart, with the market's line drawn across it when there is one. */
function chart(s) {
  const pts = s.points;
  if (!pts.length) return "";
  const W = 320;
  const H = 110;
  const pad = 4;
  const vals = pts.map((p) => p.value);
  if (s.threshold !== undefined && s.threshold !== null) vals.push(s.threshold);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) (lo -= 1), (hi += 1);
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.05;
  const y = (v) => Math.round(H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2));
  const bw = Math.max(2, Math.floor((W - pad * 2) / pts.length) - 2);
  const bars = pts
    .map((p, i) => {
      const x = pad + i * ((W - pad * 2) / pts.length);
      const top = y(p.value);
      const over = s.threshold !== undefined && s.threshold !== null && p.value > s.threshold;
      return `<rect x="${Math.round(x)}" y="${top}" width="${bw}" height="${H - pad - top}" fill="${over ? "#4fa83a" : "#3e74d6"}"><title>${esc(p.label)}: ${p.value}</title></rect>`;
    })
    .join("");
  const line = s.threshold !== undefined && s.threshold !== null ? `<line x1="0" x2="${W}" y1="${y(s.threshold)}" y2="${y(s.threshold)}" stroke="#e23c3c" stroke-width="2" stroke-dasharray="6 4"/>` : "";
  const last = pts[pts.length - 1];
  return `<figure class="rchart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${esc(s.heading)}">${bars}${line}</svg>
    <figcaption class="note">${esc(pts[0].label)} → ${esc(last.label)} · latest ${last.value}${s.unit ? ` ${esc(s.unit)}` : ""}${s.threshold !== undefined && s.threshold !== null ? ` · <span style="color:#e23c3c">dashed line: ${s.threshold}${s.unit === "°F" ? "°F" : ""}</span>` : ""}</figcaption></figure>`;
}
