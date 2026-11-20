// The SOL vault: move SOL from your wallet into the game. Every few seconds the vault is valued at
// Gemini's live SOL/USD price, and growth above its high-water mark turns into Might automatically.
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon } from "../gfx.js";
import { act, ago, currentSheet, esc, fmt, openSheet, toast } from "../ui.js";
import { signPrepared } from "../wallets.js";
import { openTreasury } from "./treasury.js";

const SOL = 1e9;
let data = null;
let timer = null;
let busy = false;
const rid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
let withdrawId = rid();

const sol = (lamports, d = 4) => (lamports == null ? "–" : (lamports / SOL).toLocaleString("en-US", { maximumFractionDigits: d }));
const usd = (micro) => (micro == null ? "–" : `$${(micro / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dollars = (n) => (n == null ? "–" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");

export async function openVault(G) {
  await load(G);
  clearInterval(timer);
  timer = setInterval(async () => {
    if (currentSheet() !== "vault") return clearInterval(timer);
    if (busy || document.activeElement?.matches?.("input")) return;
    await load(G, true);
  }, 6000);
}

async function load(G, quiet = false) {
  try {
    const before = data?.might;
    data = await api("/api/vault");
    if (quiet && before != null && data.might > before) (sfx("coin"), toast(`SOL hit a new high: +${fmt(data.might - before)} Might`, "gold"));
    render(G);
    if (quiet) G.refreshMe();
  } catch (e) {
    if (!quiet) toast(e.message, "bad");
  }
}

function render(G) {
  const d = data;
  const w = d.wallet;
  const canSign = w && w.kind !== "address" && w.verified;
  const local = d.network === "local";
  const p = d.price;
  const next = d.highWaterPrice;
  const progress = p && next && d.lamports ? Math.max(0, Math.min(100, (p.usd / next) * 100)) : 0;
  const body = openSheet(
    "vault",
    `
    <div class="vault-head">
      <div class="vault-coin">${icon("coin", 6)}</div>
      <div>
        <h2 style="margin:0">SOL Vault</h2>
        <p class="sub" style="margin:2px 0 0">Move SOL from your wallet into the game. It stays SOL: nothing is sold or swapped. Whenever SOL's price lifts your vault to a new high, the growth turns into <b>Might</b> on its own (${fmt(d.mightPerUsd)} Might per $1). Spend Might on class abilities in the Army screen (R) or stake it in the Colosseum (K).</p>
      </div>
    </div>
    <span class="tag featured">${local ? "Local test chain" : "Solana devnet"} · test SOL, not real money</span>

    <div class="facts vault-facts">
      <div class="fact big"><b>◎ ${sol(d.lamports)}</b><span>In your vault</span></div>
      <div class="fact big"><b>${usd(d.valueUsd)}</b><span>Worth now</span></div>
      <div class="fact big"><b>${p ? dollars(p.usd) : "–"}</b><span>SOL price${p ? ` · ${p.source === "dev" ? "dev demo price" : "Gemini, live"}` : ""}</span></div>
      <div class="fact big"><b>${icon("bolt", 2)} ${fmt(d.mightEarned)}</b><span>Might from growth</span></div>
    </div>

    ${
      d.lamports
        ? `<div class="hwm">
        <div class="row spread"><span>Next Might when SOL passes <b>${dollars(next)}</b></span><span class="note">high-water mark ${usd(d.hwmUsd)}</span></div>
        <div class="hwm-bar"><i style="width:${progress}%"></i></div>
        <p class="note">${p && next && p.usd >= next ? "At a new high right now: Might is being added." : `SOL is ${p && next ? `${((1 - p.usd / next) * 100).toFixed(2)}% below` : "below"} your vault's high. A dip then recovery never pays twice; only new highs do. Checked every ${d.tickSeconds} s.`}</p>
      </div>`
        : `<div class="coach">Your vault is empty. Deposit some SOL below, then watch the Might roll in whenever SOL climbs.</div>`
    }

    <div class="grid2 vault-cols">
      <section class="card">
        <h3 style="margin-top:0">${icon("chest", 2)} Deposit SOL</h3>
        ${
          canSign
            ? `<p class="note">From <b>${esc(w.label ?? w.kind)}</b> <span class="mono">${esc(short(w.address))}</span> · balance <b>◎ ${sol(d.walletLamports, 3)}</b></p>
          <div class="row"><input id="v-dep" type="number" min="${d.minSol}" step="0.1" value="${Math.max(d.minSol, Math.min(1, Math.floor(((d.walletLamports ?? 0) / SOL - 0.01) * 100) / 100)) || 1}" aria-label="SOL to deposit"><span>SOL</span>
          <button class="btn btn-go" id="v-deposit">Deposit</button></div>
          <p class="note">${w.kind === "ingame" ? "Your in-game wallet signs right here." : `${esc(w.label ?? "Your wallet")} will ask you to approve a transfer to the game's vault.`}${!local && w.kind !== "ingame" ? " Make sure it's on <b>Devnet</b>." : ""}${local && w.kind !== "ingame" ? " Locally the game runs its own test chain: airdrop yourself test SOL first. If your wallet won't sign for it, use the in-game wallet or run with NETWORK=devnet." : ""}</p>
          ${(d.walletLamports ?? 0) < 0.05 * SOL ? `<p class="note">Need test SOL? ${local || w.kind === "ingame" ? `<button class="linklike" id="v-airdrop">Airdrop 2 SOL</button> · ` : ""}<a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a> (Devnet).</p>` : ""}`
            : `<p class="note">Link a wallet first: the in-game wallet (no install), Phantom, MetaMask or another Solana wallet.</p><button class="btn btn-go" id="v-link">Link a wallet</button>`
        }
      </section>
      <section class="card">
        <h3 style="margin-top:0">${icon("coin", 2)} Withdraw SOL</h3>
        ${
          canSign
            ? `<p class="note">Back to <span class="mono">${esc(short(w.address))}</span>. Might you've earned stays yours.</p>
          <div class="row"><input id="v-wd" type="number" min="0" step="0.1" max="${d.lamports / SOL}" value="${d.lamports ? Math.min(1, d.lamports / SOL) : 0}" aria-label="SOL to withdraw"><span>SOL</span>
          <button class="btn btn-blue" id="v-withdraw" ${d.lamports ? "" : "disabled"}>Withdraw</button></div>`
            : `<p class="note">Withdrawals go to a wallet you've verified.</p>`
        }
      </section>
    </div>

    <h3>Activity</h3>
    ${
      d.ledger.length
        ? `<table class="board"><tbody>${d.ledger
            .slice(0, 12)
            .map(
              (e) => `<tr><td>${esc(LABEL[e.kind] ?? e.kind)}</td><td class="num">${e.lamports ? `◎ ${sol(e.lamports)}` : ""}${e.might ? `${icon("bolt", 1)} +${fmt(e.might)}` : ""}</td><td>${e.price ? `at ${dollars(e.price)}` : ""}</td><td>${statusOf(e)}</td><td class="note">${ago(e.at)}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : `<p class="note">Nothing yet.</p>`
    }
    <p class="note">Vault <span class="mono">${esc(d.vault ?? "not set up")}</span>${d.vaultExplorer ? ` · <a href="${esc(d.vaultExplorer)}" target="_blank" rel="noopener">view on Solana Explorer</a>` : ""}. Deposits are checked on-chain before they count, once per transaction; QuickNode Streams marks them as seen. <button class="linklike" id="v-usdc">USDC treasury (old)</button></p>`,
  );
  wire(G, body);
}

const LABEL = { deposit: "Deposit", withdraw: "Withdraw", "withdraw-refund": "Withdrawal refunded", growth: "Growth → Might" };
function statusOf(e) {
  const link = e.explorer ? ` <a href="${esc(e.explorer)}" target="_blank" rel="noopener">tx</a>` : e.signature ? ` <span class="mono" title="${esc(e.signature)}">${esc(e.signature.slice(0, 6))}…</span>` : "";
  if (e.kind === "growth") return "";
  if (e.status === "failed") return `<span class="rcpt bad">Failed</span>`;
  if (e.status === "confirmed") return `<span class="rcpt ok">On Solana ✓</span>${link}`;
  return `<span class="rcpt wait">Sending…</span>${link}`;
}

function wire(G, body) {
  body.querySelector("#v-link")?.addEventListener("click", () => G.openProfile?.());
  body.querySelector("#v-usdc")?.addEventListener("click", () => openTreasury(G, "overview", { legacy: true }));
  body.querySelector("#v-airdrop")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      await api("/api/vault/airdrop", { body: {} });
      toast("2 test SOL landed in your wallet.", "good");
      await load(G);
    }),
  );
  body.querySelector("#v-deposit")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      busy = true;
      try {
        const amount = Number(body.querySelector("#v-dep").value);
        const prep = await api("/api/vault/deposit/prepare", { body: { sol: amount } });
        toast(data.wallet.kind === "ingame" ? "Signing with your in-game wallet…" : `Approve the transfer in ${data.wallet.label ?? "your wallet"}…`);
        const signed = await signPrepared(G.me.id, data.wallet, prep);
        toast("Sending to Solana…");
        data = await api("/api/vault/deposit/submit", { body: { nonce: prep.nonce, ...signed } });
        sfx("coin");
        toast(`◎ ${amount} is in your vault. Might grows with SOL from here.`, "good");
        render(G);
        G.refreshMe();
      } finally {
        busy = false;
      }
    }),
  );
  body.querySelector("#v-withdraw")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      busy = true;
      try {
        const amount = Number(body.querySelector("#v-wd").value);
        data = await api("/api/vault/withdraw", { body: { sol: amount, requestId: withdrawId } });
        withdrawId = rid();
        toast(`◎ ${amount} sent back to your wallet.`, "good");
        render(G);
        G.refreshMe();
      } finally {
        busy = false;
      }
    }),
  );
}
