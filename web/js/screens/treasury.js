// Treasury: your USDC in the game, investments at real market prices, and turning realized yield
// into Might. Devnet test USDC only: no real money.
import { ECONOMY } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon } from "../gfx.js";
import { act, ago, currentSheet, esc, fmt, openSheet, toast } from "../ui.js";

let tab = "overview";
let data = null;
let timer = null;
const ids = {}; // one request id per pending action, reused if the same click is retried
const rid = (k) => (ids[k] ??= crypto.randomUUID ? crypto.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const done = (k) => delete ids[k];

const usd = (micro, signed = false) => {
  const v = (micro ?? 0) / 1e6;
  const s = `${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${v < 0 ? "−" : signed && v > 0 ? "+" : ""}$${s}`;
};
const price = (n) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toPrecision(4));
const tone = (micro) => (micro > 0 ? "good" : micro < 0 ? "bad" : "");

export async function openTreasury(G, which) {
  if (which) tab = which;
  await load(G);
}

async function load(G) {
  try {
    data = await api("/api/funds");
  } catch (e) {
    return toast(e.message, "bad");
  }
  render(G);
  clearTimeout(timer);
  // keep prices fresh while the Invest tab is open
  timer = setTimeout(function refresh() {
    if (currentSheet() !== "treasury" || tab !== "invest") return;
    api("/api/funds")
      .then((d) => {
        data = d;
        if (currentSheet() === "treasury" && !document.activeElement?.matches("input")) render(G);
      })
      .catch(() => {});
    timer = setTimeout(refresh, 8000);
  }, 8000);
}

function render(G) {
  const tabs = [
    ["overview", "Overview"],
    ["invest", "Invest"],
    ["deposit", "Deposit"],
    ["withdraw", "Withdraw"],
    ["ledger", "Ledger"],
  ];
  const body = openSheet(
    "treasury",
    `
    <h2>Treasury</h2>
    <p class="sub">Invest USDC in coins at real market prices. When you sell for a profit, that <b>realized yield</b> converts into ${icon("bolt", 1)} <b>Might</b>, which buys Mastery for your troops. <span class="testmoney">Devnet test USDC: no real money</span></p>
    <div class="chips" style="margin-bottom:12px">${tabs.map(([k, l]) => `<button class="chip" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div>
    <div id="ttab">${{ overview, invest, deposit, withdraw, ledger }[tab](G)}</div>`,
  );
  for (const b of body.querySelectorAll("[data-tab]"))
    b.addEventListener("click", () => {
      tab = b.dataset.tab;
      sfx("click");
      load(G);
    });
  wire(G, body);
}

function overview() {
  const d = data;
  const total = d.cash + d.invested;
  return `
    <div class="rfacts">
      <div class="rfact"><span>Total value</span><b>${usd(total)}</b></div>
      <div class="rfact"><span>Principal (what you put in)</span><b>${usd(d.principal)}</b></div>
      <div class="rfact"><span>Cash (not invested)</span><b>${usd(d.cash)}</b></div>
      <div class="rfact"><span>Invested (market value)</span><b>${usd(d.invested)}</b></div>
      <div class="rfact ${tone(d.unrealized)}"><span>Unrealized gain/loss</span><b>${usd(d.unrealized, true)}</b></div>
      <div class="rfact ${tone(d.realized)}"><span>Realized gain/loss (lifetime)</span><b>${usd(d.realized, true)}</b></div>
      <div class="rfact gold"><span>Eligible yield to convert</span><b>${usd(d.eligible)}</b></div>
      <div class="rfact"><span>${icon("bolt", 1)} Might</span><b>${fmt(d.might)}</b></div>
    </div>
    <h3>Convert yield into Might</h3>
    <p class="note">Rate: <b>1 USDC of realized yield = ${d.mightPerUsdc} Might</b>. Only profit you've locked in by selling converts; your principal never does. Unrealized gains count once you sell. Losses reduce what's eligible.</p>
    <div class="row" style="flex-wrap:wrap">
      <input id="t-conv" type="number" min="0.01" step="0.01" placeholder="USDC" style="width:120px" aria-label="USDC to convert">
      <button class="btn btn-gold" id="t-conv-go" ${d.eligible > 0 ? "" : "disabled"}>Convert</button>
      <button class="btn btn-ghost" id="t-conv-all" ${d.eligible > 0 && d.cash > 0 ? "" : "disabled"}>Convert all eligible (${usd(Math.min(d.eligible, d.cash))})</button>
      <span class="note" id="t-conv-preview"></span>
    </div>
    <p class="note">Spend Might on Mastery in the Army screen (R): +3% HP and damage per rank for a unit type, up to rank 20.</p>`;
}

function invest() {
  const d = data;
  const q = new Map((d.quotes ?? []).map((x) => [x.coin, x]));
  const rows = ECONOMY.coins
    .map((c) => {
      const x = q.get(c);
      const ch = x && x.open24h ? ((x.bid - x.open24h) / x.open24h) * 100 : null;
      const pos = d.positions.find((p) => p.coin === c);
      return `<tr><td><b>${c}</b></td><td class="num">${x ? `$${price(x.bid)}` : "–"}</td><td class="num">${x ? `$${price(x.ask)}` : "–"}</td><td class="num" style="color:${ch === null ? "inherit" : ch >= 0 ? "var(--green-d)" : "var(--red-d)"}">${ch === null ? "–" : `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`}</td>
        <td class="num">${pos ? `${pos.qty.toPrecision(5)}` : ""}</td><td class="num" style="color:${pos ? (pos.unrealized >= 0 ? "var(--green-d)" : "var(--red-d)") : "inherit"}">${pos && pos.unrealized !== null ? usd(pos.unrealized, true) : ""}</td>
        <td><div class="row" style="gap:4px;flex-wrap:nowrap">${x ? `<button class="btn btn-small btn-go" data-buy="${c}">Buy</button>` : ""}${pos && x ? `<button class="btn btn-small btn-ghost" data-sell="${c}">Sell all</button>` : ""}</div></td></tr>`;
    })
    .join("");
  return `
    <p class="note">Prices are live from Gemini. You buy at the ask and sell at the bid, so a quick round trip loses the spread. Cash available: <b>${usd(d.cash)}</b>.</p>
    <div class="row" style="flex-wrap:wrap;margin-bottom:8px"><label class="note">Amount to buy (USDC) <input id="t-amt" type="number" min="${ECONOMY.minTradeUsdc}" step="1" value="${Math.max(ECONOMY.minTradeUsdc, Math.min(10, Math.floor(d.cash / 1e6)))}" style="width:100px"></label></div>
    <div class="rtable-wrap"><table class="board rtable"><thead><tr><th>Coin</th><th class="num">Bid</th><th class="num">Ask</th><th class="num">24h</th><th class="num">You hold</th><th class="num">Gain/loss</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    ${d.quotes?.length ? "" : `<div class="coach">Prices are unavailable right now, so trading is paused.</div>`}`;
}

function deposit() {
  return `
    <p class="note">Send devnet USDC from your wallet to the game. Get free test USDC at faucet.circle.com (choose Solana devnet). Your deposit is credited once QuickNode Streams sees it on-chain, usually within a minute.</p>
    <div class="row" style="flex-wrap:wrap">
      <label class="note">Amount (USDC) <input id="t-dep-amt" type="number" min="1" step="1" value="10" style="width:100px"></label>
      <button class="btn btn-go" id="t-dep">Create deposit link</button>
    </div>
    <div id="t-dep-out"></div>
    <h3>Card top-up</h3>
    <p class="note"><button class="btn btn-small" disabled>Pay by card</button> Coming when the game moves to real money.</p>`;
}

function withdraw(G) {
  const w = G.me.wallet;
  const ok = w && w.kind !== "address" && w.verified !== false;
  return `
    <p class="note">Withdrawals send USDC back to your linked wallet. Cash available: <b>${usd(data.cash)}</b>. Sell investments first to withdraw more.</p>
    ${
      ok
        ? `<p class="note">To: <code>${esc(w.address)}</code> (${esc(w.label ?? w.kind)})</p>
    <div class="row"><input id="t-wd" type="number" min="${ECONOMY.minWithdrawUsdc}" step="0.01" placeholder="USDC" style="width:120px" aria-label="USDC to withdraw"><button class="btn btn-blue" id="t-wd-go" ${data.cash > 0 ? "" : "disabled"}>Withdraw</button></div>`
        : `<div class="coach">Link a wallet you've proven is yours (Phantom or the in-game wallet) in Profile → Solana wallet. Pasted receive-only addresses can't receive withdrawals.</div>`
    }`;
}

const KIND = { deposit: "Deposit", buy: "Buy", sell: "Sell", convert: "Convert to Might", withdraw: "Withdraw", "withdraw-refund": "Withdrawal refunded", "dev-credit": "Test credit (dev)" };
function ledger() {
  const rows = data.ledger
    .map(
      (e) =>
        `<tr><td>${ago(e.at)}</td><td>${KIND[e.kind] ?? e.kind}${e.coin ? ` ${e.coin}` : ""}${e.status && e.status !== "confirmed" ? ` <span class="note">(${e.status})</span>` : ""}</td><td class="num" style="color:${e.usdc >= 0 ? "var(--green-d)" : "inherit"}">${usd(e.usdc, true)}</td><td class="num">${e.price ? `$${price(e.price)}` : ""}</td><td class="num" style="color:${(e.realized ?? 0) >= 0 ? "var(--green-d)" : "var(--red-d)"}">${e.realized !== undefined ? usd(e.realized, true) : e.might ? `+${e.might} Might` : ""}</td></tr>`,
    )
    .join("");
  return rows ? `<div class="rtable-wrap"><table class="board rtable"><thead><tr><th>When</th><th>What</th><th class="num">USDC</th><th class="num">Price</th><th class="num">Realized</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="coach">Nothing yet. Make a deposit to get started.</div>`;
}

function wire(G, body) {
  const q = (s) => body.querySelector(s);
  const after = async (msg) => {
    if (msg) toast(msg, "good");
    await Promise.all([load(G), G.refreshMe()]);
  };
  q("#t-conv")?.addEventListener("input", (e) => {
    const v = Number(e.target.value) || 0;
    q("#t-conv-preview").textContent = v > 0 ? `= ${Math.floor(v * data.mightPerUsdc)} Might` : "";
  });
  q("#t-conv-go")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const r = await api("/api/funds/convert", { body: { usdc: Number(q("#t-conv").value), requestId: rid("conv") } });
      done("conv");
      sfx("upgrade");
      await after(`+${r.might} Might`);
    }),
  );
  q("#t-conv-all")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const r = await api("/api/funds/convert", { body: { usdc: "all", requestId: rid("conv-all") } });
      done("conv-all");
      sfx("upgrade");
      await after(`+${r.might} Might`);
    }),
  );
  for (const b of body.querySelectorAll("[data-buy]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const coin = b.dataset.buy;
        const r = await api("/api/funds/buy", { body: { coin, usdc: Number(q("#t-amt").value), requestId: rid(`buy-${coin}`) } });
        done(`buy-${coin}`);
        sfx("coin");
        await after(`Bought ${r.fill.qty.toPrecision(5)} ${coin} at $${price(r.fill.price)}`);
      }),
    );
  for (const b of body.querySelectorAll("[data-sell]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const coin = b.dataset.sell;
        const r = await api("/api/funds/sell", { body: { coin, qty: "all", requestId: rid(`sell-${coin}`) } });
        done(`sell-${coin}`);
        sfx("coin");
        await after(`Sold ${coin} at $${price(r.fill.price)}: ${usd(r.fill.realized, true)} realized`);
      }),
    );
  q("#t-dep")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const amt = Number(q("#t-dep-amt").value) || null;
      const r = await api("/api/funds/deposit", { body: { usdc: amt } });
      q("#t-dep-out").innerHTML = `
        <div class="coach">
          <p style="margin:0 0 8px"><a class="btn btn-gold" href="${esc(r.url)}">Open in Phantom</a> <span class="note">Opens a ready-to-sign USDC payment (Solana Pay).</span></p>
          <p style="margin:0">Or send devnet USDC manually to <code>${esc(r.recipient)}</code> <button class="btn btn-small btn-ghost" id="t-copy">Copy</button></p>
          <p class="note" style="margin:6px 0 0">${r.linkedWallet ? "Sent from your linked wallet, it's credited automatically." : "Use the button so the deposit is matched to you, or link your wallet first."}</p>
        </div>`;
      q("#t-copy")?.addEventListener("click", () => navigator.clipboard?.writeText(r.recipient).then(() => toast("Address copied.", "good")));
    }),
  );
  q("#t-wd-go")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      await api("/api/funds/withdraw", { body: { usdc: Number(q("#t-wd").value), requestId: rid("wd") } });
      done("wd");
      await after("Withdrawal sent. It shows as confirmed once the Stream sees it.");
    }),
  );
}
