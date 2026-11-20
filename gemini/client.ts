// Gemini prediction-markets REST client (public market data).
// Docs: https://developer.gemini.com/prediction-markets/market-data
//
// Paths used (same on the real API and on gemini/mock-server.ts):
//   GET /v1/prediction-markets/events?status=active&category=&search=&limit=&offset=
//   GET /v1/prediction-markets/events/{eventTicker}
//   GET /v1/prediction-markets/events/recently-settled     (settled in the last 24h)
//
// Market key everywhere in this project = contract.instrumentSymbol, never built from a title.
import { geminiBaseUrl } from "../server/config";


export type GeminiPrices = {
  bestBid?: string | null;
  bestAsk?: string | null;
  lastTradePrice?: string | null;
  buy?: { yes?: string | null; no?: string | null };
  sell?: { yes?: string | null; no?: string | null };
};

export type GeminiContract = {
  id?: string | number;
  ticker?: string;
  label?: string;
  status?: string; // "active" | "settled" | ...
  marketState?: string; // "open" | "closed"
  instrumentSymbol: string;
  prices?: GeminiPrices;
  expiryDate?: string | null;
  resolutionSide?: "yes" | "no" | null;
  resolvedAt?: string | null;
};

export type GeminiEvent = {
  id?: string | number;
  ticker: string;
  title?: string;
  category?: string;
  status?: string;
  expiryDate?: string | null;
  resolvedAt?: string | null;
  contracts?: GeminiContract[];
};

/** Gemini returns prices as strings. Accepts dollars ("0.64") or cents ("64"); returns bps. */
export function priceToBps(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const dollars = n > 1.5 ? n / 100 : n;
  return Math.max(0, Math.min(10000, Math.round(dollars * 10000)));
}

export function contractPricesBps(c: GeminiContract) {
  const p = c.prices ?? {};
  const bid = priceToBps(p.bestBid ?? p.sell?.yes);
  const ask = priceToBps(p.bestAsk ?? p.buy?.yes);
  const last = priceToBps(p.lastTradePrice);
  const mid = bid !== null && ask !== null ? Math.round((bid + ask) / 2) : (last ?? bid ?? ask);
  return { midBps: mid, bestBidBps: bid, bestAskBps: ask, lastTradeBps: last };
}

export function isOpen(c: GeminiContract): boolean {
  const state = (c.marketState ?? "open").toLowerCase();
  const status = (c.status ?? "active").toLowerCase();
  return state === "open" && status === "active" && !c.resolutionSide;
}

export type MarketSummary = {
  market: string;
  eventTicker: string;
  eventTitle: string;
  label: string;
  category?: string;
  marketState: string;
  status: string;
  midBps: number | null;
  bestBidBps: number | null;
  bestAskBps: number | null;
  lastTradeBps: number | null;
  expiry: string | null;
  resolutionSide: "yes" | "no" | null;
};

export function summarize(e: GeminiEvent, c: GeminiContract): MarketSummary {
  return {
    market: c.instrumentSymbol,
    eventTicker: e.ticker,
    eventTitle: e.title ?? e.ticker,
    label: c.label ?? c.ticker ?? c.instrumentSymbol,
    category: e.category,
    marketState: c.marketState ?? "unknown",
    status: c.status ?? e.status ?? "unknown",
    ...contractPricesBps(c),
    expiry: c.expiryDate ?? e.expiryDate ?? null,
    resolutionSide: c.resolutionSide ?? null,
  };
}

function unwrapList(j: any): GeminiEvent[] {
  if (Array.isArray(j)) return j;
  return j?.data ?? j?.events ?? j?.results ?? [];
}

export class GeminiClient {
  private cache: { at: number; events: GeminiEvent[] } | null = null;

  constructor(readonly baseUrl: string = geminiBaseUrl) {}

  private async get(path: string, params?: Record<string, string | string[] | number | undefined>): Promise<any> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Gemini ${res.status} ${res.statusText} for ${url.pathname}${url.search}`);
    return res.json();
  }

  async listEvents(opts: { status?: string[]; category?: string; search?: string; limit?: number; offset?: number } = {}) {
    const j = await this.get("/v1/prediction-markets/events", {
      status: opts.status ?? ["active"],
      category: opts.category,
      search: opts.search,
      limit: opts.limit ?? 100,
      offset: opts.offset,
    });
    return unwrapList(j);
  }

  async getEvent(ticker: string): Promise<GeminiEvent> {
    const j = await this.get(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`);
    return j?.data && !Array.isArray(j.data) ? j.data : j;
  }

  async recentlySettled(limit = 100): Promise<GeminiEvent[]> {
    return unwrapList(await this.get("/v1/prediction-markets/events/recently-settled", { limit }));
  }

  /** Forget the cached event list (after a dev action changes the mock market). */
  clearCache() {
    this.cache = null;
  }

  /** Active events, cached for a few seconds so a burst of requests costs one API call. */
  async activeEvents(maxAgeMs = 5000): Promise<GeminiEvent[]> {
    if (this.cache && Date.now() - this.cache.at < maxAgeMs) return this.cache.events;
    const events = await this.listEvents({ status: ["active"] });
    this.cache = { at: Date.now(), events };
    return events;
  }

  /** Find the event + contract for a market (instrumentSymbol). */
  async findContract(market: string): Promise<{ event: GeminiEvent; contract: GeminiContract } | null> {
    for (const e of await this.activeEvents()) {
      const c = e.contracts?.find((c) => c.instrumentSymbol === market);
      if (c) return { event: e, contract: c };
    }
    // Fallback: fetch the event directly. "GEMI-FEDJAN26-DN25" -> event "FEDJAN26".
    const guess = market.split("-")[1];
    if (guess) {
      try {
        const e = await this.getEvent(guess);
        const c = e.contracts?.find((c) => c.instrumentSymbol === market);
        if (c) return { event: e, contract: c };
      } catch {
        /* not found */
      }
    }
    return null;
  }

  /** Winning side for a settled market, or null if it hasn't settled (or we can't see it). */
  async settlement(market: string): Promise<"yes" | "no" | null> {
    for (const e of await this.recentlySettled()) {
      const c = e.contracts?.find((c) => c.instrumentSymbol === market);
      if (c?.resolutionSide === "yes" || c?.resolutionSide === "no") return c.resolutionSide;
    }
    const found = await this.findContract(market);
    const side = found?.contract.resolutionSide;
    return side === "yes" || side === "no" ? side : null;
  }

  /** Flattened list of open markets. */
  async openMarkets(): Promise<MarketSummary[]> {
    const out: MarketSummary[] = [];
    for (const e of await this.activeEvents()) {
      for (const c of e.contracts ?? []) if (isOpen(c)) out.push(summarize(e, c));
    }
    return out;
  }
}
