// The non-sports providers: headlines (GDELT), economic series (World Bank, or FRED with a key),
// asset prices (Gemini's public exchange candles), weather (Open-Meteo) and Gemini market odds.
// All are free public endpoints; none needs a key except the optional FRED one.
import { getJson } from "../http";

// ── Headlines: GDELT DOC 2.0 ──────────────────────────────────────────
/** Recent English headlines matching a query. Titles and dates only: no links or outlets are kept. */
export async function headlines(query: string, { days = 14, max = 6 } = {}) {
  const q = encodeURIComponent(`${query} sourcelang:english`);
  const j = await getJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=json&maxrecords=${max * 3}&timespan=${days}d&sort=datedesc`, { ttlMs: 30 * 60_000 });
  const seen = new Set<string>();
  const out: { title: string; date: string }[] = [];
  for (const a of j.articles ?? []) {
    const title = String(a.title ?? "").replace(/\s+/g, " ").trim();
    const key = title.toLowerCase().slice(0, 60);
    if (!title || seen.has(key)) continue;
    seen.add(key);
    const d = String(a.seendate ?? "");
    out.push({ title, date: d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : "" });
    if (out.length >= max) break;
  }
  return out;
}

// ── Economics ─────────────────────────────────────────────────────────
const WB: Record<string, { code: string; name: string; unit: string }> = {
  cpi: { code: "FP.CPI.TOTL.ZG", name: "US inflation, consumer prices (annual %)", unit: "%" },
  rates: { code: "FR.INR.LEND", name: "US bank prime lending rate (%)", unit: "%" },
  unemployment: { code: "SL.UEM.TOTL.ZS", name: "US unemployment rate (%)", unit: "%" },
  jobs: { code: "SL.UEM.TOTL.ZS", name: "US unemployment rate (%)", unit: "%" },
  gdp: { code: "NY.GDP.MKTP.KD.ZG", name: "US real GDP growth (annual %)", unit: "%" },
};
const FRED: Record<string, { id: string; name: string; unit: string; transform?: "yoy" }> = {
  cpi: { id: "CPIAUCSL", name: "US CPI, year over year (%)", unit: "%", transform: "yoy" },
  rates: { id: "FEDFUNDS", name: "Effective federal funds rate (%)", unit: "%" },
  unemployment: { id: "UNRATE", name: "US unemployment rate (%)", unit: "%" },
  jobs: { id: "PAYEMS", name: "US nonfarm payrolls (thousands)", unit: "k" },
  gdp: { id: "A191RL1Q225SBEA", name: "US real GDP growth, quarterly annualised (%)", unit: "%" },
};

/** A history for an indicator: monthly from FRED when a key is set, otherwise annual from the World Bank. */
export async function indicatorSeries(indicator: string): Promise<{ name: string; unit: string; frequency: "monthly" | "quarterly" | "annual"; points: { label: string; value: number }[] }> {
  const key = process.env.FRED_API_KEY?.trim();
  if (key && FRED[indicator]) {
    const f = FRED[indicator];
    const j = await getJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${f.id}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=40`, { ttlMs: 6 * 3600_000 });
    let pts = (j.observations ?? []).map((o: any) => ({ label: o.date.slice(0, 7), value: Number(o.value) })).filter((p: any) => Number.isFinite(p.value)).reverse();
    if (f.transform === "yoy") pts = pts.slice(12).map((p: any, i: number) => ({ label: p.label, value: Math.round(((p.value / pts[i].value) * 100 - 100) * 100) / 100 }));
    return { name: f.name, unit: f.unit, frequency: f.id.startsWith("A191") ? "quarterly" : "monthly", points: pts.slice(-24) };
  }
  const w = WB[indicator];
  if (!w) throw new Error(`no series for ${indicator}`);
  const j = await getJson(`https://api.worldbank.org/v2/country/US/indicator/${w.code}?format=json&per_page=30`, { ttlMs: 24 * 3600_000 });
  const rows = Array.isArray(j) ? (j[1] ?? []) : [];
  const points = rows
    .filter((r: any) => r.value !== null)
    .map((r: any) => ({ label: String(r.date), value: Math.round(Number(r.value) * 100) / 100 }))
    .reverse()
    .slice(-15);
  return { name: w.name, unit: w.unit, frequency: "annual", points };
}

// ── Prices: Gemini exchange public candles ────────────────────────────
export type Candle = { t: number; o: number; h: number; l: number; c: number };
/** Oldest first. interval: 1day | 6hr | 1hr | 15m | 5m */
export async function candles(symbol: string, interval: "1day" | "6hr" | "1hr" | "15m" | "5m" = "1day"): Promise<Candle[]> {
  const ttl = interval === "1day" ? 30 * 60_000 : 60_000;
  const rows: any[] = await getJson(`https://api.gemini.com/v2/candles/${symbol.toLowerCase()}usd/${interval}`, { ttlMs: ttl });
  return rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] })).sort((a, b) => a.t - b.t);
}

// ── Weather: Open-Meteo ───────────────────────────────────────────────
export async function geocode(place: string) {
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=5&language=en`, { ttlMs: 7 * 24 * 3600_000 });
  const r = (j.results ?? []).sort((a: any, b: any) => (b.country_code === "US" ? 1 : 0) - (a.country_code === "US" ? 1 : 0) || (b.population ?? 0) - (a.population ?? 0))[0];
  return r ? { name: `${r.name}${r.admin1 ? `, ${r.admin1}` : ""}`, lat: r.latitude as number, lon: r.longitude as number } : null;
}
export async function dailyWeather(lat: number, lon: number) {
  const j = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,snowfall_sum&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto&past_days=10&forecast_days=14`,
    { ttlMs: 60 * 60_000 },
  );
  const d = j.daily ?? {};
  return (d.time ?? []).map((t: string, i: number) => ({ date: t, high: d.temperature_2m_max?.[i], low: d.temperature_2m_min?.[i], precip: d.precipitation_sum?.[i], precipChance: d.precipitation_probability_max?.[i], snow: d.snowfall_sum?.[i] })) as {
    date: string;
    high: number;
    low: number;
    precip: number;
    precipChance: number | null;
    snow: number;
  }[];
}
