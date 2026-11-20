// Bounty details → enter → battle prep → (after the battles) the sealed question and your call.
import { armyPower } from "/shared/battle.js";
import { UNITS, UNIT_KEYS, payoutFor, sidePriceBps } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon, spriteUrl } from "../gfx.js";
import { $, act, cents, closeSheet, currentSheet, esc, fmt, openSheet, pct, timeLeft, toast } from "../ui.js";
import { openBattle } from "./battle.js";
import { changeTag, oddsChart, plainOdds } from "../odds-chart.js";
import { planPicker } from "./formation.js";
import { decideBattle } from "../chainwait.js";

let cur = null; // { id, data, view: "info" | "prep", sig }
const STATUS = { upcoming: "Upcoming", active: "Active", revealed: "Question revealed", resolved: "Settled" };

export async function openBounty(G, id) {
  cur = { id, data: null, view: "info", sig: "" };
  try {
    cur.data = await api(`/api/bounties/${id}`);
  } catch (e) {
    return toast(e.message, "bad");
  }
  render(G);
}

export async function refreshBountySheet(G) {
  if (!cur || currentSheet() !== "bounty" || cur.view !== "info") return;
  if (document.activeElement?.closest?.("#sheet") && document.activeElement.tagName === "INPUT") return;
  try {
    const d = await api(`/api/bounties/${cur.id}`);
    const sig = JSON.stringify([d.status, d.leaderboard, d.you, d.results?.seal, d.prediction, d.outcome, d.crowd?.count]);
    cur.data = d;
    if (sig !== cur.sig) render(G);
    else updateTimers(G);
  } catch {
    /* ignore */
  }
}

function timing(G, d) {
  if (d.status === "upcoming") return { label: "Battles open in", value: timeLeft(d.startsAt - G.now()) };
  if (d.status === "active") return { label: "Battles end in", value: timeLeft(d.endsAt - G.now()) };
  return { label: "Battles", value: "Over" };
}
function updateTimers(G) {
  const el = document.getElementById("b-time");
  if (el && cur?.data) el.textContent = timing(G, cur.data).value;
}

function render(G) {
  const d = cur.data;
  cur.sig = JSON.stringify([d.status, d.leaderboard, d.you, d.results?.seal, d.prediction, d.outcome, d.crowd?.count]);
  if (cur.view === "prep") return renderPrep(G);
  const t = timing(G, d);
  const you = d.you;
  const body = openSheet(
    "bounty",
    `
    <div class="row" style="gap:8px;margin-bottom:6px"><span class="tag ${d.tier}">${esc(d.tierName)}</span>${d.featured ? '<span class="tag featured">Featured · 1.5× rewards</span>' : ""}<span class="tag status-${d.status}">${STATUS[d.status]}</span></div>
    <h2>Bounty ${esc(d.id)}</h2>
    <p class="sub">${esc(d.realmName)} · ${d.wildcard ? "a wildcard: Gemini had no market of this realm's kind, so this one can be about anything." : `a sealed ${esc(d.category.toLowerCase())} market from Gemini waits in this camp.`}</p>
    <div class="facts">
      <div class="fact"><b>${d.participants}/${d.maxPlayers}</b><span>Warlords</span></div>
      <div class="fact"><b id="b-time">${t.value}</b><span>${t.label}</span></div>
      <div class="fact"><b>${icon("coin", 2)} ${d.entryFee}</b><span>Entry${d.minKeep > 1 ? ` · Keep Lv ${d.minKeep}+` : ""}</span></div>
      <div class="fact"><b>${d.attacksPerPlayer}</b><span>Attacks each</span></div>
    </div>
    ${questionBlock(G, d)}
    ${actionBlock(G, d)}
    <h3>Spoils by placement</h3>
    <table class="board"><thead><tr><th>Place</th><th class="num">Gold</th><th class="num">Stake allowance</th><th class="num">Trophies</th></tr></thead><tbody>
      ${d.rewards.map((r) => `<tr><td>${["1st", "2nd", "3rd", "4th +"][r.rank - 1]}</td><td class="num">${fmt(r.gold)}</td><td class="num">${r.stakeCap ? fmt(r.stakeCap) : "free call only"}</td><td class="num">${r.trophies}</td></tr>`).join("")}
    </tbody></table>
    <p class="note">The top three win the right to stake gold on the hidden question. Everyone who fought can still make a free call, and good calls earn Crystals either way.</p>
    <h3>Leaderboard</h3>
    ${board(d)}
    ${sealLine(G, d)}
    ${devBlock(G, d)}
  `,
  );
  wire(G, body, d);
}

function questionBlock(G, d) {
  if (!d.question) {
    const ended = d.status === "revealed" || d.status === "resolved";
    return `<div class="sealed"><div class="wax">?</div><div><b>Sealed question</b>${
      ended ? "This bounty is over. Only the warlords who fought in it learned its question." : `A real Gemini prediction market${d.wildcard ? "" : ` about ${esc(d.category.toLowerCase())}`}. It's revealed to every entrant the moment the battles end.`
    }</div></div>`;
  }
  return predictionBlock(G, d);
}

function actionBlock(G, d) {
  const you = d.you;
  if (!you.entered) {
    if (d.status === "upcoming" || d.status === "active") {
      const full = d.participants >= d.maxPlayers;
      const keepLow = (G.me.buildings.keep ?? 1) < d.minKeep;
      const poor = G.me.gold < d.entryFee;
      const why = full ? "This bounty is full." : keepLow ? `Needs a level ${d.minKeep} Keep.` : poor ? `You need ${d.entryFee} gold.` : "";
      return `<div class="row"><button class="btn btn-go btn-big" id="b-enter" ${why ? "disabled" : ""}>Enter for ${d.entryFee} gold</button><span class="note">${why || "Your current army becomes your defense. Rivals can attack it."}</span></div>`;
    }
    return "";
  }
  if (d.status === "upcoming") return `<div class="coach">You're in. Battles open in <b>${timeLeft(d.startsAt - G.now())}</b>. Use the time to train your army.</div>`;
  if (d.status === "active") {
    const rankTxt = you.rank ? `You're <b>#${you.rank}</b> with <b>${fmt(you.score)}</b> points${you.defense ? ` (${you.defense} from defending)` : ""}.` : "";
    return `<div class="row"><button class="btn btn-fight btn-big" id="b-prep" ${you.attacksLeft ? "" : "disabled"}>${you.attacksLeft ? `Attack · ${you.attacksLeft} left` : "No attacks left"}</button><span class="note">${rankTxt} ${you.attacksLeft ? "" : "Hold on: rivals can still attack you for defense points."}</span></div>`;
  }
  return "";
}

function board(d) {
  const rows = (d.results?.ranking ?? d.leaderboard).slice(0, 12);
  if (!rows.length) return `<p class="note">No one has entered yet. Be the first.</p>`;
  return `<table class="board"><thead><tr><th>#</th><th>Warlord</th><th class="num">Score</th>${d.results ? '<th class="num">Gold</th>' : '<th class="num">Attacks</th>'}</tr></thead><tbody>
    ${rows
      .map(
        (r) =>
          `<tr class="${r.playerId && d.you.entered && r.name === (d.results?.you?.name ?? "") ? "me" : ""}"><td>${r.rank}</td><td>${esc(r.name)} ${r.bot ? '<span class="bot-tag">rival</span>' : ""}</td><td class="num">${fmt(r.score)}</td><td class="num">${d.results ? fmt(r.gold) : `${r.attacks}/3`}</td></tr>`,
      )
      .join("")}
  </tbody></table>`;
}

function sealLine(G, d) {
  const s = d.results?.seal;
  if (!s) return "";
  const link = s.signature && G.cfg.explorerTx ? ` <a href="${G.cfg.explorerTx.replace("{sig}", s.signature)}" target="_blank" rel="noopener">view on Solana Explorer</a>` : "";
  const txt =
    s.status === "onchain"
      ? `${icon("check", 2)} Final standings sealed on Solana${s.verified ? " and verified against this table" : ""}, delivered by QuickNode Streams.`
      : s.status === "failed"
        ? "Couldn't seal the standings on Solana."
        : "Sealing the final standings on Solana…";
  return `<p class="note chain-status" style="margin-top:12px">${txt}${link}<br><span style="font-family:monospace;font-size:11px">${esc(d.results.hash)}</span></p>`;
}

function devBlock(G, d) {
  if (!G.cfg.devTools) return "";
  const btns = [];
  if (d.status === "upcoming") btns.push(`<button class="btn btn-small btn-ghost" data-dev="start">Start battles now</button>`);
  if (d.status === "active") btns.push(`<button class="btn btn-small btn-ghost" data-dev="end">End battles now</button>`);
  if (d.status === "revealed" && G.cfg.mockGemini) btns.push(`<button class="btn btn-small btn-ghost" data-dev="settle-yes">Settle YES</button><button class="btn btn-small btn-ghost" data-dev="settle-no">Settle NO</button>`);
  if (!btns.length) return "";
  return `<div class="dev"><b>Dev tools</b> ${btns.join(" ")}</div>`;
}

// ── Prediction stage ──────────────────────────────────────────────────
function predictionBlock(G, d) {
  const q = d.quote ?? {};
  const mid = q.bidBps != null && q.askBps != null ? Math.round((q.bidBps + q.askBps) / 2) : null;
  const yesPrice = q.askBps;
  const noPrice = q.bidBps != null ? 10000 - q.bidBps : null;
  const myRank = d.results?.you;
  const cap = Math.min(myRank?.stakeCap ?? 0, G.me.gold);
  const head = `
    <div class="question">${esc(d.question)}<small>${esc(d.eventTitle)}${d.expiry ? ` · resolves by ${new Date(d.expiry).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : ""} · <span style="font-family:monospace">${esc(d.market)}</span></small></div>
    <div class="row spread"><b style="font:400 22px var(--display)">Market-implied odds · Gemini</b><span class="note">${d.status === "resolved" ? "Settled" : "Live"} · YES ${cents(yesPrice)} to buy · NO ${cents(noPrice)} to buy</span></div>
    <div class="odds"><div class="yes" style="width:${mid ? mid / 100 : 50}%">YES ${pct(mid)}</div><div class="no" style="width:${mid ? 100 - mid / 100 : 50}%">NO ${pct(mid == null ? null : 10000 - mid)}</div></div>
    <p class="note" style="margin-top:2px">These are the market's odds, not ours. Your call below is yours alone.</p>
    <details class="odds-more" ${oddsOpen ? "open" : ""}><summary>How the odds moved ${icon("chart", 1)}</summary><div id="b-odds-chart" data-market="${esc(d.market)}">${chartCache.get(d.market)?.html ?? '<p class="note">Loading…</p>'}</div></details>`;
  const crowd = d.crowd?.count
    ? `<h3>Warlords' calls</h3><p class="note">${d.crowd.yes} called YES · ${d.crowd.no} called NO</p><table class="board"><tbody>${d.crowd.recent
        .map((c) => `<tr><td>${esc(c.name)}</td><td>${c.side.toUpperCase()}</td><td class="num">${pct(c.confBps)} sure</td><td class="num">${c.stake ? `${fmt(c.stake)} gold` : "free call"}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  if (d.prediction) {
    const p = d.prediction;
    const settled = d.status === "resolved";
    return `${head}
      <div class="coach">Your call: <b>${p.side.toUpperCase()}</b>, ${pct(p.confBps)} sure, ${p.stake ? `${fmt(p.stake)} gold at ${cents(p.priceBps)}` : "free call"}.
      ${
        settled
          ? `<br>Gemini settled <b>${d.outcome?.toUpperCase()}</b>. ${p.correct ? `<span class="ok-text">You were right</span>` : `<span class="bad-text">Not this time</span>`}${p.stake ? ` · payout ${fmt(p.payout)} gold` : ""} · calibration ${(1 - p.brier).toFixed(2)} · <b>+${p.crystals} Crystals</b>${p.crystals ? "" : " (overconfident calls earn none)"}`
          : `<br>Waiting for Gemini to settle this market. If you're right you'll get <b>${p.stake ? fmt(payoutFor(p.stake, p.priceBps)) : 0} gold</b>, and Crystals for how well-calibrated you were.`
      }</div>${crowd}`;
  }
  if (d.status === "resolved") return `${head}<p class="note">This market settled ${esc(d.outcome?.toUpperCase())} before you made a call.</p>${crowd}`;
  return `${head}
    <h3>Make your call</h3>
    <p class="note">${myRank ? `You placed <b>#${myRank.rank}</b>. ${myRank.stakeCap ? `You've earned the right to stake up to <b>${fmt(myRank.stakeCap)} gold</b>.` : "Only the top 3 can stake. You can still make a free call for Crystals."}` : ""}</p>
    <div class="side-pick"><button class="btn btn-go" data-side="yes" aria-pressed="true">YES · ${cents(yesPrice)}</button><button class="btn btn-fight" data-side="no" aria-pressed="false">NO · ${cents(noPrice)}</button></div>
    <div class="slider-row"><label for="p-conf">How sure are you?</label><input id="p-conf" type="range" min="50" max="99" value="65" /><output id="p-conf-out">65%</output></div>
    ${cap > 0 ? `<div class="slider-row"><label for="p-stake">Stake (gold)</label><input id="p-stake" type="range" min="0" max="${cap}" step="5" value="${Math.min(cap, Math.round(cap / 2 / 5) * 5)}" /><output id="p-stake-out"></output></div>` : ""}
    <div class="coach" id="p-coach"></div>
    <button class="btn btn-gold btn-big" id="p-go">Lock in my call</button>
    ${crowd}`;
}

function coachText(G, d, side, conf, stake) {
  const q = d.quote ?? {};
  if (q.bidBps == null || q.askBps == null) return "Waiting for a price from Gemini…";
  const price = sidePriceBps(side, q.bidBps, q.askBps);
  const edge = conf * 100 - price;
  const lines = [`You're buying <b>${side.toUpperCase()}</b> at <b>${cents(price)}</b>. The market prices it at about ${pct(price)}; you say <b>${conf}%</b>.`];
  if (stake > 0) lines.push(`If you're right, ${fmt(stake)} gold comes back as <b>${fmt(payoutFor(stake, price))} gold</b>. If not, you lose the ${fmt(stake)}.`);
  if (edge <= 0) lines.push(`<span style="color:#ff9a8a">No edge: at ${conf}% you think it's worth less than its price. Consider the other side, or make this a free call.</span>`);
  else if (edge < 300) lines.push(`A thin edge of ${Math.round(edge / 100)} points. Size small.`);
  else lines.push(`An edge of ${Math.round(edge / 100)} points.`);
  if (conf >= 95) lines.push("95%+ is near-certain. Crystals punish overconfidence, so be honest.");
  return lines.join(" ");
}

// The odds chart under a revealed question: fetched in the background, cached briefly so the
// sheet's frequent refreshes don't refetch it.
const chartCache = new Map();
let oddsOpen = false;
async function fillOddsChart(body) {
  const box = body.querySelector("#b-odds-chart");
  if (!box) return;
  const details = box.closest("details");
  details?.addEventListener("toggle", () => (oddsOpen = details.open));
  const market = box.dataset.market;
  const hit = chartCache.get(market);
  if (hit && Date.now() - hit.at < 15_000) return;
  try {
    const s = await api(`/api/odds/${encodeURIComponent(market)}?window=6h`);
    const html = `${oddsChart(s, { height: 120, label: s.question })}<p class="note">${changeTag(s.changeBps)} over the last 6 hours · ${esc(plainOdds(s.nowBps))} <button class="linklike" data-odds="${esc(market)}">Open on the odds board</button></p>`;
    chartCache.set(market, { at: Date.now(), html });
    if (box.isConnected) box.innerHTML = html;
  } catch {
    /* the chart is a nice-to-have */
  }
}

function wire(G, body, d) {
  void fillOddsChart(body);
  if (!body.dataset.oddsLinks) {
    body.dataset.oddsLinks = "1"; // #sheet-body is shared by every sheet: listen once
    body.addEventListener("click", (e) => {
      const m = e.target.closest?.("[data-odds]")?.dataset.odds;
      if (m) G.openOdds(m);
    });
  }
  body.querySelector("#b-enter")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      cur.data = await api(`/api/bounties/${d.id}/enter`, { body: {} });
      sfx("enter");
      toast(`You entered ${d.id}. Your army now defends you here.`, "good");
      await Promise.all([G.refreshMe(), G.refreshBounties()]);
      render(G);
    }),
  );
  body.querySelector("#b-prep")?.addEventListener("click", () => {
    cur.view = "prep";
    renderPrep(G);
  });
  for (const b of body.querySelectorAll("[data-dev]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const k = b.dataset.dev;
        if (k === "start") await api(`/api/dev/start/${d.id}`, { body: {} });
        if (k === "end") await api(`/api/dev/end/${d.id}`, { body: {} });
        if (k.startsWith("settle")) await api(`/api/dev/settle/${d.id}`, { body: { side: k.endsWith("yes") ? "yes" : "no" } });
        if (k === "end") sfx("reveal");
        cur.data = await api(`/api/bounties/${d.id}`);
        await Promise.all([G.refreshMe(), G.refreshBounties()]);
        render(G);
      }),
    );
  // prediction controls
  const go = body.querySelector("#p-go");
  if (go) {
    let side = "yes";
    const conf = body.querySelector("#p-conf");
    const stake = body.querySelector("#p-stake");
    const update = () => {
      body.querySelector("#p-conf-out").textContent = `${conf.value}%`;
      if (stake) body.querySelector("#p-stake-out").textContent = stake.value;
      body.querySelector("#p-coach").innerHTML = coachText(G, d, side, Number(conf.value), Number(stake?.value ?? 0));
      go.textContent = Number(stake?.value ?? 0) > 0 ? `Lock in: ${side.toUpperCase()} for ${stake.value} gold` : `Lock in a free ${side.toUpperCase()} call`;
    };
    for (const b of body.querySelectorAll("[data-side]"))
      b.addEventListener("click", () => {
        side = b.dataset.side;
        for (const x of body.querySelectorAll("[data-side]")) x.setAttribute("aria-pressed", String(x === b));
        sfx("click");
        update();
      });
    conf.addEventListener("input", update);
    stake?.addEventListener("input", update);
    update();
    go.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        cur.data = await api(`/api/bounties/${d.id}/predict`, { body: { side, confBps: Number(conf.value) * 100, stake: Number(stake?.value ?? 0) } });
        sfx("coin");
        toast("Call locked. Now we wait for Gemini to settle it.", "good");
        await G.refreshMe();
        render(G);
      }),
    );
  }
}

// ── Battle prep ───────────────────────────────────────────────────────
async function renderPrep(G) {
  const d = cur.data;
  let opps = [];
  try {
    opps = (await api(`/api/bounties/${d.id}/opponents`)).opponents;
  } catch (e) {
    return toast(e.message, "bad");
  }
  const me = G.me;
  const send = Object.fromEntries(UNIT_KEYS.map((k) => [k, me.army[k] ?? 0]));
  let target = opps[0]?.id;
  const body = openSheet(
    "bounty",
    `
    <button class="btn btn-small btn-ghost" id="prep-back">← ${esc(d.id)}</button>
    <h2 style="margin-top:8px">Choose your battle</h2>
    <p class="sub">${d.you.attacksLeft} attack${d.you.attacksLeft === 1 ? "" : "s"} left. Score comes from how much you destroy, a win bonus, and how much of your army survives. Units that fall are lost.</p>
    <h3>Target</h3>
    <div class="cards" id="opps">${opps
      .map(
        (o) => `<label class="card" style="cursor:pointer"><span class="row"><input type="radio" name="opp" value="${esc(o.id)}" ${o.id === target ? "checked" : ""}/> <b style="font:400 22px var(--display)">${esc(o.name)}</b></span>
        <span class="stats"><span>Power ${o.power}</span>${o.towers ? `<span>${o.towers} tower${o.towers > 1 ? "s" : ""}</span>` : ""}${o.score != null ? `<span>${fmt(o.score)} pts</span>` : ""}${o.guardian ? "<span>Camp guardian</span>" : o.bot ? "<span>Rival warlord</span>" : "<span>Player</span>"}</span>
        <span class="stats">${UNIT_KEYS.filter((k) => o.army?.[k]).map((k) => `${o.army[k]} ${UNITS[k].name}`).join(" · ")}</span></label>`,
      )
      .join("")}</div>
    <div id="plan"></div>
    <div class="coach" id="matchup"></div>
    <button class="btn btn-fight btn-big" id="go-fight">Attack!</button>
  `,
  );
  const matchup = () => {
    const o = opps.find((x) => x.id === target);
    const mine = armyPower(send, me.unitLevels);
    const odds = o ? mine / Math.max(1, mine + o.power) : 0;
    body.querySelector("#matchup").innerHTML = o
      ? `Your power <b>${mine}</b> vs <b>${o.power}</b>. ${odds > 0.6 ? "You should win this." : odds > 0.45 ? "An even fight. Counters will decide it." : "Outmatched. Aim for damage, not victory."} Raiders dive at Rangers, Artillery and Support; Guardians stop Raiders; Rangers pierce Guardians; Artillery punishes big stacks.`
      : "";
  };
  matchup();
  for (const r of body.querySelectorAll('input[name="opp"]')) r.addEventListener("change", () => ((target = r.value), matchup()));
  const plan = planPicker(G, body.querySelector("#plan"));
  body.querySelector("#prep-back").addEventListener("click", () => {
    cur.view = "info";
    render(G);
  });
  body.querySelector("#go-fight").addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const r = await decideBattle(() => api(`/api/bounties/${d.id}/attack`, { body: { opponent: target, ...plan() } }));
      cur.data = r.bounty;
      cur.view = "info";
      closeSheet();
      openBattle(G, r.battle, {
        loot: r.loot,
        onDone: async () => {
          await Promise.all([G.refreshMe(), G.refreshBounties()]);
          openBounty(G, d.id);
        },
      });
    }),
  );
}
