// Which market a report should be about. In order: a market the player has an open call on, a
// bounty they fought in, then an open Gemini market in the boss's category. Markets sealed inside a
// bounty that hasn't revealed yet are never used, so intel can't leak a blind bounty's question.
import { gemini } from "../bounties";
import { db, type Bounty, type Player } from "../db";
import { categoryOf, parseScenario, type MarketContract, type MarketEvent } from "./scenario";
import type { IntelCategory } from "./types";

export type Pick = { event: MarketEvent; contract: MarketContract; why: "your-call" | "your-bounty" | "open-market"; bounty?: Bounty };

const matches = (cat: string | undefined, category: IntelCategory, topic: string) => (category === "general" ? String(cat ?? "").toLowerCase() === topic.toLowerCase() : categoryOf(cat) === category);

/** Every market (and its whole event) that is still sealed inside a live bounty. */
function sealed() {
  const markets = new Set<string>();
  const events = new Set<string>();
  for (const b of Object.values(db.data.bounties))
    if (b.status === "upcoming" || b.status === "active") {
      markets.add(b.market);
      if (b.eventTicker) events.add(b.eventTicker);
    }
  return { markets, events };
}

async function eventFor(b: Bounty): Promise<{ event: MarketEvent; contract: MarketContract }> {
  const found = await gemini.findContract(b.market).catch(() => null);
  if (found) return { event: found.event as MarketEvent, contract: found.contract as MarketContract };
  // settled or no longer listed: rebuild what we know from the bounty itself
  return { event: { ticker: b.eventTicker, title: b.eventTitle, category: b.category }, contract: { label: b.question, instrumentSymbol: b.market, expiryDate: b.expiry } };
}

export async function chooseMarket(p: Player, category: IntelCategory, topic: string, rnd: () => number): Promise<Pick | null> {
  const mine = Object.values(db.data.bounties).filter((b) => b.entries[p.id] && (b.status === "revealed" || b.status === "resolved") && matches(b.category, category, topic));
  const calls = mine.filter((b) => b.predictions[p.id] && b.status === "revealed").sort((a, b) => b.predictions[p.id].at - a.predictions[p.id].at);
  if (calls.length) return { ...(await eventFor(calls[0])), why: "your-call", bounty: calls[0] };
  const fought = mine.filter((b) => b.status === "revealed").sort((a, b) => (b.results?.finalizedAt ?? 0) - (a.results?.finalizedAt ?? 0));
  if (fought.length) return { ...(await eventFor(fought[0])), why: "your-bounty", bounty: fought[0] };

  const hidden = sealed();
  const events = (await gemini.activeEvents(15_000)).filter((e) => matches(e.category, category, topic) && !hidden.events.has(e.ticker));
  const options: { event: MarketEvent; contract: MarketContract; w: number }[] = [];
  for (const e of events)
    for (const c of e.contracts ?? []) {
      if (hidden.markets.has(c.instrumentSymbol) || c.resolutionSide) continue;
      if ((c.marketState ?? "open") !== "open") continue;
      // prefer markets we can say something specific about
      const type = parseScenario(e as MarketEvent, c as MarketContract).type;
      options.push({ event: e as MarketEvent, contract: c as MarketContract, w: type === "general" ? 1 : 3 });
    }
  if (!options.length) return null;
  let r = rnd() * options.reduce((s, o) => s + o.w, 0);
  const pick = options.find((o) => (r -= o.w) < 0) ?? options[options.length - 1];
  return { event: pick.event, contract: pick.contract, why: "open-market" };
}
