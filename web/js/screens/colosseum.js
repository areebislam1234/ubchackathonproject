// The Colosseum: 1v1 duels for Might on a live Gemini market. Half the pot goes to the stronger
// army right away (steel); half waits for Gemini to settle and goes to the better-calibrated call
// (foresight). Every call is committed on Solana as a hash before the fight and revealed after.
import { armyPower } from "/shared/battle.js";
import { COLOSSEUM, UNITS, UNIT_KEYS, duelPot } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { changeTag, oddsChart, plainOdds, sparkline } from "../odds-chart.js";
import { act, ago, closeSheet, currentSheet, esc, fmt, openSheet, timeLeft, toast } from "../ui.js";
import { openBattle } from "./battle.js";
import { bindProfileLinks, scoutInto } from "./economy.js";
import { decideBattle } from "../chainwait.js";

let st = { tab: "board", data: null, markets: [], market: null, series: null, side: "yes", conf: 65, stake: 0, send: {}, answering: null, requestId: null };
let timer = null;
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

export async function openColosseum(G, { tab, market } = {}) {
  if (tab) st.tab = tab;
  if (market) st.market = market;
  st.answering = null;
  st.requestId = newRequestId();
  st.send = Object.fromEntries(UNIT_KEYS.map((k) => [k, G.me.army[k] ?? 0]));
  await load(G);
  render(G);
  clearInterval(timer);
  timer = setInterval(async () => {
    if (currentSheet() !== "colosseum") return clearInterval(timer);
    if (st.tab === "issue" || st.answering) return; // don't redraw forms while you're filling them in
    await load(G, false);
    render(G);
  }, 4000);
}

async function load(G, markets = true) {
  try {
    st.data = await api("/api/colosseum");
    if (markets && (st.tab === "issue" || st.answering)) {
      st.markets = (await api("/api/odds/markets")).markets;
      if (!st.market || !st.markets.some((m) => m.market === st.market)) st.market = st.markets[0]?.market ?? null;
      st.series = st.market ? await api(`/api/odds/${encodeURIComponent(st.market)}?window=1h`) : null;
    }
  } catch (e) {
    toast(e.message, "bad");
  }
}

const TABS = [
  ["board", "Challenges"],
  ["issue", "Issue a challenge"],
  ["mine", "My duels"],
  ["ranks", "Rankings"],
];

function render(G) {
  const d = st.data;
  if (!d) return;
  const html = `
    <div class="colo-head">
      <img src="${spriteUrl("colosseum", 2)}" alt="" class="colo-art">
      <div>
        <h2 style="margin:0">The Colosseum</h2>
        <p class="sub" style="margin:2px 0 0">Two warlords, one live Gemini market. Both put up the same Might and make a call. The armies fight now: the winner takes the <b>steel</b> half of the pot. The <b>foresight</b> half waits for Gemini to settle the market and goes to the better-calibrated call.</p>
      </div>
    </div>
    <div class="facts" style="grid-template-columns:repeat(4,1fr)">
      <div class="fact"><b>${fmt(d.might)}</b><span>Your Might</span></div>
      <div class="fact"><b>${fmt(d.stats.duels)}</b><span>Duels</span></div>
      <div class="fact"><b>${fmt(d.stats.steelWins)}</b><span>Steel wins</span></div>
      <div class="fact"><b>${fmt(d.stats.foresightWins)}</b><span>Foresight wins</span></div>
    </div>
    <div class="chips" style="margin:10px 0">${TABS.map(([k, l]) => `<button class="chip" data-tab="${k}" aria-pressed="${!st.answering && st.tab === k}">${l}</button>`).join("")}</div>
    <div id="colo-tab">${st.answering ? answerForm(G) : st.tab === "issue" ? issueForm(G) : st.tab === "mine" ? mine(G) : st.tab === "ranks" ? ranks(G) : boardTab(G)}</div>`;
  const body = openSheet("colosseum", html);
  wire(G, body);
}

// ── Open challenges ───────────────────────────────────────────────────
function boardTab(G) {
  const d = st.data;
  const open = d.open;
  const cards = open
    .map((x) => {
      const mineOpen = x.challenger.playerId === G.me.id;
      const wait = x.botAt ? x.botAt - d.now : null;
      return `<div class="card duel-card">
        <div class="row spread"><h4>${mineOpen ? esc(x.challenger.name) : `<a href="#" data-profile="${esc(x.challenger.playerId)}">${esc(x.challenger.name)}</a>`}${mineOpen ? " (you)" : ""}</h4><span class="tag ${x.stake ? "featured" : ""}">${x.stake ? `${fmt(x.stake)} Might` : "For glory"}</span></div>
        <p class="duel-q">${esc(x.question)}</p>
        <p class="stats">Army power ${fmt(x.challenger.power)} · call sealed ${icon("lock", 1)} <span class="mono" title="SHA-256 commitment posted on Solana">${esc(x.challenger.commit.slice(0, 10))}…</span> ${receiptChip(x.challenger.receipt)}</p>
        ${
          mineOpen
            ? `<div class="row"><span class="note">${wait !== null && wait > 0 ? `A rival warlord steps in within ${timeLeft(wait)} if no one answers.` : "Waiting for a rival…"}</span><button class="btn btn-small btn-ghost" data-cancel="${x.id}">Cancel</button></div>`
            : `<button class="btn btn-fight" data-answer="${x.id}">Answer the challenge</button>`
        }
      </div>`;
    })
    .join("");
  const recent = d.recent.length
    ? `<h3>Recent duels</h3><table class="board"><tbody>${d.recent
        .map((x) => {
          const w = x.steel ? (x.steel.winner === x.challenger.playerId ? x.challenger : x.rival) : null;
          return `<tr><td>${esc(x.challenger.name)} vs ${esc(x.rival?.name ?? "?")}</td><td>${w ? `${esc(w.name)} won the steel` : ""}</td><td class="num">${x.status === "settled" ? `settled ${esc(x.foresight.outcome.toUpperCase())}` : "awaiting Gemini"}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : "";
  return `${cards ? `<div class="cards">${cards}</div>` : `<div class="coach">No open challenges right now. Issue one: pick a market, make your call, choose your army. A rival warlord answers within ${COLOSSEUM.botAcceptSec} seconds if no player does.</div><button class="btn btn-go btn-big" data-tab="issue">Issue a challenge</button>`}${recent}`;
}

// ── Issue a challenge ─────────────────────────────────────────────────
function marketPicker() {
  const opts = st.markets.map((m) => `<option value="${esc(m.market)}" ${m.market === st.market ? "selected" : ""}>${esc(m.question)} · ${Math.round(m.nowBps / 100)}¢</option>`).join("");
  return `<label class="field">Market<select id="c-market">${opts}</select></label>`;
}

function marketBlock(m) {
  const s = st.series;
  if (!m) return `<p class="note">No open Gemini markets right now.</p>`;
  return `<div class="question" style="margin-top:6px">${esc(m.question)}<small>${esc(m.eventTitle)}${m.realmName ? ` · ${esc(m.realmName)}` : ""}${m.expiry ? ` · resolves by ${new Date(m.expiry).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</small></div>
    <div class="row spread"><span>${sparkline(m.spark, { w: 140, h: 30 })} ${changeTag(m.changeBps)} <span class="note">last hour</span></span><button class="btn btn-small btn-ghost" id="c-chart">Odds chart</button></div>
    <div id="c-chart-box" hidden>${s ? oddsChart(s, { height: 120, label: m.question }) : ""}</div>
    <p class="note">${esc(plainOdds(m.nowBps))}</p>`;
}

function callControls(m) {
  const yes = m ? Math.round((m.askBps ?? m.nowBps) / 100) : null;
  const no = m ? Math.round((10000 - (m.bidBps ?? m.nowBps)) / 100) : null;
  return `<div class="side-pick"><button class="btn btn-go" data-side="yes" aria-pressed="${st.side === "yes"}">YES${yes !== null ? ` · ${yes}¢` : ""}</button><button class="btn btn-fight" data-side="no" aria-pressed="${st.side === "no"}">NO${no !== null ? ` · ${no}¢` : ""}</button></div>
    <div class="slider-row"><label for="c-conf">How sure are you?</label><input id="c-conf" type="range" min="50" max="99" value="${st.conf}" /><output id="c-conf-out">${st.conf}%</output></div>`;
}

function armyPicker(G) {
  const me = G.me;
  const list = UNIT_KEYS.filter((k) => (me.army[k] ?? 0) > 0);
  if (!list.length) return `<p class="note">You have no units. Train some in the Army screen (R).</p>`;
  return `<div class="cards">${list
    .map(
      (k) => `<div class="card"><div class="row"><img src="${spriteUrl(`${k}_0`, 3)}" width="48" height="48" alt=""><div><h4>${UNITS[k].name}</h4><span class="stats">Lv ${me.unitLevels[k]}</span></div></div>
      <div class="stepper"><button class="btn btn-small btn-ghost" data-k="${k}" data-d="-1">−</button><output id="cn-${k}">${st.send[k]}</output><button class="btn btn-small btn-ghost" data-k="${k}" data-d="1">+</button><span class="note">of ${me.army[k]}</span></div></div>`,
    )
    .join("")}</div><p class="note">Your power: <b id="c-power">${fmt(armyPower(st.send, me.unitLevels))}</b>. Arena fights are to first blood: no units are lost.</p>`;
}

function potLine(stake) {
  const p = duelPot(stake);
  if (!stake) return "A duel for glory: no Might changes hands, but wins count in the rankings and the first one earns the Gladiator badge on Solana.";
  return `Pot ${fmt(p.pot)} Might: <b>${fmt(p.steel)}</b> to the winning army now, <b>${fmt(p.foresight)}</b> to the better call when Gemini settles, ${fmt(p.burned)} burned.`;
}

function issueForm(G) {
  const m = st.markets.find((x) => x.market === st.market);
  const max = Math.min(COLOSSEUM.maxStake, st.data.might);
  st.stake = Math.min(st.stake, max);
  return `
    <h3>1 · Pick a live market</h3>
    ${marketPicker()}
    ${marketBlock(m)}
    <h3>2 · Make your call</h3>
    ${callControls(m)}
    <p class="note">${icon("lock", 1)} Your call is committed on Solana the moment you issue the challenge: a hash of your side, confidence and the Gemini price right now. Your rival can't see it until the fight; afterwards anyone can check it.</p>
    <h3>3 · Stake and army</h3>
    <div class="slider-row"><label for="c-stake">Stake (Might)</label><input id="c-stake" type="range" min="0" max="${max}" step="${max > 200 ? 10 : 1}" value="${st.stake}" ${max ? "" : "disabled"} /><output id="c-stake-out">${st.stake}</output></div>
    ${max ? "" : `<p class="note">You have no Might yet. It comes from realized investment yield in the Treasury (T). You can still duel for glory.</p>`}
    <div class="coach" id="c-pot">${potLine(st.stake)}</div>
    ${armyPicker(G)}
    <button class="btn btn-fight btn-big" id="c-issue" ${m ? "" : "disabled"}>Issue the challenge</button>`;
}

// ── Answer a challenge ────────────────────────────────────────────────
function answerForm(G) {
  const x = st.data.open.find((d) => d.id === st.answering);
  if (!x) return `<p class="note">That challenge was already answered.</p><button class="btn" data-tab="board">Back</button>`;
  const m = st.markets.find((y) => y.market === x.market) ?? { question: x.question, eventTitle: x.eventTitle, nowBps: null, spark: [], changeBps: null };
  const short = x.stake > st.data.might;
  return `
    <button class="btn btn-small btn-ghost" data-tab="board">← Challenges</button>
    <h3>${esc(x.challenger.name)} challenges you${x.stake ? ` for ${fmt(x.stake)} Might` : " for glory"}</h3>
    ${marketBlock(m)}
    <p class="note">Their call is sealed ${icon("lock", 1)} <span class="mono">${esc(x.challenger.commit.slice(0, 16))}…</span>, committed on Solana ${ago(x.challenger.committedAt)}. Their army: power ${fmt(x.challenger.power)}.</p>
    <div class="scout" id="c-scout" data-player="${esc(x.challenger.playerId)}"><p class="note">Scouting ${esc(x.challenger.name)}…</p></div>
    <h3>Your call</h3>
    ${callControls(m)}
    <div class="coach">${potLine(x.stake)}</div>
    <h3>Your army</h3>
    ${armyPicker(G)}
    <button class="btn btn-fight btn-big" id="c-accept" ${short ? "disabled" : ""}>${short ? `You need ${fmt(x.stake)} Might` : "Answer and fight"}</button>`;
}

// ── My duels ──────────────────────────────────────────────────────────
function receiptChip(r) {
  if (!r) return "";
  const label = r.status === "onchain" ? (r.verified ? "On Solana ✓" : "On Solana") : r.status === "failed" ? "Receipt failed" : "Posting to Solana…";
  const cls = r.status === "onchain" ? "ok" : r.status === "failed" ? "bad" : "wait";
  const link = r.explorer ? ` <a href="${esc(r.explorer)}" target="_blank" rel="noopener">tx</a>` : r.signature ? ` <span class="mono" title="${esc(r.signature)}">${esc(r.signature.slice(0, 8))}…</span>` : "";
  return `<span class="rcpt ${cls}" title="${esc(r.memo)}">${label}</span>${link}`;
}

function callLine(s, settled) {
  if (!s.call) return `${icon("lock", 1)} sealed`;
  const c = s.call;
  return `<b>${c.side.toUpperCase()}</b> at ${Math.round(c.confBps / 100)}% · bought at ${Math.round(c.priceBps / 100)}¢${settled && s.brier !== null ? ` · Brier ${s.brier.toFixed(3)}` : ""}`;
}

function duelCard(G, x) {
  const sides = [x.challenger, x.rival].filter(Boolean);
  const steelW = x.steel ? sides.find((s) => s.playerId === x.steel.winner) : null;
  const status =
    x.status === "open" ? "Waiting for a rival" : x.status === "cancelled" ? "Cancelled" : x.status === "fought" ? "Fought · awaiting Gemini" : `Settled ${x.foresight.outcome.toUpperCase()}`;
  const foresight =
    x.status === "settled"
      ? x.foresight.winner === "split"
        ? `Both calls were equally good: the ${fmt(x.foresight.pot)} Might foresight half was split.`
        : `${esc(sides.find((s) => s.playerId === x.foresight.winner)?.name)} made the better call and took ${fmt(x.foresight.pot)} Might.`
      : x.status === "fought"
        ? `The foresight half (${fmt(x.pot.foresight)} Might) goes to the better-calibrated call when Gemini settles this market.`
        : "";
  const devSettle = G.cfg.devTools && G.cfg.mockGemini && x.status === "fought" ? `<button class="btn btn-small btn-ghost" data-dsettle="${x.id}:yes">Dev: settle YES</button><button class="btn btn-small btn-ghost" data-dsettle="${x.id}:no">Dev: settle NO</button>` : "";
  return `<div class="card duel-card ${x.status}">
    <div class="row spread"><h4>${esc(x.id)} · ${esc(x.challenger.name)} vs ${esc(x.rival?.name ?? "…")}</h4><span class="tag status-${x.status === "settled" ? "resolved" : x.status === "fought" ? "revealed" : "upcoming"}">${status}</span></div>
    <p class="duel-q">${esc(x.question)}${x.practice ? ` <span class="note">(practice market)</span>` : ""}</p>
    <table class="board duel-sides"><tbody>${sides
      .map(
        (s) => `<tr class="${s.playerId === G.me.id ? "me" : ""}"><td><b>${esc(s.name)}</b>${s.style ? ` <span class="note">${esc(s.style)} trader</span>` : ""}<br><span class="note">power ${fmt(s.power)}</span></td><td>${callLine(s, x.status === "settled")}<br>${receiptChip(s.receipt)}</td><td class="num">${s.payout ? `+${fmt(s.payout)}` : ""}</td></tr>`,
      )
      .join("")}</tbody></table>
    ${steelW ? `<p class="note">${icon("swords", 1)} ${esc(steelW.name)} won the fight${x.steel.pot ? ` and took ${fmt(x.steel.pot)} Might` : ""}.</p>` : ""}
    ${foresight ? `<p class="note">${icon("eye", 1)} ${foresight}</p>` : ""}
    ${x.seal ? `<p class="note">${icon("check", 1)} Result sealed: ${receiptChip(x.seal)} <span class="mono" title="${esc(x.hash ?? "")}">${esc((x.hash ?? "").slice(0, 12))}…</span></p>` : ""}
    <div class="row">${x.battle ? `<button class="btn btn-small" data-replay="${x.battle}">Watch the fight</button>` : ""}${x.status === "open" && x.challenger.playerId === G.me.id ? `<button class="btn btn-small btn-ghost" data-cancel="${x.id}">Cancel</button>` : ""}${x.status !== "open" && x.challenger.call ? `<button class="btn btn-small btn-ghost" data-verify="${x.id}">How to verify</button>` : ""}${devSettle}</div>
    <div class="verify" id="verify-${x.id}" hidden>${verifyHtml(x)}</div>
  </div>`;
}

function verifyHtml(x) {
  const line = (s) =>
    s.call
      ? `<li><b>${esc(s.name)}</b>: sha256("stakeclash:v1|${esc(x.id)}|${esc(s.playerId)}|${esc(x.market)}|${s.call.side}|${s.call.confBps}|${s.call.priceBps}|${s.call.at}|${esc(s.call.salt)}") = <span class="mono">${esc(s.commit)}</span>, posted in memo <span class="mono">${esc(s.receipt?.memo ?? "")}</span></li>`
      : "";
  return `<p class="note">Each call was committed on Solana before the fight. Recompute the hash from the revealed details and compare it with the memo in the transaction:</p><ul class="rlist small">${line(x.challenger)}${x.rival ? line(x.rival) : ""}</ul>`;
}

function mine(G) {
  const list = st.data.mine;
  return list.length ? `<div class="duel-list">${list.map((x) => duelCard(G, x)).join("")}</div>` : `<p class="note">You haven't fought in the Colosseum yet.</p>`;
}

function ranks() {
  const b = st.data.board;
  return b.length
    ? `<table class="board"><thead><tr><th>Warlord</th><th class="num">Duels</th><th class="num">Steel</th><th class="num">Foresight</th><th class="num">Might won</th></tr></thead><tbody>${b
        .map((r) => `<tr class="${r.me ? "me" : ""}"><td>${esc(r.name)}</td><td class="num">${r.duels}</td><td class="num">${r.steelWins}</td><td class="num">${r.foresightWins}</td><td class="num">${fmt(r.mightWon)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="note">No duels yet. The first warlord to win one earns the Gladiator badge.</p>`;
}

// ── Wiring ────────────────────────────────────────────────────────────
function wire(G, body) {
  for (const b of body.querySelectorAll("[data-tab]"))
    b.addEventListener("click", async () => {
      st.tab = b.dataset.tab;
      st.answering = null;
      sfx("click");
      await load(G);
      render(G);
    });
  for (const b of body.querySelectorAll("[data-answer]"))
    b.addEventListener("click", async () => {
      st.answering = b.dataset.answer;
      st.requestId = newRequestId();
      await load(G);
      const x = st.data.open.find((d) => d.id === st.answering);
      if (x) {
        st.market = x.market;
        st.series = await api(`/api/odds/${encodeURIComponent(x.market)}?window=1h`).catch(() => null);
      }
      render(G);
    });
  for (const b of body.querySelectorAll("[data-cancel]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        await api(`/api/colosseum/${b.dataset.cancel}/cancel`, { body: {} });
        toast("Challenge cancelled. Your Might is back.", "good");
        await Promise.all([G.refreshMe(), load(G, false)]);
        render(G);
      }),
    );
  for (const b of body.querySelectorAll("[data-replay]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const rec = await api(`/api/battles/${b.dataset.replay}`);
        closeSheet();
        openBattle(G, rec, { arena: true, doneLabel: "Back to the Colosseum", onDone: () => openColosseum(G, { tab: "mine" }) });
      }),
    );
  for (const b of body.querySelectorAll("[data-verify]")) b.addEventListener("click", () => (body.querySelector(`#verify-${b.dataset.verify}`).hidden ^= true));
  for (const b of body.querySelectorAll("[data-dsettle]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const [id, side] = b.dataset.dsettle.split(":");
        await api(`/api/dev/duel-settle/${id}`, { body: { side } });
        sfx("reveal");
        await Promise.all([G.refreshMe(), load(G, false)]);
        render(G);
      }),
    );
  // market picker and chart
  body.querySelector("#c-market")?.addEventListener("change", async (e) => {
    st.market = e.target.value;
    st.series = await api(`/api/odds/${encodeURIComponent(st.market)}?window=1h`).catch(() => null);
    render(G);
  });
  body.querySelector("#c-chart")?.addEventListener("click", () => (body.querySelector("#c-chart-box").hidden ^= true));
  // call controls
  for (const b of body.querySelectorAll("[data-side]"))
    b.addEventListener("click", () => {
      st.side = b.dataset.side;
      for (const x of body.querySelectorAll("[data-side]")) x.setAttribute("aria-pressed", String(x.dataset.side === st.side));
      sfx("click");
    });
  const conf = body.querySelector("#c-conf");
  conf?.addEventListener("input", () => {
    st.conf = Number(conf.value);
    body.querySelector("#c-conf-out").textContent = `${st.conf}%`;
  });
  const stake = body.querySelector("#c-stake");
  stake?.addEventListener("input", () => {
    st.stake = Number(stake.value);
    body.querySelector("#c-stake-out").textContent = st.stake;
    body.querySelector("#c-pot").innerHTML = potLine(st.stake);
  });
  for (const b of body.querySelectorAll("[data-k]"))
    b.addEventListener("click", () => {
      const k = b.dataset.k;
      st.send[k] = Math.max(0, Math.min(G.me.army[k] ?? 0, (st.send[k] ?? 0) + Number(b.dataset.d)));
      body.querySelector(`#cn-${k}`).textContent = st.send[k];
      body.querySelector("#c-power").textContent = fmt(armyPower(st.send, G.me.unitLevels));
      sfx("click");
    });
  body.querySelector("#c-issue")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const r = await api("/api/colosseum/challenge", { body: { units: st.send, stake: st.stake, market: st.market, side: st.side, confBps: st.conf * 100, requestId: st.requestId } });
      st.requestId = newRequestId();
      sfx("enter");
      toast(`Challenge ${r.duel.id} issued. Your call is being committed on Solana.`, "good");
      st.tab = "board";
      await Promise.all([G.refreshMe(), load(G, false)]);
      render(G);
    }),
  );
  void scoutInto(body.querySelector("#c-scout"));
  bindProfileLinks(G, body);
  body.querySelector("#c-accept")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const r = await decideBattle(() => api(`/api/colosseum/${st.answering}/accept`, { body: { units: st.send, side: st.side, confBps: st.conf * 100, requestId: st.requestId } }));
      st.requestId = newRequestId();
      st.answering = null;
      st.tab = "mine";
      closeSheet();
      const won = r.duel.steel?.winner === G.me.id;
      openBattle(G, r.battle, {
        arena: true,
        doneLabel: "Back to the Colosseum",
        lootHtml: `<p class="note">${won ? `You won the fight${r.duel.steel.pot ? ` and ${fmt(r.duel.steel.pot)} Might` : ""}.` : "You lost the fight."} The foresight half goes to the better call when Gemini settles “${esc(r.duel.question)}”. Both calls were committed on Solana before the fight.</p>`,
        onDone: async () => {
          await G.refreshMe();
          openColosseum(G, { tab: "mine" });
        },
      });
    }),
  );
}
