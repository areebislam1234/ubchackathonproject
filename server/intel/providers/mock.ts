// Sample sections for when no live source can be reached (or INTEL=off). They are always flagged
// live: false, headed "Sample", and the report shows a SAMPLE DATA stamp. They describe what the
// report would contain rather than pretending to be real figures.
import type { Scenario, Sourced } from "../types";

const WHAT: Record<string, string> = {
  "award-race": "season averages for the contenders, recent games and team records",
  "player-line": "the player's recent games against the line, season averages and the opponent's defence",
  "game-outcome": "both teams' records, recent form and their meetings this season",
  "game-total": "both teams' scoring and how often their games went over the line",
  "game-spread": "both teams' average margins and how often they cover",
  "price-threshold": "the latest price against the strike, the recent price history and how often it has moved that far",
  "price-direction": "recent momentum and how often the price closed higher",
  "indicator-threshold": "the indicator's history against the market's line",
  "weather-threshold": "the forecast for that day against the range",
  general: "recent headlines about the subject",
};

export function sampleSections(s: Scenario | null, topic: string): Sourced[] {
  const now = Date.now();
  const what = s ? WHAT[s.type] : `recent ${topic.toLowerCase()} data`;
  const series = Array.from({ length: 8 }, (_, i) => ({ label: `#${i + 1}`, value: 40 + ((i * 37) % 23) }));
  return [
    {
      section: { kind: "text", heading: "Sample briefing", text: `Live data couldn't be reached when this report was decoded, so it holds sample figures only. A live copy would show ${what}${s ? ` for ${s.subject.name}` : ""}.` },
      live: false,
      fetchedAt: now,
      provider: "mock",
    },
    { section: { kind: "series", heading: "Sample series (not real data)", points: series }, live: false, fetchedAt: now, provider: "mock" },
  ];
}
