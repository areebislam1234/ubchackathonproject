// Mock Gemini prediction-markets API for local development and demos.
// Serves the same paths and field names as the real API, so GeminiClient only swaps its base URL.
// Prices drift every 2s. Markets settle only when you tell them to:
//   npm run settle -- <instrumentSymbol> yes|no      (or POST /mock/settle)
import express from "express";
import { env } from "../server/config";
import type { GeminiContract, GeminiEvent } from "./client";

type MockContract = GeminiContract & { _p: number }; // _p = true YES probability driving the walk
type MockEvent = Omit<GeminiEvent, "contracts"> & { contracts: MockContract[] };

const iso = (d: Date) => d.toISOString();
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86400_000));

function contract(eventTicker: string, suffix: string, label: string, p: number, expiry: string): MockContract {
  return {
    id: `${eventTicker}-${suffix}`,
    ticker: `${eventTicker}-${suffix}`,
    label,
    status: "active",
    marketState: "open",
    instrumentSymbol: `GEMI-${eventTicker}-${suffix}`,
    expiryDate: expiry,
    resolutionSide: null,
    resolvedAt: null,
    prices: {},
    _p: p,
  };
}

function event(ticker: string, title: string, category: string, days: number, cs: [string, string, number][]): MockEvent {
  const expiry = daysFromNow(days);
  return {
    id: ticker,
    ticker,
    title,
    category,
    status: "active",
    expiryDate: expiry,
    resolvedAt: null,
    contracts: cs.map(([s, l, p]) => contract(ticker, s, l, p, expiry)),
  };
}

const events = new Map<string, MockEvent>();
// Fictional markets shaped like Gemini's, spread across every realm of the world.
const POOL: [string, string, string, number, [string, string, number][]][] = [
  ["FEDDEC26", "Fed decision in December 2026", "Economics", 33, [["DN25", "Fed cuts at least 25 bps in December", 0.62], ["HOLD", "Fed holds rates in December", 0.35]]],
  ["CPINOV26", "November CPI year over year", "Economics", 26, [["ABV3", "November CPI comes in above 3.0%", 0.41]]],
  ["JOBSDEC26", "December payrolls", "Economics", 50, [["150K", "December payrolls beat 150k", 0.55]]],
  ["GDPQ426", "Q4 2026 GDP", "Economics", 70, [["2PCT", "Q4 GDP growth above 2%", 0.48]]],
  ["BTCDEC26", "Bitcoin price on Dec 31, 2026", "Crypto", 45, [["120K", "BTC above $120,000 on Dec 31", 0.38], ["100K", "BTC above $100,000 on Dec 31", 0.71]]],
  ["ETHDEC26", "Ether price on Dec 31, 2026", "Crypto", 45, [["5K", "ETH above $5,000 on Dec 31", 0.33]]],
  ["SOLDEC26", "Solana price on Dec 31, 2026", "Crypto", 45, [["300", "SOL above $300 on Dec 31", 0.27]]],
  ["AUSRN1121", "Rain in Austin on Nov 21", "Weather", 4, [["YES", "Measurable rain at Austin airport on Nov 21", 0.22]]],
  ["NYCSNOW26", "Snow in New York before Christmas", "Weather", 38, [["YES", "Measurable snow in Central Park before Dec 25", 0.44]]],
  ["CHIHI1130", "Chicago high on Nov 30", "Weather", 13, [["45F", "Chicago high above 45°F on Nov 30", 0.36]]],
  ["NBAMVP27", "2027 NBA MVP", "Sports", 200, [["SGA", "Shai Gilgeous-Alexander wins MVP", 0.29], ["JOKIC", "Nikola Jokić wins MVP", 0.26]]],
  ["SB61", "Super Bowl LXI winner", "Sports", 85, [["KC", "Kansas City wins Super Bowl LXI", 0.14]]],
  ["UCL27", "2027 Champions League winner", "Sports", 190, [["RMA", "Real Madrid win the Champions League", 0.18]]],
  ["WS27", "2027 World Series winner", "Sports", 330, [["LAD", "Dodgers win the 2027 World Series", 0.21]]],
  ["OILDEC26", "WTI crude on Dec 31", "Commodities", 45, [["80", "WTI above $80 on Dec 31", 0.31]]],
  ["GOLDDEC26", "Gold price on Dec 31", "Commodities", 45, [["4500", "Gold above $4,500/oz on Dec 31", 0.46]]],
  ["WHEATJAN27", "Wheat futures in January", "Commodities", 60, [["6USD", "Wheat futures above $6 on Jan 15", 0.39]]],
  ["SENBUD26", "Senate budget vote", "Politics", 45, [["PASS", "Senate passes the budget bill by Dec 31", 0.52]]],
  ["UKELEC27", "UK general election timing", "Politics", 220, [["H127", "UK general election called before July 2027", 0.12]]],
  ["SCOTUS26", "Supreme Court tariff ruling", "Politics", 75, [["JAN31", "Supreme Court rules on the tariff case by Jan 31", 0.58]]],
  ["GOTY26", "Game of the Year 2026", "Culture", 25, [["INDIE", "Game of the Year goes to an indie title", 0.24]]],
  ["OSCARS27", "Best Picture 2027", "Culture", 120, [["100M", "Best Picture winner grossed over $100M", 0.41]]],
  ["HOT100DEC", "Hot 100 in December", "Culture", 40, [["KPOP", "A K-pop song tops the Hot 100 in December", 0.17]]],
  ["AIMODEL26", "Frontier AI releases", "Culture", 44, [["LAUNCH", "A new frontier AI model launches before Jan 1", 0.66]]],
];
let relist = 0;
function addFromPool(k: number, suffix = "") {
  const [ticker, title, category, days, cs] = POOL[k % POOL.length];
  const jitter = (p: number) => Math.min(0.9, Math.max(0.08, p + (Math.random() - 0.5) * 0.12));
  const e = event(ticker + suffix, title, category, days, cs.map(([s, l, p]) => [s, l, suffix ? jitter(p) : p]));
  events.set(e.ticker, e);
}
POOL.forEach((_, k) => addFromPool(k));
// Keep the board full: when markets settle, list fresh ones so new bounties keep spawning.
setInterval(() => {
  const open = [...events.values()].reduce((n, e) => n + e.contracts.filter((c) => c.status === "active").length, 0);
  if (open < 22) addFromPool(relist, `R${++relist}`);
}, 15000);

// Random walk on the hidden probability, then quote a spread around it.
function tick() {
  for (const e of events.values()) {
    for (const c of e.contracts) {
      if (c.status !== "active") continue;
      c._p = Math.min(0.97, Math.max(0.03, c._p + (Math.random() - 0.5) * 0.02));
      const spread = 0.02 + Math.random() * 0.02;
      const bid = Math.max(0.01, c._p - spread / 2);
      const ask = Math.min(0.99, c._p + spread / 2);
      const last = c._p + (Math.random() - 0.5) * spread;
      c.prices = {
        bestBid: bid.toFixed(2),
        bestAsk: ask.toFixed(2),
        lastTradePrice: Math.min(0.99, Math.max(0.01, last)).toFixed(2),
        buy: { yes: ask.toFixed(2), no: (1 - bid).toFixed(2) },
        sell: { yes: bid.toFixed(2), no: (1 - ask).toFixed(2) },
      };
    }
  }
}
tick();
setInterval(tick, 2000);

const publicEvent = (e: MockEvent): GeminiEvent => ({
  ...e,
  contracts: e.contracts.map(({ _p, ...c }) => c),
});

const app = express();
app.use(express.json());

app.get("/v1/prediction-markets/events", (req, res) => {
  const statuses = ([] as string[]).concat((req.query.status as any) ?? ["active"]).map((s) => s.toLowerCase());
  const search = String(req.query.search ?? "").toLowerCase();
  const category = String(req.query.category ?? "").toLowerCase();
  const limit = Number(req.query.limit ?? 100);
  const offset = Number(req.query.offset ?? 0);
  const list = [...events.values()].filter(
    (e) =>
      statuses.includes((e.status ?? "").toLowerCase()) &&
      (!search || (e.title ?? "").toLowerCase().includes(search)) &&
      (!category || (e.category ?? "").toLowerCase() === category),
  );
  res.json({ data: list.slice(offset, offset + limit).map(publicEvent), pagination: { limit, offset, total: list.length } });
});

app.get("/v1/prediction-markets/events/recently-settled", (_req, res) => {
  const cutoff = Date.now() - 86400_000;
  const list = [...events.values()]
    .filter((e) => e.contracts.some((c) => c.resolvedAt && Date.parse(c.resolvedAt) > cutoff))
    .sort((a, b) => Date.parse(b.resolvedAt ?? "0") - Date.parse(a.resolvedAt ?? "0"));
  res.json({ data: list.map(publicEvent) });
});

app.get("/v1/prediction-markets/events/:ticker", (req, res) => {
  const e = events.get(req.params.ticker);
  if (!e) return void res.status(404).json({ result: "error", reason: "EventNotFound" });
  res.json(publicEvent(e));
});

app.get("/v1/prediction-markets/categories", (_req, res) => {
  res.json({ categories: [...new Set([...events.values()].map((e) => e.category))] });
});

// ── Mock-only controls ────────────────────────────────────────────────
app.post("/mock/settle", (req, res) => {
  const { market, side } = req.body ?? {};
  if (side !== "yes" && side !== "no") return void res.status(400).json({ error: 'side must be "yes" or "no"' });
  for (const e of events.values()) {
    const c = e.contracts.find((c) => c.instrumentSymbol === market);
    if (!c) continue;
    const now = iso(new Date());
    Object.assign(c, { status: "settled", marketState: "closed", resolutionSide: side, resolvedAt: now });
    if (e.contracts.every((x) => x.status === "settled")) Object.assign(e, { status: "settled", resolvedAt: now });
    console.log(`settled ${market} -> ${side}`);
    return void res.json({ ok: true, market, side });
  }
  res.status(404).json({ error: `unknown market ${market}` });
});

/** Create a new event, e.g. for tests: { ticker, title, category, contracts: [{ suffix, label, price }] } */
app.post("/mock/events", (req, res) => {
  const { ticker, title, category = "Test", days = 1, contracts = [] } = req.body ?? {};
  if (!ticker || events.has(ticker)) return void res.status(400).json({ error: "ticker missing or taken" });
  const e = event(
    ticker,
    title ?? ticker,
    category,
    days,
    contracts.map((c: any) => [c.suffix, c.label ?? c.suffix, Number(c.price ?? 0.5)]),
  );
  events.set(ticker, e);
  tick();
  res.json(publicEvent(e));
});

app.get("/health", (_req, res) => res.json({ ok: true, events: events.size }));

app.listen(env.mockGeminiPort, () => {
  console.log(`mock Gemini on http://127.0.0.1:${env.mockGeminiPort}  (${events.size} events)`);
});
