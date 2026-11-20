// "Battle being decided on Solana…": when the on-chain program decides a battle the server waits for
// it (about a second). This shows a small overlay while the request is out (only if it takes a
// moment, so local play doesn't flash it), and polls if the server says the battle is still pending.
import { api } from "./api.js";
import { esc } from "./ui.js";

let el = null;
function show(text) {
  if (!el) {
    el = document.createElement("div");
    el.className = "chain-wait";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.append(el);
  }
  el.innerHTML = `<div class="chain-wait-box panel"><span class="chain-spin" aria-hidden="true"></span><b>${esc(text)}</b><span class="note">The StakeClash program on Solana rolls the battle; nobody can pick the result.</span></div>`;
  el.hidden = false;
}
function hide() {
  if (el) el.hidden = true;
}

/** Run a battle request; returns the final response with `battle` (polling if it was pending). */
export async function decideBattle(request) {
  const timer = setTimeout(() => show("Battle being decided on Solana…"), 400);
  try {
    let r = await request();
    if (r?.pending) {
      show("Still deciding on Solana… the network is busy");
      for (let i = 0; i < 120; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const p = await api(`/api/battles/pending/${encodeURIComponent(r.pending)}`);
        if (p.status === "done") {
          r = p.response;
          break;
        }
        if (p.status === "failed") throw new Error(p.error || "The battle couldn't be decided. Nothing was applied.");
      }
      if (r?.pending) throw new Error("Solana is taking too long. Your battle will be applied when it lands; check back soon.");
    }
    return r;
  } finally {
    clearTimeout(timer);
    hide();
  }
}
