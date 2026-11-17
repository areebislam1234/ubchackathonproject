// Profile: wallet, stats, Trophy Room (Solana collectibles), history and rankings.
import { armyPower } from "/shared/battle.js";
import { BADGES, BADGE_IDS } from "/shared/rules.js";
import { api } from "../api.js";
import { sfx } from "../audio.js";
import { icon } from "../gfx.js";
import { act, ago, cents, esc, fmt, openSheet, pct, toast } from "../ui.js";
import { b64, connectPhantom, connectStandard, createIngame, importIngame, ingameSupported, isAddress, loadIngame, onWalletsChanged, phantomProvider, standardWallets } from "../wallets.js";

let tab = "overview";
let walletMode = null; // null | "choose" | "backup" | "import"
let localWallet = null; // the in-game wallet key held by this browser, if any
let canIngame = true;

export async function openProfile(G, which) {
  if (which) tab = which;
  localWallet = await loadIngame(G.me.id);
  canIngame = await ingameSupported();
  const m = G.me;
  const tabs = [
    ["overview", "Overview"],
    ["trophies", "Trophy Room"],
    ["history", "History"],
    ["rankings", "Rankings"],
  ];
  const html = `
    <div class="row spread" style="padding-right:46px"><h2>${esc(m.name)}</h2><button class="btn btn-small btn-ghost" id="logout">Log out</button></div>
    <p class="sub">Keep level ${m.buildings.keep} · ${fmt(m.trophies)} trophies · army power ${armyPower(m.army, m.unitLevels)}</p>
    <div class="chips" style="margin-bottom:12px">${tabs.map(([k, l]) => `<button class="chip" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div>
    <div id="ptab">${await tabHtml(G)}</div>`;
  const body = openSheet("profile", html);
  for (const b of body.querySelectorAll("[data-tab]"))
    b.addEventListener("click", () => {
      tab = b.dataset.tab;
      sfx("click");
      openProfile(G);
    });
  wire(G, body);
}

async function tabHtml(G) {
  const m = G.me;
  if (tab === "overview") {
    const s = m.stats;
    const acc = s.predictions ? Math.round((s.correct / s.predictions) * 100) : null;
    return `
      <h3>Solana wallet</h3>
      ${walletBlock(G)}
      <h3>Record</h3>
      <div class="facts">
        <div class="fact"><b>${s.wins}/${s.battles}</b><span>Battles won</span></div>
        <div class="fact"><b>${s.bountiesWon}/${s.bountiesEntered}</b><span>Bounties won</span></div>
        <div class="fact"><b>${acc === null ? "–" : acc + "%"}</b><span>Calls right (${s.predictions})</span></div>
        <div class="fact"><b>${fmt(s.crystalsEarned)}</b><span>Crystals earned</span></div>
        <div class="fact"><b>${s.discovered}</b><span>Bounties found</span></div>
        <div class="fact"><b>${m.attuned.length}/7</b><span>Waystones</span></div>
        <div class="fact"><b>${m.buildings.keep}</b><span>Fortress level</span></div>
        <div class="fact"><b>${Object.values(m.army).reduce((a, b) => a + b, 0)}</b><span>Units</span></div>
      </div>`;
  }
  if (tab === "trophies") {
    const holdings = m.onchain ?? {};
    const unclaimed = Object.values(m.badges).some((b) => b.status === "unclaimed" || b.status === "failed");
    return `
      <p class="sub">Badges mint to your wallet as Solana Token-2022 collectibles. The game only marks one "On Solana" when QuickNode Streams delivers the transaction back from the chain.</p>
      ${
        !m.wallet
          ? `<div class="coach">Link a wallet and every badge you've earned mints to it. ${canIngame ? `<button class="btn btn-small btn-go" id="w-create" style="margin-left:8px">Create an in-game wallet</button>` : ""} <button class="btn btn-small btn-ghost" data-tab="overview" style="margin-left:4px">More wallet options</button></div>`
          : unclaimed
            ? `<button class="btn btn-gold" id="claim">Mint unclaimed badges</button>`
            : ""
      }
      <div class="badges" style="margin-top:10px">${BADGE_IDS.map((id) => badgeCard(G, id, m.badges[id], holdings[id])).join("")}</div>`;
  }
  if (tab === "history") {
    const preds = m.predictions ?? [];
    return `
      <h3>Competitions</h3>
      ${
        m.history.length
          ? `<table class="board"><thead><tr><th>Bounty</th><th>Place</th><th class="num">Score</th><th class="num">When</th></tr></thead><tbody>${m.history
              .map((h) => `<tr><td><a href="#" data-open="${esc(h.bounty)}">${esc(h.bounty)}</a></td><td>#${h.rank} of ${h.of}</td><td class="num">${fmt(h.score)}</td><td class="num">${ago(h.at)}</td></tr>`)
              .join("")}</tbody></table>`
          : `<p class="note">No finished bounties yet.</p>`
      }
      <h3>Predictions</h3>
      ${
        preds.length
          ? `<table class="board"><thead><tr><th>Question</th><th>Call</th><th class="num">Result</th></tr></thead><tbody>${preds
              .map(
                (p) =>
                  `<tr><td>${esc(p.question)}<br><span class="note">${esc(p.bounty)}</span></td><td>${p.side.toUpperCase()} · ${pct(p.confBps)}${p.stake ? ` · ${fmt(p.stake)}g at ${cents(p.priceBps)}` : " · free"}</td><td class="num">${
                    p.correct === undefined ? "Pending" : p.correct ? `<span class="ok-text">Right</span> +${fmt(p.payout)}g +${p.crystals}◆` : `<span class="bad-text">Wrong</span> +${p.crystals}◆`
                  }</td></tr>`,
              )
              .join("")}</tbody></table>`
          : `<p class="note">No calls yet. Finish a bounty to unlock its question.</p>`
      }`;
  }
  const lb = await api("/api/leaderboard").catch(() => ({ players: [] }));
  return `<table class="board"><thead><tr><th>#</th><th>Warlord</th><th class="num">Trophies</th><th class="num">Keep</th><th class="num">Bounties won</th></tr></thead><tbody>${lb.players
    .map((p) => `<tr class="${p.name === m.name ? "me" : ""}"><td>${p.rank}</td><td>${esc(p.name)} ${p.bot ? '<span class="bot-tag">rival</span>' : ""}</td><td class="num">${fmt(p.trophies)}</td><td class="num">${p.keep}</td><td class="num">${p.wins}</td></tr>`)
    .join("")}</tbody></table>`;
}

const KIND_LABEL = { ingame: "In-game wallet", phantom: "Phantom", standard: "Solana wallet", address: "Address", demo: "Demo wallet" };

function walletBlock(G) {
  const w = G.me.wallet;
  const net = G.cfg.network === "devnet" ? "Solana devnet" : "the local Solana chain";
  if (walletMode === "backup" && localWallet) return backupBlock();
  if (walletMode === "import") return importBlock();
  if (w && walletMode !== "choose") {
    const label = w.kind === "standard" ? w.label || "Solana wallet" : KIND_LABEL[w.kind] ?? "Wallet";
    const keyHere = w.kind === "ingame" && localWallet?.address === w.address;
    return `<div class="inset">
      <div class="row spread"><b style="font:400 24px var(--display)">${esc(label)}</b><span class="tag ${w.verified ? "rare" : ""}">${w.verified ? "Verified yours" : "Receive-only"}</span></div>
      <span style="font-family:monospace;word-break:break-all">${esc(w.address)}</span>
      <p class="note" style="margin:6px 0">Badges mint here on ${net}.${G.cfg.network === "devnet" ? ` <a href="https://explorer.solana.com/address/${esc(w.address)}?cluster=devnet" target="_blank" rel="noopener">Open in Solana Explorer</a>` : ""}
      ${w.kind === "ingame" && !keyHere ? "<br>This in-game wallet's key lives in another browser. Import the key to use it here." : ""}
      ${w.kind === "address" ? "<br>We can't check this address is yours, so double-check it." : ""}
      ${w.kind === "demo" ? "<br>An old demo wallet held by the server. Switch to an in-game wallet to hold your own key." : ""}</p>
      <div class="row">${keyHere ? `<button class="btn btn-small btn-gold" id="w-backup">Back up key</button>` : ""}${w.kind === "ingame" && !keyHere ? `<button class="btn btn-small btn-ghost" id="w-import">Import key</button>` : ""}<button class="btn btn-small btn-ghost" id="w-switch">Switch wallet</button></div>
    </div>`;
  }
  const others = standardWallets();
  const phantom = phantomProvider();
  return `
    <p class="note" style="margin-top:0">Badges you earn mint to this wallet on ${net}. Linking only asks your wallet to sign a short message: no transaction, no fee. Pick whichever is easiest.</p>
    <div class="cards wallet-cards">
      <div class="card"><div class="row spread"><h4>In-game wallet</h4><span class="tag featured">No install</span></div>
        <span class="stats">We make a wallet right here in your browser. Back up its key any time and import it into Phantom or Solflare later.</span>
        ${canIngame ? `<div class="row"><button class="btn btn-go btn-small" id="w-create">${localWallet ? "Use my in-game wallet" : "Create in-game wallet"}</button><button class="btn btn-ghost btn-small" id="w-import">I have a key</button></div>` : `<span class="note">This browser can't make one (it needs Ed25519 support). Use Phantom or paste an address.</span>`}</div>
      <div class="card"><div class="row spread"><h4>Phantom</h4>${phantom ? '<span class="tag rare">Detected</span>' : ""}</div>
        <span class="stats">Connect the Phantom extension or app.${G.cfg.network === "devnet" ? " Switch it to Devnet first (Settings → Developer settings)." : ""}</span>
        ${phantom ? `<button class="btn btn-blue btn-small" id="w-phantom">Connect Phantom</button>` : `<span class="note">Not installed in this browser. <a href="https://phantom.com/download" target="_blank" rel="noopener">Get Phantom</a></span>`}</div>
      <div class="card"><h4>Other Solana wallets</h4>
        <span class="stats">Solflare, Backpack and other Solana wallets show up here when they're installed.</span>
        <div id="w-standard" class="row">${
          others.length
            ? others.map((x, i) => `<button class="btn btn-ghost btn-small" data-std="${i}">${x.icon ? `<img src="${esc(x.icon)}" alt="" width="18" height="18" style="vertical-align:-4px;margin-right:6px">` : ""}${esc(x.name)}</button>`).join("")
            : '<span class="note">None found in this browser.</span>'
        }</div></div>
      <div class="card"><h4>Just an address</h4>
        <span class="stats">Paste any Solana address, like a hardware or mobile wallet. Badges are sent there, but we can't verify it's yours.</span>
        <input id="w-addr" placeholder="Solana address" aria-label="Solana address" autocomplete="off" spellcheck="false" />
        <button class="btn btn-ghost btn-small" id="w-addr-go">Use this address</button></div>
    </div>
    ${w ? `<button class="btn btn-small btn-ghost" id="w-cancel" style="margin-top:8px">Keep my current wallet</button>` : ""}`;
}

function backupBlock() {
  return `<div class="inset">
    <b style="font:400 24px var(--display)">Back up your in-game wallet</b>
    <p class="note" style="margin:6px 0">Anyone with this key controls the wallet. Keep it somewhere private. It lives only in this browser, so if you clear site data without a backup, the wallet is gone. To use it in Phantom: <b>Add account → Import private key</b>.</p>
    <textarea id="w-secret" readonly rows="3" style="width:100%;font-family:monospace;font-size:13px;padding:8px;border:3px solid var(--outline);background:#fffaf0">${esc(localWallet.secret)}</textarea>
    <div class="row"><button class="btn btn-small btn-gold" id="w-copy">Copy key</button><button class="btn btn-small btn-ghost" id="w-done">Done</button></div>
  </div>`;
}

function importBlock() {
  return `<div class="inset">
    <b style="font:400 24px var(--display)">Import an in-game wallet</b>
    <p class="note" style="margin:6px 0">Paste the key you backed up (88 characters), or a Solana keypair array. It stays in this browser.</p>
    <textarea id="w-key" rows="3" style="width:100%;font-family:monospace;font-size:13px;padding:8px;border:3px solid var(--outline);background:#fffaf0" spellcheck="false" autocomplete="off"></textarea>
    <div class="row"><button class="btn btn-small btn-go" id="w-import-go">Import and link</button><button class="btn btn-small btn-ghost" id="w-done">Cancel</button></div>
  </div>`;
}

/** Sign the server's one-time message with a connector and link the wallet. */
async function linkWith(G, connector, kind, label) {
  const { message } = await api("/api/wallet/challenge", { body: { address: connector.address } });
  const sig = await connector.sign(new TextEncoder().encode(message));
  await api("/api/wallet/link", { body: { address: connector.address, signature: b64(sig), kind, label } });
  walletMode = null;
  sfx("coin");
  toast("Wallet linked. Your badges are minting.", "good");
  await G.refreshMe();
  openProfile(G);
}

function badgeCard(G, id, st, held) {
  const def = BADGES[id];
  const sig = st?.signature;
  const link = sig && G.cfg.explorerTx ? ` <a href="${G.cfg.explorerTx.replace("{sig}", sig)}" target="_blank" rel="noopener">tx</a>` : "";
  let status = `<span class="note">${esc(def.desc)}</span>`;
  if (st) {
    status =
      st.status === "onchain"
        ? `<span class="ok-text">${icon("check", 1)} On Solana${held ? ` ×${held}` : ""}</span>${link}`
        : st.status === "minting"
          ? `<span class="note">${st.confirmed ? "Confirmed, waiting for the Stream…" : "Minting…"}</span>${link}`
          : st.status === "failed"
            ? `<span class="bad-text">Mint failed</span>`
            : `<span class="note">Earned · link a wallet to mint</span>`;
  }
  return `<div class="badge ${st ? "" : "missing"}"><img src="/meta/${id}.png" alt="" width="64" height="64"><b>${esc(def.name)}</b>${status}</div>`;
}

function wire(G, body) {
  body.querySelector("#logout")?.addEventListener("click", () => G.logOut());
  const on = (sel, fn) => body.querySelector(sel)?.addEventListener("click", (e) => act(e.currentTarget, fn));
  on("#w-create", async () => {
    const w = localWallet ?? (await createIngame(G.me.id));
    localWallet = w;
    await linkWith(G, w, "ingame", "In-game wallet");
    if (!G.me.wallet || G.me.wallet.address === w.address) toast("Back up your key from Profile so you can use this wallet elsewhere.", "gold");
  });
  on("#w-phantom", async () => linkWith(G, await connectPhantom(), "phantom", "Phantom"));
  for (const b of body.querySelectorAll("[data-std]")) {
    const wallet = standardWallets()[Number(b.dataset.std)];
    b.addEventListener("click", (e) => act(e.currentTarget, async () => linkWith(G, await connectStandard(wallet), "standard", wallet.name)));
  }
  on("#w-addr-go", async () => {
    const a = body.querySelector("#w-addr").value.trim();
    if (!isAddress(a)) throw new Error("That doesn't look like a Solana address.");
    await api("/api/wallet/address", { body: { address: a } });
    walletMode = null;
    toast("Address saved. Badges will be sent there.", "good");
    await G.refreshMe();
    openProfile(G);
  });
  on("#w-switch", async () => {
    walletMode = "choose";
    openProfile(G);
  });
  on("#w-cancel", async () => {
    walletMode = null;
    openProfile(G);
  });
  on("#w-backup", async () => {
    walletMode = "backup";
    openProfile(G);
  });
  on("#w-import", async () => {
    walletMode = "import";
    openProfile(G);
  });
  on("#w-done", async () => {
    walletMode = null;
    openProfile(G);
  });
  on("#w-copy", async () => {
    await navigator.clipboard.writeText(localWallet.secret);
    toast("Key copied. Keep it private.", "good");
  });
  on("#w-import-go", async () => {
    const w = await importIngame(G.me.id, body.querySelector("#w-key").value);
    localWallet = w;
    await linkWith(G, w, "ingame", "In-game wallet");
  });
  // wallets that register after the page loaded
  if (walletMode !== null || !G.me.wallet) {
    const off = onWalletsChanged(() => {
      off();
      if (document.querySelector("#w-standard")) openProfile(G);
    });
  }
  body.querySelector("#claim")?.addEventListener("click", (e) =>
    act(e.currentTarget, async () => {
      await api("/api/badges/claim", { body: {} });
      toast("Minting your badges…", "good");
      await G.refreshMe();
      openProfile(G);
    }),
  );
  for (const a of body.querySelectorAll("[data-open]"))
    a.addEventListener("click", (e) => {
      e.preventDefault();
      G.openBounty(a.dataset.open);
    });
}
