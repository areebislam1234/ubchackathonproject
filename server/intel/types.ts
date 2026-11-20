// Shapes shared by the intelligence system: what a market is about (a scenario), and the sections a
// report is built from. Reports never store links or source names: only the data, whether it is
// live or sample data, and when it was fetched.

export type IntelCategory = "sports" | "crypto" | "economics" | "general";
export type IntelRarity = "common" | "rare" | "epic" | "legendary";

export type ScenarioType =
  | "award-race" // "Shai Gilgeous-Alexander wins MVP" (rivals = the other contracts)
  | "game-outcome" // "Houston" in "Kansas vs Houston"
  | "game-total" // "More than 231.5 points scored"
  | "game-spread" // "New York wins by more than 9.5 points"
  | "player-line" // "Derrick Henry 1+ Touchdowns scored"
  | "price-threshold" // "$61,200 or above" on "BTC price today at 10pm EST"
  | "price-direction" // "Up" on an interval price market
  | "indicator-threshold" // "November CPI comes in above 3.0%"
  | "weather-threshold" // "56°F to 57°F" on "Highest temperature in San Francisco on November 19"
  | "general"; // anything else: headlines about the subject

export type Scenario = {
  type: ScenarioType;
  category: IntelCategory;
  topic: string; // Gemini category, e.g. "Sports"
  market: string; // instrumentSymbol
  question: string; // the contract label as the player saw it
  eventTitle: string;
  subject: { name: string; kind: "athlete" | "team" | "asset" | "indicator" | "place" | "entity" | "event" };
  league?: string; // NBA, NFL, NCAAM, ...
  teams?: { name: string; abbreviation?: string; side?: string }[];
  stat?: string; // player-line: points, touchdowns, passing yards, ...
  condition?: { op: "above" | "below" | "between" | "wins" | "over" | "margin"; value?: number; value2?: number; unit?: string };
  deadline: string | null; // ISO
  rivals: string[];
  symbol?: string; // crypto ticker, e.g. BTC
  indicator?: "cpi" | "rates" | "jobs" | "unemployment" | "gdp";
  place?: string;
  date?: string; // weather: the day asked about (YYYY-MM-DD)
};

export type Section =
  | { kind: "facts"; heading: string; facts: { label: string; value: string; tone?: "good" | "bad" | "gold" }[] }
  | { kind: "table"; heading: string; columns: string[]; rows: (string | number)[][]; highlight?: number }
  | { kind: "series"; heading: string; unit?: string; points: { label: string; value: number }[]; threshold?: number }
  | { kind: "list"; heading: string; items: { title: string; meta?: string }[] }
  | { kind: "text"; heading: string; text: string };

/** A section plus where it came from (kept server-side only, for debugging). */
export type Sourced = { section: Section; live: boolean; fetchedAt: number; provider: string };

export type IntelReport = {
  id: string;
  rarity: IntelRarity;
  category: IntelCategory;
  topic: string;
  boss: string; // boss key it dropped from
  bossName: string;
  collectedAt: number;
  status: "compiling" | "ready";
  title: string;
  subject: string | null;
  market: { symbol: string; question: string; eventTitle: string; practice: boolean; why: "your-call" | "your-bounty" | "open-market" } | null; // practice: a mock Gemini market
  scenario: ScenarioType | null;
  live: boolean; // every section is live data
  partial: boolean; // some sections are sample data
  dataAsOf: number | null;
  sections: (Section & { live: boolean })[];
  _provider?: string[]; // which adapters filled it (debugging; never shown)
};
