// Odds over time, market movers and the town crier.
//
// Gemini's prediction-markets REST API gives current prices but no odds history, so the server
// records it: every open market's mid price is sampled on a timer and kept for 24 hours. That
// history drives the odds charts, the movers board, the town crier's headlines, and "hot" featured
// bounties that appear when a market moves sharply.
import fs from "node:fs";
import path from "node:path";
import { REALMS, realmForMarket } from "../shared/world.js";
import type { MarketSummary } from "../gemini/client";
import { env, networkDataDir } from "./config";
import { db, feed } from "./db";

const MOCK = env.geminiMode === "mock";
const num = (v: string | undefined, d: number) => (v && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export const ODDS = {
  sampleMs: num(process.env.ODDS_SAMPLE_SECONDS, MOCK ? 10 : 60) * 1000,
  keepMs: 24 * 3600_000,
  heartbeatMs: 5 * 60_000, // store a point at least this often even when the price hasn't moved
  maxMarkets: 400,
  // The town crier: the biggest mover over `crierWindowMs`, at most one headline every `crierEveryMs`.
  crierWindowMs: (MOCK ? 10 : 60) * 60_000,
  crierMinMoveBps: MOCK ? 800 : 400,
  crierEveryMs: (MOCK ? 1.5 : 5) * 60_000,
  crierMarketCooldownMs: 60 * 60_000,
  hotBountyEveryMs: (MOCK ? 5 : 20) * 60_000, // a big move can spawn a featured bounty this often
};

type Point = [number, number]; // [time ms, mid in bps]
type Meta = { question: string; eventTitle: string; category: string; realm: string; expiry: string | null; lastSeen: number; bidBps: number | null; askBps: number | null };
type Store = { lastSnapshot?: number; series: Record<string, Point[]>; meta: Record<string, Meta>; crier: { at: number; market: string; text: string; from: number; to: number }[]; announced: Record<string, number>; lastCrier: number; lastHot: number };

const file = path.join(networkDataDir, "odds.json");
const store: Store = load();
let dirty = false;
let lastSample = 0;
let lastSave = Date.now();

function load(): Store {
  const blank: Store = { series: {}, meta: {}, crier: [], announced: {}, lastCrier: 0, lastHot: 0 };
  try {
    if (fs.existsSync(file)) return { ...blank, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    /* a damaged history file just starts fresh */
  }
  return blank;
}

function save(force = false) {
  if (!dirty || (!force && Date.now() - lastSave < 60_000)) return;
  try {
    fs.mkdirSync(networkDataDir, { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(store));
    fs.renameSync(file + ".tmp", file);
    dirty = false;
    lastSave = Date.now();
  } catch (e) {
    console.warn("odds history save failed:", (e as Error).message);
  }
}

const questionOf = (m: MarketSummary) => {
  const label = (m.label ?? "").trim();
  if (!label || label.length < 14 || /^(yes|no)$/i.test(label)) return `${m.eventTitle}${label ? `: ${label}` : ""}`;
  return label;
};

/** Record one snapshot of every open market. Called from the game loop; samples on its own timer. */
export function recordSnapshot(markets: MarketSummary[], at = Date.now()) {
  store.lastSnapshot = at;
  for (const m of markets) {
    if (m.midBps === null) continue;
    const s = (store.series[m.market] ??= []);
    const last = s[s.length - 1];
    if (!last || last[1] !== m.midBps || at - last[0] >= ODDS.heartbeatMs) s.push([at, m.midBps]);
    store.meta[m.market] = {
      question: questionOf(m),
      eventTitle: m.eventTitle,
      category: m.category ?? "",
      realm: String(realmForMarket(m.category, `${m.eventTitle} ${m.label}`)),
      expiry: m.expiry,
      lastSeen: at,
      bidBps: m.bestBidBps,
      askBps: m.bestAskBps,
    };
  }
  // prune old points and markets we haven't seen for a day
  const cutoff = at - ODDS.keepMs;
  for (const [k, s] of Object.entries(store.series)) {
    let i = 0;
    while (i < s.length - 1 && s[i + 1][0] < cutoff) i++; // keep one point before the window, as its starting value
    if (i) s.splice(0, i);
    if ((store.meta[k]?.lastSeen ?? 0) < cutoff) (delete store.series[k], delete store.meta[k]);
  }
  const keys = Object.keys(store.series);
  if (keys.length > ODDS.maxMarkets) for (const k of keys.sort((a, b) => (store.meta[a]?.lastSeen ?? 0) - (store.meta[b]?.lastSeen ?? 0)).slice(0, keys.length - ODDS.maxMarkets)) (delete store.series[k], delete store.meta[k]);
  dirty = true;
}

/** Open in the latest snapshot (a market missing from it has closed or settled). */
const isOpenNow = (market: string) => !!store.lastSnapshot && (store.meta[market]?.lastSeen ?? 0) >= store.lastSnapshot;

/** The price `windowMs` ago (the last point at or before then; the first point if history is shorter). */
function valueAt(s: Point[], t: number) {
  let v = s[0]?.[1] ?? null;
  for (const p of s) {
    if (p[0] > t) break;
    v = p[1];
  }
  return v;
}

/** Step-sampled points for a chart: `n` buckets across the window, each the price at its end. */
function resample(s: Point[], from: number, to: number, n: number): Point[] {
  if (!s.length) return [];
  const out: Point[] = [];
  const start = Math.max(from, s[0][0]);
  if (to <= start) return [[to, s[s.length - 1][1]]];
  for (let i = 0; i <= n; i++) {
    const t = Math.round(start + ((to - start) * i) / n);
    out.push([t, valueAt(s, t)!]);
  }
  return out;
}

export const WINDOWS: Record<string, number> = { "15m": 15 * 60_000, "1h": 3600_000, "6h": 6 * 3600_000, "24h": 24 * 3600_000 };
export const windowMs = (w: unknown) => WINDOWS[String(w)] ?? WINDOWS["1h"];

export function marketInfo(market: string) {
  const m = store.meta[market];
  if (!m) return null;
  const realm = REALMS.find((r) => r.id === m.realm);
  return { market, question: m.question, eventTitle: m.eventTitle, category: m.category, realm: m.realm, realmName: realm?.name ?? "", expiry: m.expiry, bidBps: m.bidBps, askBps: m.askBps };
}

/** Full history for one market over a window, ready to chart. */
export function oddsSeries(market: string, window: number, points = 120) {
  const s = store.series[market] ?? [];
  const to = Date.now();
  const from = to - window;
  const now = s.length ? s[s.length - 1][1] : null;
  const start = s.length ? valueAt(s, from) : null;
  const inWindow = s.filter((p) => p[0] >= from).map((p) => p[1]);
  return {
    ...(marketInfo(market) ?? { market, question: market }),
    window,
    from,
    to,
    since: s[0]?.[0] ?? null, // when the server first saw this market
    nowBps: now,
    startBps: start,
    changeBps: now !== null && start !== null ? now - start : null,
    highBps: inWindow.length ? Math.max(...inWindow, start ?? 0) : now,
    lowBps: inWindow.length ? Math.min(...inWindow, start ?? 10000) : now,
    points: resample(s, from, to, points),
  };
}

/** Markets that moved the most over the window. */
export function movers(window: number, limit = 12, opts: { exclude?: Set<string> } = {}) {
  const to = Date.now();
  const out: ReturnType<typeof moverOf>[] = [];
  for (const [market, s] of Object.entries(store.series)) {
    if (opts.exclude?.has(market) || !s.length) continue;
    const meta = store.meta[market];
    if (!meta || !isOpenNow(market)) continue; // closed or gone
    out.push(moverOf(market, s, window, to));
  }
  return out.sort((a, b) => Math.abs(b.changeBps) - Math.abs(a.changeBps) || a.question.localeCompare(b.question)).slice(0, limit);
}

function moverOf(market: string, s: Point[], window: number, to: number) {
  const from = to - window;
  const start = valueAt(s, from) ?? s[0][1];
  const now = s[s.length - 1][1];
  const info = marketInfo(market)!;
  return { ...info, startBps: start, nowBps: now, changeBps: now - start, spark: resample(s, from, to, 32).map((p) => p[1]) };
}

/** The open-market list with current odds and a sparkline, for pickers (e.g. the Colosseum). */
export function marketList(window = WINDOWS["1h"], limit = 60) {
  const to = Date.now();
  return Object.entries(store.series)
    .filter(([m, s]) => s.length && isOpenNow(m))
    .map(([m, s]) => moverOf(m, s, window, to))
    .sort((a, b) => (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999"))
    .slice(0, limit);
}

export const crierLog = (limit = 12) => store.crier.slice(-limit).reverse();

type HotFn = (market: string, realm: string) => boolean;
let hotHook: HotFn = () => false;
/** Called by the crier when a market moves sharply: may spawn a featured "hot" bounty. */
export const onHotMarket = (fn: HotFn) => (hotHook = fn);

const signed = (bps: number) => `${bps > 0 ? "+" : "−"}${Math.abs(Math.round(bps / 100))}¢`;
const winLabel = (ms: number) => (ms >= 3600_000 ? `${Math.round(ms / 3600_000)} hour${ms >= 7200_000 ? "s" : ""}` : `${Math.round(ms / 60_000)} minutes`);

/** The town crier: announce the biggest fresh mover, rate-limited, never the same market twice an hour. */
export function crierTick(at = Date.now(), opts: { force?: boolean } = {}) {
  if (!opts.force && at - store.lastCrier < ODDS.crierEveryMs) return null;
  const candidates = movers(ODDS.crierWindowMs, 40).filter((m) => Math.abs(m.changeBps) >= (opts.force ? 100 : ODDS.crierMinMoveBps) && at - (store.announced[m.market] ?? 0) > ODDS.crierMarketCooldownMs);
  const top = candidates[0];
  if (!top) return null;
  const dir = top.changeBps > 0 ? "jumped" : "fell";
  const realm = top.realmName ? ` (${top.realmName})` : "";
  const text = `Town crier: odds on “${top.question}” ${dir} from ${Math.round(top.startBps / 100)}¢ to ${Math.round(top.nowBps / 100)}¢ (${signed(top.changeBps)}) in ${winLabel(ODDS.crierWindowMs)}${realm}`;
  store.lastCrier = at;
  store.announced[top.market] = at;
  store.crier.push({ at, market: top.market, text, from: top.startBps, to: top.nowBps });
  if (store.crier.length > 60) store.crier.splice(0, store.crier.length - 60);
  dirty = true;
  feed({ kind: "crier", text, market: top.market });
  // a sharp move stirs up the realm: a featured bounty may appear there (its question stays sealed)
  if (opts.force || at - store.lastHot >= ODDS.hotBountyEveryMs) {
    if (hotHook(top.market, top.realm)) {
      store.lastHot = at;
      feed({ kind: "spawn", text: `Markets are stirring in ${top.realmName || "the realm"}: a featured bounty has appeared` });
    }
  }
  return top;
}

/** Sample on the timer (and run the crier). `fetch` returns the current open markets. */
export async function oddsTick(fetchMarkets: () => Promise<MarketSummary[]>) {
  const at = Date.now();
  if (at - lastSample >= ODDS.sampleMs) {
    lastSample = at;
    try {
      recordSnapshot(await fetchMarkets(), at);
      crierTick(at);
    } catch (e) {
      console.error("odds sample:", (e as Error).message);
    }
  }
  save();
}

/** Dev/testing: take a sample right now. */
export async function sampleNow(fetchMarkets: () => Promise<MarketSummary[]>) {
  lastSample = Date.now();
  recordSnapshot(await fetchMarkets(), lastSample);
  save(true);
}

export const flushOdds = () => save(true);
void db;
