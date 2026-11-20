// The Vault: your crypto portfolio in the game. Deposit SOL, USDC or any Solana token from your wallet,
// trade every coin Gemini prices in USD at live prices, and earn Might for trading well: realized
// profit pays the most, holding while prices reach new highs pays a little.
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon } from "../gfx.js";
import { sparkline } from "../odds-chart.js";
import { act, ago, currentSheet, esc, fmt, openSheet, toast } from "../ui.js";
import { signPrepared } from "../wallets.js";

const SOL = 1e9;
let data = null;
let timer = null;
let busy = false;
let tab = "holdings";
const st = { from: "USDC", to: "BTC", amount: "", q: "", coins: null, quotes: {}, tokens: null, withdrawing: null };
const rid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
let orderId = rid();
let withdrawId = rid();

const usd = (micro) => (micro == null ? "–" : `${micro < 0 ? "−" : ""}$${(Math.abs(micro) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const price = (n) => (n == null ? "–" : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 4 : 8 })}`);
const qty = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 8 }));
const pct = (x) => (x == null ? "" : `<span class="chg ${x > 0 ? "up" : x < 0 ? "down" : ""}">${x > 0 ? "▲" : x < 0 ? "▼" : ""} ${(Math.abs(x) * 100).toFixed(2)}%</span>`);
const pnl = (micro) => (micro == null ? "–" : `<span class="chg ${micro > 0 ? "up" : micro < 0 ? "down" : ""}">${usd(micro)}</span>`);
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");

export async function openVault(G, which) {
  if (which) tab = which;
  await load(G);
  clearInterval(timer);
  timer = setInterval(async () => {
    if (currentSheet() !== "vault") return clearInterval(timer);
    if (busy || document.activeElement?.matches?.("input, select")) return;
    await load(G, true);
  }, 8000);
}

async function load(G, quiet = false) {
  try {
    const before = data?.might;
    data = await api("/api/vault");
    if (quiet && before != null && data.might > before) (sfx("coin"), toast(`New highs: +${fmt(data.might - before)} Might`, "gold"));
    render(G);
    if (quiet) G.refreshMe();
  } catch (e) {
    if (!quiet) toast(e.message, "bad");
  }
}

function render(G) {
  const d = data;
  const local = d.network === "local";
  const tabs = [
    ["holdings", "Holdings"],
    ["deposit", "Deposit"],
    ["trade", "Trade"],
    ["history", "History"],
  ];
  const body = openSheet(
    "vault",
    `
    <div class="vault-head">
      <div class="vault-coin">${icon("coin", 6)}</div>
      <div>
        <h2 style="margin:0">Vault</h2>
        <p class="sub" style="margin:2px 0 0">Bring in SOL, USDC or any Solana token, and trade ${st.coins ? `${st.coins.length} coins` : "every coin Gemini lists"} at live prices. <b>Selling at a profit</b> earns ${fmt(d.rates.realized)} Might per $1; <b>holding</b> while a coin reaches new highs earns ${fmt(d.rates.hodl)} per $1. Spend Might on class abilities (R) or Colosseum stakes (K).</p>
      </div>
    </div>
    <span class="tag featured">${local ? "Local test chain" : "Solana devnet"} · test money, not real</span>

    <div class="facts vault-facts">
      <div class="fact big"><b>${usd(d.totalUsd)}</b><span>Portfolio value</span></div>
      <div class="fact big"><b>${pnl(d.realizedUsd)}</b><span>Realized profit</span></div>
      <div class="fact big"><b>${icon("bolt", 2)} ${fmt(d.mightTrading)}</b><span>Might from trading</span></div>
      <div class="fact big"><b>${icon("bolt", 2)} ${fmt(d.mightHodl)}</b><span>Might from holding</span></div>
    </div>
    ${d.realizedUsd < d.realizedPeakUsd ? `<p class="note">You're ${usd(d.realizedPeakUsd - d.realizedUsd)} below your best realized result: win that back and trading pays Might again.</p>` : ""}

    <div class="chips" role="tablist">${tabs.map(([k, n]) => `<button class="chip" role="tab" data-vtab="${k}" aria-pressed="${tab === k}">${n}</button>`).join("")}</div>
    <div id="v-body">${tab === "holdings" ? holdingsTab(d) : tab === "deposit" ? depositTab(d) : tab === "trade" ? tradeTab(d) : historyTab(d)}</div>
    <p class="note">Vault account <span class="mono">${esc(d.vault ?? "not set up")}</span>${d.vaultExplorer ? ` · <a href="${esc(d.vaultExplorer)}" target="_blank" rel="noopener">view on Solana Explorer</a>` : ""}. Deposits are checked on-chain before they count, once per transaction; QuickNode Streams marks them as seen. Trades fill at Gemini's live bid and ask on the game's ledger.</p>`,
  );
  wire(G, body);
}

// ── Holdings ──────────────────────────────────────────────────────────
function holdingsTab(d) {
  if (!d.holdings.length) return `<div class="coach">Your vault is empty. Open <b>Deposit</b> to bring in SOL, USDC or another token from your wallet.</div>`;
  const rows = d.holdings
    .map((h) => {
      const growth = h.nextAtPrice && h.price ? (h.price >= h.nextAtPrice ? `<span class="chg up">at a new high</span>` : `next Might above ${price(h.nextAtPrice)}`) : h.stable ? "stable" : h.priced ? "" : "no price";
      const w = st.withdrawing === h.asset;
      return `<tr>
        <td><b>${esc(h.name)}</b>${h.withdrawable ? "" : ` <span class="note" title="Bought on the game ledger: sell it for SOL or USDC to withdraw">ledger</span>`}</td>
        <td class="num">${qty(h.qty)}</td>
        <td class="num">${price(h.price)}${h.stable ? "" : ` ${pct(h.change24h)}`}</td>
        <td class="num">${usd(h.valueUsd)}</td>
        <td class="num">${h.stable ? "" : pnl(h.unrealizedUsd)}</td>
        <td class="note">${growth}</td>
        <td class="row" style="gap:4px;flex-wrap:nowrap">${h.priced ? `<button class="btn btn-small btn-ghost" data-trade-from="${esc(h.asset)}">Trade</button>` : ""}${h.withdrawable ? `<button class="btn btn-small btn-ghost" data-withdraw="${esc(h.asset)}">Withdraw</button>` : ""}</td>
      </tr>${
        w
          ? `<tr><td colspan="7"><div class="row"><span>Withdraw</span><input id="v-wd" type="number" min="0" step="any" max="${h.qty}" value="${h.qty}" aria-label="Amount of ${esc(h.name)} to withdraw"><span>${esc(h.asset.startsWith("mint:") ? "tokens" : h.asset)}</span><button class="btn btn-blue btn-small" id="v-wd-go" data-asset="${esc(h.asset)}">Send to my wallet</button><button class="btn btn-small btn-ghost" id="v-wd-cancel">Cancel</button></div><p class="note">Goes back to your verified wallet${d.wallet ? ` <span class="mono">${esc(short(d.wallet.address))}</span>` : ""}. Might you've earned stays yours.</p></td></tr>`
          : ""
      }`;
    })
    .join("");
  return `<table class="board vault-table"><thead><tr><th>Asset</th><th class="num">Amount</th><th class="num">Price</th><th class="num">Value</th><th class="num">Unrealized</th><th>Holding Might</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="note">Unrealized profit becomes realized (and earns trading Might) when you sell. Prices refresh every ${d.tickSeconds} s.</p>`;
}

// ── Deposit ───────────────────────────────────────────────────────────
function depositTab(d) {
  const w = d.wallet;
  const canSign = w && w.kind !== "address" && w.verified;
  if (!canSign) return `<p class="note">Link a wallet first: the in-game wallet (no install), Phantom, MetaMask or another Solana wallet.</p><button class="btn btn-go" id="v-link">Link a wallet</button>`;
  const local = d.network === "local";
  const tokens = st.tokens;
  return `<p class="note">From <b>${esc(w.label ?? w.kind)}</b> <span class="mono">${esc(short(w.address))}</span>${w.kind === "ingame" ? " · signs right here" : ` · ${esc(w.label ?? "your wallet")} asks you to approve${local ? "" : ". Make sure it's on <b>Devnet</b>"}`}.</p>
    <div class="grid2 vault-cols">
      <section class="card">
        <h3 style="margin-top:0">◎ SOL</h3>
        <p class="note">In your wallet: <b>◎ ${(d.walletLamports ?? 0) / SOL >= 0 ? qty((d.walletLamports ?? 0) / SOL) : "–"}</b></p>
        <div class="row"><input id="v-dep" type="number" min="${d.minSol}" step="0.1" value="${Math.max(d.minSol, Math.min(1, Math.floor(((d.walletLamports ?? 0) / SOL - 0.01) * 100) / 100)) || 1}" aria-label="SOL to deposit"><span>SOL</span><button class="btn btn-go" id="v-deposit">Deposit</button></div>
        ${(d.walletLamports ?? 0) < 0.05 * SOL ? `<p class="note">Need test SOL? ${local || w.kind === "ingame" ? `<button class="linklike" id="v-airdrop">Airdrop 2 SOL</button> · ` : ""}<a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a></p>` : ""}
      </section>
      <section class="card">
        <h3 style="margin-top:0">${icon("coin", 2)} Tokens</h3>
        ${
          tokens === null
            ? `<p class="note">Looking in your wallet…</p>`
            : tokens.length
              ? `<table class="board"><tbody>${tokens
                  .map(
                    (t, i) => `<tr><td><b>${esc(t.asset.startsWith("mint:") ? `Token ${short(t.mint)}` : t.asset)}</b>${t.asset.startsWith("mint:") ? ` <span class="note" title="No market price: it can be held and withdrawn, not traded">unpriced</span>` : ""}</td><td class="num">${qty(t.amount)}</td>
                  <td class="row" style="gap:4px;flex-wrap:nowrap"><input type="number" min="0" step="any" max="${t.amount}" value="${t.amount}" data-tok-amt="${i}" aria-label="Amount to deposit" style="width:7em"><button class="btn btn-small btn-go" data-tok-dep="${i}">Deposit</button></td></tr>`,
                  )
                  .join("")}</tbody></table>`
              : `<p class="note">No tokens in this wallet yet. Free devnet USDC: <a href="https://faucet.circle.com" target="_blank" rel="noopener">faucet.circle.com</a> (choose Solana Devnet).</p>`
        }
        <details><summary class="note">Deposit by token address</summary><div class="row"><input id="v-mint" placeholder="Token mint address" aria-label="Token mint address"><input id="v-mint-amt" type="number" min="0" step="any" placeholder="Amount" aria-label="Amount" style="width:7em"><button class="btn btn-small btn-go" id="v-mint-dep">Deposit</button></div></details>
      </section>
    </div>`;
}

// ── Trade ─────────────────────────────────────────────────────────────
function tradeTab(d) {
  const sellable = d.holdings.filter((h) => h.priced);
  if (!sellable.length) return `<div class="coach">Deposit SOL or USDC first, then trade it into any coin.</div>`;
  if (!sellable.some((h) => h.asset === st.from)) st.from = sellable[0].asset;
  const fromH = sellable.find((h) => h.asset === st.from);
  const qTo = st.quotes[st.to];
  const fromPx = fromH.stable ? 1 : (st.quotes[st.from]?.bid ?? fromH.price);
  const toPx = st.to === "USDC" ? 1 : qTo?.ask;
  const amt = Number(st.amount);
  const estimate = amt > 0 && fromPx && toPx ? (amt * fromPx) / toPx : null;
  const list = (st.coins ?? []).filter((c) => c !== st.from && (!st.q || c.includes(st.q.toUpperCase()))).slice(0, 60);
  return `<div class="grid2 vault-cols">
    <section class="card">
      <h3 style="margin-top:0">Swap</h3>
      <label class="note" for="v-from">Sell</label>
      <div class="row"><select id="v-from" aria-label="Coin to sell">${sellable.map((h) => `<option value="${esc(h.asset)}" ${h.asset === st.from ? "selected" : ""}>${esc(h.name)} (${qty(h.qty)})</option>`).join("")}</select>
      <input id="v-amt" type="number" min="0" step="any" value="${esc(st.amount)}" placeholder="Amount" aria-label="Amount to sell"><button class="btn btn-small btn-ghost" id="v-max">Max</button></div>
      <label class="note">Buy</label>
      <p><b style="font:400 22px var(--display)">${esc(st.to)}</b> ${toPx ? `at ${price(toPx)}` : ""} ${qTo ? pct(qTo.open24h ? qTo.mid / qTo.open24h - 1 : null) : ""}</p>
      <p class="note">${estimate !== null ? `≈ <b>${qty(estimate)} ${esc(st.to)}</b> for ${qty(amt)} ${esc(fromH.name)} (≈ ${usd(Math.round(amt * fromPx * 1e6))})` : "Pick a coin on the right and enter an amount."}</p>
      <button class="btn btn-go btn-big" id="v-trade" ${estimate ? "" : "disabled"}>Trade</button>
      <p class="note">Sells fill at Gemini's bid and buys at the ask, so quick round trips cost the spread. Selling for more than you paid is realized profit: ${fmt(d.rates.realized)} Might per $1 once you're past your best result so far.</p>
    </section>
    <section class="card">
      <div class="row spread"><h3 style="margin:0">Coins</h3><input id="v-q" value="${esc(st.q)}" placeholder="Search" aria-label="Search coins" style="width:8em"></div>
      ${
        st.coins === null
          ? `<p class="note">Loading Gemini's coin list…</p>`
          : `<div class="coin-list">${["USDC", ...list]
              .filter((c) => c !== st.from && (!st.q || c.includes(st.q.toUpperCase())))
              .map((c) => {
                const q = c === "USDC" ? { mid: 1, open24h: 1 } : st.quotes[c];
                return `<button class="coin-row ${c === st.to ? "on" : ""}" data-to="${esc(c)}"><b>${esc(c)}</b><span class="num">${q ? price(q.mid) : "…"}</span><span>${q ? pct(q.open24h ? q.mid / q.open24h - 1 : null) : ""}</span></button>`;
              })
              .join("")}</div>`
      }
    </section>
  </div>`;
}

// ── History ───────────────────────────────────────────────────────────
const LABEL = { deposit: "Deposit", withdraw: "Withdraw", "withdraw-refund": "Withdrawal refunded", growth: "Holding → Might", trade: "Trade", migrated: "Moved in from the old Treasury" };
function historyTab(d) {
  if (!d.ledger.length) return `<p class="note">Nothing yet.</p>`;
  return `<table class="board"><tbody>${d.ledger
    .slice(0, 40)
    .map((e) => {
      const what =
        e.kind === "trade"
          ? `${qty(e.qty)} ${esc(e.from)} → ${qty(e.toQty)} ${esc(e.to)}${e.realized ? ` · ${e.realized > 0 ? "profit" : "loss"} ${pnl(e.realized)}` : ""}`
          : e.qty != null
            ? `${qty(e.qty)} ${esc(e.asset?.startsWith("mint:") ? "tokens" : (e.asset ?? "SOL"))}`
            : e.lamports
              ? `◎ ${qty(e.lamports / SOL)}`
              : e.asset
                ? esc(e.asset)
                : "";
      return `<tr><td>${esc(LABEL[e.kind] ?? e.kind)}</td><td>${what}</td><td class="num">${e.might ? `${icon("bolt", 1)} +${fmt(e.might)}` : ""}</td><td>${statusOf(e)}</td><td class="note">${ago(e.at)}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}
function statusOf(e) {
  if (e.kind === "withdraw-refund") return `<span class="rcpt">Back in your vault</span>`;
  if (e.kind === "growth" || e.kind === "trade" || e.kind === "migrated") return "";
  const link = e.explorer ? ` <a href="${esc(e.explorer)}" target="_blank" rel="noopener">tx</a>` : "";
  if (e.status === "failed") return `<span class="rcpt bad">Failed</span>`;
  if (e.status === "confirmed") return `<span class="rcpt ok">On Solana ✓</span>${e.streamed ? ` <span class="note">QuickNode saw it</span>` : ""}${link}`;
  return `<span class="rcpt wait">Sending…</span>${link}`;
}

// ── Wiring ────────────────────────────────────────────────────────────
async function loadCoins(G) {
  try {
    const r = await api(`/api/vault/coins?limit=60${st.q ? `&q=${encodeURIComponent(st.q)}` : ""}`);
    st.coins = r.coins;
    Object.assign(st.quotes, r.quotes);
  } catch (e) {
    st.coins = st.coins ?? [];
    toast(e.message, "bad");
  }
  if (tab === "trade" && currentSheet() === "vault") render(G);
}
async function loadTokens(G) {
  try {
    st.tokens = (await api("/api/vault/tokens")).tokens;
  } catch {
    st.tokens = [];
  }
  if (tab === "deposit" && currentSheet() === "vault") render(G);
}

async function deposit(G, prepare, label) {
  busy = true;
  try {
    const prep = await prepare();
    toast(data.wallet.kind === "ingame" ? "Signing with your in-game wallet…" : `Approve the transfer in ${data.wallet.label ?? "your wallet"}…`);
    const signed = await signPrepared(G.me.id, data.wallet, prep);
    toast("Sending to Solana…");
    data = await api("/api/vault/deposit/submit", { body: { nonce: prep.nonce, ...signed } });
    sfx("coin");
    toast(`${label} is in your vault.`, "good");
    st.tokens = null;
    render(G);
    G.refreshMe();
    if (tab === "deposit") loadTokens(G);
  } finally {
    busy = false;
  }
}

function wire(G, body) {
  for (const b of body.querySelectorAll("[data-vtab]"))
    b.addEventListener("click", () => {
      tab = b.dataset.vtab;
      sfx("click");
      render(G);
      if (tab === "trade" && !st.coins) loadCoins(G);
      if (tab === "deposit" && st.tokens === null) loadTokens(G);
    });
  if (tab === "trade" && !st.coins) loadCoins(G);
  if (tab === "deposit" && st.tokens === null) loadTokens(G);
  body.querySelector("#v-link")?.addEventListener("click", () => G.openProfile?.());
  body.querySelector("#v-airdrop")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      await api("/api/vault/airdrop", { body: {} });
      toast("2 test SOL landed in your wallet.", "good");
      await load(G);
    }),
  );
  // holdings
  for (const b of body.querySelectorAll("[data-trade-from]"))
    b.addEventListener("click", () => {
      st.from = b.dataset.tradeFrom;
      if (st.to === st.from) st.to = st.from === "USDC" ? "BTC" : "USDC";
      tab = "trade";
      render(G);
    });
  for (const b of body.querySelectorAll("[data-withdraw]")) b.addEventListener("click", () => ((st.withdrawing = b.dataset.withdraw), render(G)));
  body.querySelector("#v-wd-cancel")?.addEventListener("click", () => ((st.withdrawing = null), render(G)));
  body.querySelector("#v-wd-go")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      busy = true;
      try {
        const asset = e.currentTarget.dataset.asset;
        const amount = Number(body.querySelector("#v-wd").value);
        data = await api("/api/vault/withdraw", { body: { asset, amount, requestId: withdrawId } });
        withdrawId = rid();
        st.withdrawing = null;
        toast(`${qty(amount)} ${asset.startsWith("mint:") ? "tokens" : asset} sent back to your wallet.`, "good");
        render(G);
        G.refreshMe();
      } finally {
        busy = false;
      }
    }),
  );
  // deposits
  body.querySelector("#v-deposit")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const amount = Number(body.querySelector("#v-dep").value);
      await deposit(G, () => api("/api/vault/deposit/prepare", { body: { sol: amount } }), `◎ ${amount}`);
    }),
  );
  for (const b of body.querySelectorAll("[data-tok-dep]"))
    b.addEventListener("click", (e) =>
      act(e.currentTarget, async () => {
        const t = st.tokens[Number(b.dataset.tokDep)];
        const amount = Number(body.querySelector(`[data-tok-amt="${b.dataset.tokDep}"]`).value);
        await deposit(G, () => api("/api/vault/deposit/token/prepare", { body: { mint: t.mint, amount } }), `${qty(amount)} ${t.asset.startsWith("mint:") ? "tokens" : t.asset}`);
      }),
    );
  body.querySelector("#v-mint-dep")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      const mint = body.querySelector("#v-mint").value.trim();
      const amount = Number(body.querySelector("#v-mint-amt").value);
      await deposit(G, () => api("/api/vault/deposit/token/prepare", { body: { mint, amount } }), `${qty(amount)} tokens`);
    }),
  );
  // trading
  body.querySelector("#v-from")?.addEventListener("change", (e) => {
    st.from = e.target.value;
    st.amount = "";
    if (st.to === st.from) st.to = st.from === "USDC" ? "BTC" : "USDC";
    render(G);
  });
  body.querySelector("#v-amt")?.addEventListener("input", (e) => {
    st.amount = e.target.value;
    clearTimeout(st.typing);
    st.typing = setTimeout(() => {
      if (currentSheet() !== "vault") return;
      render(G);
      const el = document.querySelector("#v-amt");
      el?.focus();
      el?.setSelectionRange?.(el.value.length, el.value.length);
    }, 350);
  });
  body.querySelector("#v-max")?.addEventListener("click", () => {
    const h = data.holdings.find((x) => x.asset === st.from);
    st.amount = String(h?.qty ?? "");
    render(G);
  });
  body.querySelector("#v-q")?.addEventListener("input", (e) => {
    st.q = e.target.value.trim();
    clearTimeout(st.searching);
    st.searching = setTimeout(() => loadCoins(G).then(() => document.querySelector("#v-q")?.focus()), 350);
  });
  for (const b of body.querySelectorAll("[data-to]"))
    b.addEventListener("click", async () => {
      st.to = b.dataset.to;
      sfx("click");
      render(G);
    });
  body.querySelector("#v-trade")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      busy = true;
      try {
        const r = await api("/api/vault/trade", { body: { from: st.from, to: st.to, amount: Number(st.amount), requestId: orderId } });
        orderId = rid();
        data = r.vault;
        const t = r.trade;
        sfx(t.might ? "upgrade" : "coin");
        toast(`Sold ${qty(t.sold)} ${t.from} for ${qty(t.bought)} ${t.to}${t.realized > 0 ? ` · profit ${usd(t.realized)}` : t.realized < 0 ? ` · loss ${usd(t.realized)}` : ""}${t.might ? ` · +${fmt(t.might)} Might` : ""}`, t.might ? "gold" : "good");
        st.amount = "";
        render(G);
        G.refreshMe();
      } finally {
        busy = false;
      }
    }),
  );
  void sparkline;
}
