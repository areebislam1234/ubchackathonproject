// The odds board: live Gemini markets, the biggest movers, the town crier's headlines, and each
// market's odds over time. Gemini's API gives the current price; the server records the history.
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { changeTag, oddsChart, plainOdds, sparkline } from "../odds-chart.js";
import { ago, currentSheet, esc, openSheet, toast } from "../ui.js";

const WINDOWS = [
  ["15m", "15 min"],
  ["1h", "1 hour"],
  ["6h", "6 hours"],
  ["24h", "24 hours"],
];
let state = { window: "1h", market: null, data: null, series: null };
let timer = null;

export async function openOdds(G, market = null) {
  state.market = market;
  await load();
  render(G);
  clearInterval(timer);
  timer = setInterval(async () => {
    if (currentSheet() !== "odds") return clearInterval(timer);
    await load();
    render(G);
  }, 10_000);
}

async function load() {
  try {
    if (state.market) state.series = await api(`/api/odds/${encodeURIComponent(state.market)}?window=${state.window}`);
    else state.data = await api(`/api/odds/movers?window=${state.window}`);
  } catch (e) {
    toast(e.message, "bad");
  }
}

const chips = () => `<div class="chips">${WINDOWS.map(([k, l]) => `<button class="chip" data-win="${k}" aria-pressed="${state.window === k}">${l}</button>`).join("")}</div>`;
const winName = () => WINDOWS.find(([k]) => k === state.window)?.[1] ?? state.window;

function render(G) {
  const body = openSheet("odds", state.market ? detail(G) : board(G));
  for (const b of body.querySelectorAll("[data-win]"))
    b.addEventListener("click", async () => {
      state.window = b.dataset.win;
      sfx("click");
      await load();
      render(G);
    });
  for (const b of body.querySelectorAll("[data-market]"))
    b.addEventListener("click", async () => {
      state.market = b.dataset.market;
      sfx("click");
      await load();
      render(G);
    });
  body.querySelector("#odds-back")?.addEventListener("click", async () => {
    state.market = null;
    await load();
    render(G);
  });
  body.querySelector("#odds-duel")?.addEventListener("click", () => G.openColosseum({ tab: "issue", market: state.market }));
}

function board() {
  const d = state.data ?? { movers: [], crier: [] };
  const rows = d.movers
    .map(
      (m) => `<tr class="mover" data-market="${esc(m.market)}" tabindex="0">
      <td><b>${esc(m.question)}</b><br><span class="note">${esc(m.realmName || m.category)}</span></td>
      <td class="spark-cell">${sparkline(m.spark)}</td>
      <td class="num">${Math.round(m.nowBps / 100)}¢</td>
      <td class="num">${changeTag(m.changeBps)}</td></tr>`,
    )
    .join("");
  const crier = d.crier.length
    ? `<ul class="crier-list">${d.crier.map((c) => `<li><button class="linklike" data-market="${esc(c.market)}">${esc(c.text.replace(/^Town crier: /, ""))}</button> <span class="note">${ago(c.at)}</span></li>`).join("")}</ul>`
    : `<p class="note">The crier is quiet. A headline goes up when a market moves sharply.</p>`;
  return `
    <div class="odds-head">
      <img src="${spriteUrl("waystone", 3)}" alt="" class="odds-art">
      <div>
        <h2 style="margin:0">Odds board</h2>
        <p class="sub" style="margin:2px 0 0">Live Gemini prediction markets. A market's YES price is its implied chance: 62¢ means the market thinks 62%. The game records every price, so you can see how the odds moved.</p>
      </div>
    </div>
    ${chips()}
    <h3>${icon("bolt", 2)} Biggest movers · last ${esc(winName())}</h3>
    ${rows ? `<div class="rtable-wrap"><table class="board movers"><thead><tr><th>Market</th><th>Trend</th><th class="num">YES</th><th class="num">Move</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="note">Gathering prices from Gemini. Movers appear after a few samples.</p>`}
    <h3>${icon("scroll", 2)} The town crier</h3>
    ${crier}
    <p class="note">Big moves can also stir up a realm: a featured bounty may appear there, its question sealed like any other.</p>`;
}

function detail() {
  const s = state.series;
  if (!s) return `<button class="btn btn-small btn-ghost" id="odds-back">← All markets</button><p class="note">Loading…</p>`;
  const expiry = s.expiry ? new Date(s.expiry).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;
  return `
    <button class="btn btn-small btn-ghost" id="odds-back">← All markets</button>
    <div class="question" style="margin-top:8px">${esc(s.question)}<small>${esc(s.eventTitle ?? "")}${expiry ? ` · resolves by ${expiry}` : ""}${s.realmName ? ` · ${esc(s.realmName)}` : ""} · <span style="font-family:monospace">${esc(s.market)}</span></small></div>
    ${chips()}
    ${oddsChart(s, { label: s.question })}
    <div class="facts" style="grid-template-columns:repeat(4,1fr)">
      <div class="fact"><b>${s.nowBps == null ? "–" : `${Math.round(s.nowBps / 100)}¢`}</b><span>YES now</span></div>
      <div class="fact"><b>${changeTag(s.changeBps)}</b><span>Last ${esc(winName())}</span></div>
      <div class="fact"><b>${s.highBps == null ? "–" : `${Math.round(s.highBps / 100)}¢`}</b><span>High</span></div>
      <div class="fact"><b>${s.lowBps == null ? "–" : `${Math.round(s.lowBps / 100)}¢`}</b><span>Low</span></div>
    </div>
    <div class="coach">${esc(plainOdds(s.nowBps))}</div>
    <div class="row"><button class="btn btn-fight btn-big" id="odds-duel">Duel on this market in the Colosseum</button><span class="note">Recorded from Gemini${s.since ? ` since ${new Date(s.since).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : ""}.</span></div>`;
}
