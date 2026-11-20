// The town crier: a character in the top-left of the screen. When a Gemini market moves sharply
// he rings his bell and shouts the headline in a speech bubble; click him to talk and hear the
// latest news, with a link to each market's odds chart.
import { api } from "./api.js";
import { sfx } from "./audio.js";
import { spriteUrl } from "./gfx.js";
import { $, ago } from "./ui.js";

const NAME = "Barnaby the Crier";
const headline = (t) => {
  const s = t.replace(/^Town crier: /, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const GREETINGS = [
  "Hear ye, hear ye! I watch every Gemini market in the realm and ring my bell when the odds move.",
  "Good morrow, warlord! Ask me what's stirring and I'll tell you which markets are on the move.",
  "Oyez! When a market leaps, I shout it from the square. Here's the latest.",
];
let G = null;
let news = [];
let idx = 0;
let bubbleTimer = null;
let typing = null;

export function initCrier(ctx) {
  G = ctx;
  $("crier-img").src = spriteUrl("crier", 4);
  $("crier").addEventListener("click", () => (talkOpen() ? closeTalk() : openTalk()));
  $("crier-bubble").addEventListener("click", (e) => {
    e.stopPropagation();
    openTalk();
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && talkOpen()) closeTalk();
  });
}

export const talkOpen = () => !$("crier-talk").hidden;

/** A new headline from the feed: ring the bell and shout it. */
export function crierShout(item) {
  const text = headline(item.text);
  const bubble = $("crier-bubble");
  bubble.textContent = `Hear ye! ${text}`;
  bubble.hidden = false;
  $("crier").classList.remove("ringing");
  void $("crier").offsetWidth; // restart the animation
  $("crier").classList.add("ringing");
  $("crier").classList.add("has-news");
  sfx("waystone");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => (bubble.hidden = true), 8000);
  if (talkOpen()) refresh();
}

async function refresh() {
  try {
    news = (await api("/api/odds/movers?window=1h")).crier ?? [];
  } catch {
    news = [];
  }
}

async function openTalk() {
  $("crier-bubble").hidden = true;
  $("crier").classList.remove("has-news");
  sfx("open");
  await refresh();
  idx = 0;
  $("crier-talk").hidden = false;
  render(true);
}

function closeTalk() {
  $("crier-talk").hidden = true;
  clearInterval(typing);
  sfx("close");
}

function render(greet = false) {
  const el = $("crier-talk");
  const item = news[idx];
  const line = item
    ? `${greet ? "Hear ye, hear ye! " : ""}${headline(item.text)}.`
    : `${GREETINGS[Math.floor(Math.random() * GREETINGS.length)]} The markets are quiet for now; I'll ring when the odds move.`;
  el.innerHTML = `
    <div class="talk-head"><img src="${spriteUrl("crier", 3)}" alt="" class="talk-portrait"><div><b>${NAME}</b>${item ? `<span class="note">${ago(item.at)}${news.length > 1 ? ` · ${idx + 1} of ${news.length}` : ""}</span>` : ""}</div><button class="close-x small" id="talk-x" aria-label="Close">✕</button></div>
    <p class="talk-text" id="talk-text"></p>
    <div class="talk-actions">
      ${item ? `<button class="btn btn-small btn-gold" id="talk-chart">Show me the odds</button>` : ""}
      ${news.length > 1 ? `<button class="btn btn-small btn-ghost" id="talk-prev" ${idx === 0 ? "disabled" : ""}>◀ Newer</button><button class="btn btn-small btn-ghost" id="talk-next" ${idx >= news.length - 1 ? "disabled" : ""}>Older ▶</button>` : ""}
      <button class="btn btn-small btn-ghost" id="talk-board">Odds board</button>
      ${item ? `<button class="btn btn-small btn-fight" id="talk-duel">Duel on it</button>` : ""}
    </div>`;
  typeOut($("talk-text"), line);
  $("talk-x").onclick = closeTalk;
  $("talk-board").onclick = () => (closeTalk(), G.openOdds());
  if (item) {
    $("talk-chart").onclick = () => (closeTalk(), G.openOdds(item.market));
    $("talk-duel").onclick = () => (closeTalk(), G.openColosseum({ tab: "issue", market: item.market }));
  }
  $("talk-prev")?.addEventListener("click", () => (idx--, sfx("click"), render()));
  $("talk-next")?.addEventListener("click", () => (idx++, sfx("click"), render()));
}

/** RPG-style typewriter text (instant with reduced motion). */
function typeOut(el, text) {
  clearInterval(typing);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return void (el.textContent = text);
  let i = 0;
  el.textContent = "";
  el.onclick = () => (clearInterval(typing), (el.textContent = text));
  typing = setInterval(() => {
    i += 2;
    el.textContent = text.slice(0, i);
    if (i >= text.length) clearInterval(typing);
  }, 18);
}

