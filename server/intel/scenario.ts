// Works out exactly what a Gemini market is asking, so a report can be about that bet and not just
// its category. Uses Gemini's structured fields first (the league in the ticker, the participants,
// the contract's strike) and falls back to reading the title and label. Pure: no network calls.
import type { IntelCategory, Scenario } from "./types";

export type MarketEvent = {
  ticker?: string;
  title?: string;
  category?: string;
  expiryDate?: string | null;
  participants?: { name?: string; abbreviation?: string; side?: string }[];
  contracts?: MarketContract[];
};
export type MarketContract = {
  label?: string;
  instrumentSymbol: string;
  expiryDate?: string | null;
  strike?: { type?: string; value?: string | number } | null;
};

const CATEGORY: Record<string, IntelCategory> = { sports: "sports", crypto: "crypto", economics: "economics" };
export const categoryOf = (geminiCategory?: string): IntelCategory => CATEGORY[String(geminiCategory ?? "").toLowerCase()] ?? "general";

const LEAGUE_WORDS: [RegExp, string][] = [
  [/\bNBA\b/i, "NBA"],
  [/\bWNBA\b/i, "WNBA"],
  [/\bNFL\b|Super Bowl/i, "NFL"],
  [/\bMLB\b|World Series/i, "MLB"],
  [/\bNHL\b|Stanley Cup/i, "NHL"],
  [/Champions League/i, "UCL"],
  [/Premier League/i, "EPL"],
  [/\bMLS\b/i, "MLS"],
  [/college basketball|\bNCAAM\b|March Madness/i, "NCAAM"],
  [/college football|\bNCAAF\b/i, "NCAAF"],
];
const AWARDS = /\b(MVP|Most Valuable Player|Rookie of the Year|Defensive Player of the Year|Cy Young|Heisman|Ballon d'Or|Most Improved|Sixth Man|Coach of the Year|Golden Boot|Offensive Player of the Year)\b/i;
const COINS: [RegExp, string][] = [
  [/\bbitcoin\b|\bBTC\b/i, "BTC"],
  [/\bether(eum)?\b|\bETH\b/i, "ETH"],
  [/\bsolana\b|\bSOL\b/i, "SOL"],
  [/\bXRP\b|\bripple\b/i, "XRP"],
  [/\bdoge(coin)?\b/i, "DOGE"],
  [/\bHYPE\b|hyperliquid/i, "HYPE"],
];
const num = (s: string | number | undefined | null) => {
  if (s === undefined || s === null) return undefined;
  const n = Number(String(s).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
/** "Shai Gilgeous-Alexander wins MVP" → "Shai Gilgeous-Alexander". */
const stripWin = (label: string) => label.replace(/\s+(wins?|to win|will win)\b.*$/i, "").trim();
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function leagueOf(ticker: string, text: string) {
  const m = /^([A-Z]{2,8})-\d/.exec(ticker);
  if (m) return m[1];
  for (const [re, l] of LEAGUE_WORDS) if (re.test(text)) return l;
  return undefined;
}

/** "November 19, 2026" or "Nov 21" → YYYY-MM-DD, taking the year from the expiry when missing. */
function dateFrom(text: string, fallback: string | null) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i.exec(text);
  if (!m) return fallback ? fallback.slice(0, 10) : undefined;
  const month = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase())) + 1;
  const year = m[3] ? Number(m[3]) : fallback ? Number(fallback.slice(0, 4)) : new Date().getFullYear();
  return `${year}-${String(month).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

export function parseScenario(event: MarketEvent, contract: MarketContract): Scenario {
  const title = event.title ?? event.ticker ?? "";
  const label = contract.label ?? "";
  const ticker = event.ticker ?? "";
  const topic = event.category ?? "General";
  const category = categoryOf(event.category);
  const deadline = contract.expiryDate ?? event.expiryDate ?? null;
  const siblings = (event.contracts ?? []).filter((c) => c.instrumentSymbol !== contract.instrumentSymbol).map((c) => c.label ?? "");
  const strike = contract.strike ?? null;
  const strikeValue = num(strike?.value as any);
  const base = { category, topic, market: contract.instrumentSymbol, question: label || title, eventTitle: title, deadline, rivals: [] as string[] };
  const text = `${title} ${label}`;

  if (category === "sports") {
    const league = leagueOf(ticker, text);
    let teams = (event.participants ?? []).filter((t) => t.name).map((t) => ({ name: t.name!, abbreviation: t.abbreviation, side: t.side }));
    const vs = /^(.+?)\s+vs\.?\s+(.+?)(?::|$)/i.exec(title);
    if (!teams.length && vs) teams = [{ name: vs[1].trim(), abbreviation: undefined, side: undefined }, { name: vs[2].trim(), abbreviation: undefined, side: undefined }];
    // "Derrick Henry 1+ Touchdowns scored" / "Bryce Young 175+ Passing Yards"
    const prop = /^(.+?)\s+(\d+(?:\.\d+)?)\+\s+(.+?)(?:\s+(?:scored|recorded|made))?$/i.exec(label);
    if (prop && !/^more than/i.test(label)) {
      // "1+" means over 0.5: keep the half-point line Gemini's strike uses
      const threshold = strikeValue !== undefined && strike?.type === "over" ? strikeValue : Number(prop[2]) - 0.5;
      return { ...base, type: "player-line", subject: { name: prop[1].trim(), kind: "athlete" }, league, teams, stat: prop[3].trim().toLowerCase(), condition: { op: "over", value: threshold } };
    }
    const spread = /^(.+?)\s+wins?\s+by\s+more\s+than\s+([\d.]+)/i.exec(label);
    if (/point spread/i.test(title) || spread) {
      const who = spread?.[1].trim() ?? label;
      return { ...base, type: "game-spread", subject: { name: who, kind: "team" }, league, teams, condition: { op: "margin", value: strikeValue ?? num(spread?.[2]), unit: "points" } };
    }
    const total = /more than\s+([\d.]+)\s+points?/i.exec(label);
    if (/total points/i.test(title) || total) {
      const value = strikeValue ?? num(total?.[1]);
      return { ...base, type: "game-total", subject: { name: teams.map((t) => t.name).join(" vs ") || title, kind: "event" }, league, teams, condition: { op: "over", value, unit: "points" } };
    }
    if (AWARDS.test(text)) {
      return { ...base, type: "award-race", subject: { name: stripWin(label), kind: "athlete" }, league, rivals: siblings.map(stripWin).filter(Boolean).slice(0, 4) };
    }
    // a match ("Kansas vs Houston" → "Houston", or "Tie") or a title future ("Kansas City wins Super Bowl LXI")
    const who = /^tie$/i.test(label) ? "Tie" : stripWin(label);
    return { ...base, type: "game-outcome", subject: { name: who, kind: "team" }, league, teams: teams.length ? teams : [{ name: who, abbreviation: undefined, side: undefined }], condition: { op: "wins" }, rivals: siblings.map(stripWin).filter((x) => x && !/^tie$/i.test(x)).slice(0, 4) };
  }

  if (category === "crypto") {
    const fromTicker = /^([A-Z]{2,6}?)(?=\d)/.exec(ticker)?.[1];
    const symbol = fromTicker && COINS.some(([, s]) => s === fromTicker) ? fromTicker : COINS.find(([re]) => re.test(text))?.[1];
    if (/^(up|down)$/i.test(label)) {
      return { ...base, type: "price-direction", subject: { name: symbol ?? title, kind: "asset" }, symbol, condition: { op: /^up$/i.test(label) ? "above" : "below" } };
    }
    const money = /\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*(or\s+(above|below|higher|lower))?/i.exec(label) ?? /(above|below|over|under)\s+\$\s*([\d,]+(?:\.\d+)?)/i.exec(label);
    let value = strikeValue;
    let op: "above" | "below" = strike?.type === "below" ? "below" : "above";
    if (value === undefined && money) {
      if (/^(above|below|over|under)$/i.test(money[1])) {
        value = num(money[2]);
        op = /below|under/i.test(money[1]) ? "below" : "above";
      } else {
        value = (num(money[1]) ?? 0) * (money[2] ? 1000 : 1);
        if (/below|lower/i.test(money[4] ?? "")) op = "below";
      }
    }
    if (/\b(below|under)\b/i.test(label)) op = "below";
    if (value !== undefined) return { ...base, type: "price-threshold", subject: { name: symbol ?? title, kind: "asset" }, symbol, condition: { op, value, unit: "USD" } };
    return { ...base, type: "general", subject: { name: symbol ?? label ?? title, kind: "asset" }, symbol };
  }

  if (category === "economics") {
    const indicator = /\bCPI\b|inflation/i.test(text) ? "cpi" : /\bfed\b|rate|bps/i.test(text) ? "rates" : /payroll|jobs report|nonfarm/i.test(text) ? "jobs" : /unemploy/i.test(text) ? "unemployment" : /\bGDP\b/i.test(text) ? "gdp" : undefined;
    const m = /(above|below|at least|over|under|beats?|more than|less than)\s*\$?([\d.,]+)\s*(%|bps|k|basis points)?/i.exec(label);
    const op = m && /below|under|less/i.test(m[1]) ? "below" : "above";
    const unit = m?.[3]?.toLowerCase().startsWith("b") ? "bps" : m?.[3]?.toLowerCase() === "k" ? "k" : m?.[3] === "%" ? "%" : undefined;
    const names = { cpi: "US inflation (CPI)", rates: "US interest rates", jobs: "US jobs", unemployment: "US unemployment", gdp: "US GDP growth" } as const;
    if (indicator) return { ...base, type: "indicator-threshold", subject: { name: names[indicator], kind: "indicator" }, indicator, condition: m ? { op, value: num(m[2]), unit } : undefined };
    return { ...base, type: "general", subject: { name: label || title, kind: "entity" } };
  }

  if (/^weather$/i.test(topic)) {
    const place =
      /\bin\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*?)(?=\s+(?:on|before|by|at|this|next)\b|\?|,|$)/.exec(title)?.[1] ??
      /^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*?)\s+(?:high|low|temperature|rain|snow)/i.exec(title)?.[1];
    const date = dateFrom(title, deadline);
    const between = /(-?\d+)\s*°?\s*F?\s*(?:to|-|–)\s*(-?\d+)\s*°?\s*F/i.exec(label);
    const above = /(above|over|at least|below|under)\s+(-?\d+)\s*°?\s*F/i.exec(label);
    const stat = /snow/i.test(text) ? "snow" : /rain|precip/i.test(text) ? "rain" : /low/i.test(title) ? "low" : "high";
    const condition = between
      ? { op: "between" as const, value: Number(between[1]), value2: Number(between[2]), unit: "°F" }
      : above
        ? { op: /below|under/i.test(above[1]) ? ("below" as const) : ("above" as const), value: Number(above[2]), unit: "°F" }
        : strikeValue !== undefined
          ? { op: "above" as const, value: strikeValue, unit: "°F" }
          : undefined;
    if (place) return { ...base, type: "weather-threshold", subject: { name: place, kind: "place" }, place, date, stat, condition };
  }

  return { ...base, type: "general", subject: { name: label && label.length > 3 && !/^(yes|no)$/i.test(label) ? label : title, kind: "entity" } };
}
