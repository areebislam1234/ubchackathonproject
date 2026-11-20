// The battle board: standings and every fight as it happens: who won, who lost, and the Solana block
// that decided it when the on-chain program resolved the battle.
import { api } from "../api.js";
import { icon } from "../gfx.js";
import { ago, currentSheet, esc, fmt, openSheet, toast } from "../ui.js";

let timer = null;
let tab = "recent";
const KIND = { bounty: "Bounty", boss: "Boss", duel: "Colosseum" };

export async function openFights(G) {
  await load(G);
  clearInterval(timer);
  timer = setInterval(() => (currentSheet() === "fights" ? load(G, true) : clearInterval(timer)), 4000);
}

async function load(G, quiet = false) {
  try {
    render(G, await api("/api/fights"));
  } catch (e) {
    if (!quiet) toast(e.message, "bad");
  }
}

function render(G, d) {
  const me = G.me?.id;
  const recent = d.fights.length
    ? `<table class="board fights"><thead><tr><th>Winner</th><th>Loser</th><th>Where</th><th>Block</th><th></th></tr></thead><tbody>${d.fights
        .map(
          (f) => `<tr class="${f.winner.id === me || f.loser.id === me ? "me" : ""}">
          <td><b class="win">${icon("crown", 1)} ${esc(f.winner.name)}</b></td>
          <td class="lose">${esc(f.loser.name)}</td>
          <td><span class="tag">${esc(KIND[f.kind] ?? f.kind)}</span> <span class="note">${esc(f.where)}</span></td>
          <td>${f.onchain ? `${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">#${fmt(f.slot)}</a>` : `#${fmt(f.slot ?? 0)}`} <span class="rcpt ok">Solana</span>` : `<span class="note">off-chain</span>`}</td>
          <td class="note">${ago(f.at)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="note">No fights yet. Attack in a bounty, challenge a boss, or duel in the Colosseum.</p>`;
  const standings = d.standings.length
    ? `<table class="board"><thead><tr><th>#</th><th>Warlord</th><th class="num">Won</th><th class="num">Lost</th><th class="num">Win rate</th></tr></thead><tbody>${d.standings
        .map((r, i) => `<tr class="${r.id === me ? "me" : ""}"><td>${i + 1}</td><td>${esc(r.name)}${r.bot ? ' <span class="note">rival</span>' : ""}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${Math.round((100 * r.wins) / Math.max(1, r.wins + r.losses))}%</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="note">Standings appear after the first fight.</p>`;
  const body = openSheet(
    "fights",
    `
    <h2 style="margin:0">${icon("swords", 3)} Battle board</h2>
    <p class="sub">Every fight in the realm as it happens. When the Fortune Front program on Solana decides a battle, its block number links to the transaction, so anyone can check who really won.</p>
    <div class="chips" style="margin:8px 0"><button class="chip" data-t="recent" aria-pressed="${tab === "recent"}">Latest fights</button><button class="chip" data-t="standings" aria-pressed="${tab === "standings"}">Standings</button></div>
    ${tab === "recent" ? recent : standings}
    <p class="note">${fmt(d.total)} fights recorded · updates live</p>`,
  );
  for (const b of body.querySelectorAll("[data-t]")) b.addEventListener("click", () => ((tab = b.dataset.t), render(G, d)));
}
