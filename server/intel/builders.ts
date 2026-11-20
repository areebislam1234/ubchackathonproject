// Turns a scenario into report sections, most useful first. Each scenario type has its own list of
// what matters for that bet (an MVP race needs the rivals' stats; a points total needs both teams'
// scoring; a price threshold needs the distance to the strike). A source that fails is skipped, never
// filled with invented numbers: sample data only ever comes from mock.ts, and is labelled.
import { categoryOf } from "./scenario";
import type { Scenario, Section, Sourced } from "./types";
import { LEAGUE_PATH, athleteGames, athleteNews, athleteProfile, athleteSeason, findAthlete, findTeam, teamGames, teamNews, teamSummary, type Athlete, type GameLine, type TeamGame } from "./providers/espn";
import { candles, dailyWeather, geocode, headlines, indicatorSeries } from "./providers/data";
import { epoch, fees, gameActivity, networkLabel, streamWindow, throughput } from "./providers/quicknode";
import { getJson } from "./http";

type Step = () => Promise<Sourced | Sourced[] | null>;
const live = (provider: string, section: Section): Sourced => ({ section, live: true, fetchedAt: Date.now(), provider });
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const day = (iso: string) => iso.slice(5, 10);
const money = (n: number) => (n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(3)}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const until = (iso: string | null) => {
  if (!iso) return "open-ended";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "closed";
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} min` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)} days`;
};
const firstNum = (v: string | undefined) => {
  const m = /-?\d+(\.\d+)?/.exec(v ?? "");
  return m ? Number(m[0]) : NaN;
};

/** Words that carry meaning, for a headline search. */
function keywords(text: string, n = 5) {
  const stop = new Set("the a an of in on by to at for will be is are than more less above below over under and or with this that who what when before after wins win price today tomorrow".split(" "));
  return text
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()) && !/^\d+$/.test(w) && !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(w))
    .slice(0, n)
    .join(" ");
}

function headlineStep(query: string, heading: string): Step {
  return async () => {
    const items = await headlines(query);
    if (!items.length) return null;
    return live("gdelt", { kind: "list", heading, items: items.map((h) => ({ title: h.title, meta: h.date })) });
  };
}

// ── Sports ────────────────────────────────────────────────────────────
const KEY_STAT = ["points", "passingYards", "rushingYards", "receivingYards", "goals", "hits"];
/** ESPN stat names that answer a market's stat words ("Touchdowns", "Passing Yards", "points"). */
function statKeys(stat: string, names: string[]) {
  const s = stat.toLowerCase();
  const has = (k: string) => names.includes(k);
  if (/touchdown/.test(s)) return s.includes("passing") ? ["passingTouchdowns"].filter(has) : ["rushingTouchdowns", "receivingTouchdowns"].filter(has);
  const table: [RegExp, string[]][] = [
    [/passing yards/, ["passingYards"]],
    [/rushing yards/, ["rushingYards"]],
    [/receiving yards/, ["receivingYards"]],
    [/reception/, ["receptions"]],
    [/rebound/, ["totalRebounds", "rebounds"]],
    [/assist/, ["assists"]],
    [/three|3-?pt|3-?pointer/, ["threePointFieldGoalsMade"]],
    [/point/, ["points"]],
    [/goal/, ["goals"]],
    [/shot/, ["shotsTotal", "shots"]],
    [/strikeout/, ["strikeouts"]],
    [/home run/, ["homeRuns"]],
    [/hit/, ["hits"]],
  ];
  for (const [re, keys] of table) if (re.test(s)) return keys.filter(has).slice(0, 1);
  return [];
}
const statOf = (g: GameLine, keys: string[]) => keys.reduce((sum, k) => sum + (Number.isFinite(firstNum(g.stats[k])) ? firstNum(g.stats[k]) : 0), 0);

async function resolveTeams(s: Scenario) {
  const path = s.league ? LEAGUE_PATH[s.league] : undefined;
  if (!path || !s.teams?.length) return { path, teams: [] as { want: string; id: string; name: string; abbreviation: string }[] };
  const found = await Promise.all(s.teams.map(async (t) => ({ t, team: await findTeam(path, t).catch(() => null) })));
  return { path, teams: found.filter((x) => x.team).map((x) => ({ want: x.t.name, id: x.team!.id, name: x.team!.name, abbreviation: x.team!.abbreviation })) };
}
const form = (games: TeamGame[], n = 5) => games.slice(0, n).map((g) => (g.won ? "W" : "L")).join("");

function sportsSteps(s: Scenario): Step[] {
  const path = s.league ? LEAGUE_PATH[s.league] : undefined;
  const steps: Step[] = [];

  if (s.type === "award-race") {
    let subject: Athlete | null = null;
    const getSubject = async () => (subject ??= await findAthlete(s.subject.name, s.league));
    steps.push(async () => {
      const names = [s.subject.name, ...s.rivals].slice(0, 5);
      const athletes = (await Promise.all(names.map((n) => findAthlete(n, s.league).catch(() => null)))).filter(Boolean) as Athlete[];
      if (!athletes.length) return null;
      const seasons = await Promise.all(athletes.map((a) => athleteSeason(a).catch(() => null)));
      const labels = seasons.find((x) => x?.labels.length)?.labels ?? [];
      const want = ["GP", "PTS", "REB", "AST", "FG%", "YDS", "TD", "G", "A", "AVG", "HR", "ERA"].filter((l) => labels.includes(l)).slice(0, 5);
      const cols = want.length ? want : labels.slice(0, 5);
      const rows = athletes.map((a, i) => [a.name, ...cols.map((c) => seasons[i]?.season?.[labels.indexOf(c)] ?? "–")]);
      return live("espn", { kind: "table", heading: `${s.eventTitle}: the contenders this season`, columns: ["Player", ...cols], rows, highlight: 0 });
    });
    steps.push(async () => {
      const a = await getSubject();
      if (!a) return null;
      const games = (await athleteGames(a)).slice(0, 6);
      if (!games.length) return null;
      const key = KEY_STAT.find((k) => k in games[0].stats) ?? Object.keys(games[0].stats)[0];
      return live("espn", { kind: "table", heading: `${a.name}: last ${games.length} games`, columns: ["Date", "Opponent", "Result", key.replace(/([A-Z])/g, " $1").toLowerCase()], rows: games.map((g) => [day(g.date), `${g.atVs} ${g.opponent}`, `${g.result} ${g.score}`, g.stats[key] ?? "–"]) });
    });
    steps.push(async () => {
      const names = [s.subject.name, ...s.rivals].slice(0, 4);
      const rows: string[][] = [];
      for (const n of names) {
        const a = await findAthlete(n, s.league).catch(() => null);
        const prof = a ? await athleteProfile(a).catch(() => null) : null;
        if (!a || !prof?.team) continue;
        const t = await teamSummary(a.path, prof.team.id).catch(() => null);
        if (t) rows.push([a.name, t.name, t.record ?? "–", t.standing ?? "–"]);
      }
      return rows.length ? live("espn", { kind: "table", heading: "Team success (voters weigh it)", columns: ["Player", "Team", "Record", "Standing"], rows, highlight: 0 }) : null;
    });
    steps.push(athleteNewsStep(s, getSubject));
    return steps;
  }

  if (s.type === "player-line") {
    let subject: Athlete | null = null;
    const getSubject = async () => (subject ??= await findAthlete(s.subject.name, s.league));
    const line = s.condition?.value ?? 0;
    steps.push(async () => {
      const a = await getSubject();
      if (!a) return null;
      const games = (await athleteGames(a)).slice(0, 8);
      if (!games.length) return null;
      const keys = statKeys(s.stat ?? "", Object.keys(games[0].stats));
      if (!keys.length) return null;
      const vals = games.map((g) => statOf(g, keys));
      const hits = vals.filter((v) => v > line).length;
      return [
        live("espn", {
          kind: "facts",
          heading: `${a.name}: ${s.stat} vs the line`,
          facts: [
            { label: "Line", value: `${Math.floor(line) + 1}+ ${s.stat}` },
            { label: `Cleared in last ${vals.length}`, value: `${hits} of ${vals.length}`, tone: hits / vals.length >= 0.5 ? "good" : "bad" },
            { label: "Average", value: String(r1(avg(vals))) },
            { label: "Best / worst", value: `${Math.max(...vals)} / ${Math.min(...vals)}` },
          ],
        }),
        live("espn", { kind: "table", heading: "Game by game", columns: ["Date", "Opponent", "Result", s.stat ?? "stat", "Over?"], rows: games.map((g, i) => [day(g.date), `${g.atVs} ${g.opponent}`, `${g.result} ${g.score}`, vals[i], vals[i] > line ? "✓" : "✗"]) }),
      ];
    });
    steps.push(async () => {
      const a = await getSubject();
      if (!a) return null;
      const se = await athleteSeason(a);
      if (!se.season) return null;
      return live("espn", { kind: "facts", heading: `${a.name}: season averages`, facts: se.labels.slice(0, 8).map((l, i) => ({ label: l, value: se.season![i] ?? "–" })) });
    });
    steps.push(async () => {
      const a = await getSubject();
      if (!a || !path) return null;
      const prof = await athleteProfile(a);
      const { teams } = await resolveTeams(s);
      const opp = teams.find((t) => t.id !== prof.team?.id);
      if (!opp) return null;
      const games = (await teamGames(path, opp.id)).slice(0, 10);
      const sum = await teamSummary(path, opp.id);
      return live("espn", { kind: "facts", heading: `Tonight's opponent: ${opp.name}`, facts: [{ label: "Record", value: sum.record ?? "–" }, { label: "Allowed per game (last 10)", value: String(r1(avg(games.map((g) => g.pa)))) }, { label: "Form", value: form(games) || "–" }] });
    });
    steps.push(athleteNewsStep(s, getSubject));
    return steps;
  }

  // team markets: match result, points total, point spread, title futures
  let resolved: Awaited<ReturnType<typeof resolveTeams>> | null = null;
  const teamsOf = async () => (resolved ??= await resolveTeams(s));
  const gamesOf = new Map<string, Promise<TeamGame[]>>();
  const games = (p: string, id: string) => (gamesOf.has(id) ? gamesOf.get(id)! : (gamesOf.set(id, teamGames(p, id)), gamesOf.get(id)!));

  if (s.type === "game-total") {
    const line = s.condition?.value ?? 0;
    steps.push(async () => {
      const { path: p, teams } = await teamsOf();
      if (!p || teams.length < 2) return null;
      const [a, b] = await Promise.all(teams.slice(0, 2).map((t) => games(p, t.id).then((g) => g.slice(0, 10))));
      if (!a.length || !b.length) return null;
      const est = (avg(a.map((g) => g.pf)) + avg(b.map((g) => g.pa))) / 2 + (avg(b.map((g) => g.pf)) + avg(a.map((g) => g.pa))) / 2;
      return live("espn", {
        kind: "facts",
        heading: `Points total: line ${line}`,
        facts: [
          { label: `${teams[0].abbreviation} scores / allows`, value: `${r1(avg(a.map((g) => g.pf)))} / ${r1(avg(a.map((g) => g.pa)))}` },
          { label: `${teams[1].abbreviation} scores / allows`, value: `${r1(avg(b.map((g) => g.pf)))} / ${r1(avg(b.map((g) => g.pa)))}` },
          { label: "Average-based estimate", value: `${r1(est)} (${est > line ? "over" : "under"} the line)`, tone: est > line ? "good" : "bad" },
        ],
      });
    });
    steps.push(async () => {
      const { path: p, teams } = await teamsOf();
      if (!p || teams.length < 2) return null;
      const rows = await Promise.all(
        teams.slice(0, 2).map(async (t) => {
          const g = (await games(p, t.id)).slice(0, 10);
          const totals = g.map((x) => x.pf + x.pa);
          return [t.name, `${totals.filter((x) => x > line).length} of ${totals.length}`, r1(avg(totals)), Math.max(...totals), Math.min(...totals)];
        }),
      );
      return live("espn", { kind: "table", heading: `How often their games went over ${line} (last 10)`, columns: ["Team", "Over the line", "Avg total", "High", "Low"], rows });
    });
    steps.push(async () => {
      const { path: p, teams } = await teamsOf();
      if (!p || !teams.length) return null;
      const g = (await games(p, teams[0].id)).slice(0, 10).reverse();
      return live("espn", { kind: "series", heading: `${teams[0].name}: combined points in recent games`, unit: "pts", points: g.map((x) => ({ label: `${day(x.date)} ${x.opponent}`, value: x.pf + x.pa })), threshold: line });
    });
  } else if (s.type === "game-spread") {
    const margin = s.condition?.value ?? 0;
    steps.push(async () => {
      const { path: p, teams } = await teamsOf();
      if (!p || !teams.length) return null;
      const subj = teams.find((t) => t.name.toLowerCase().includes(s.subject.name.toLowerCase()) || s.subject.name.toLowerCase().includes(t.name.split(" ")[0].toLowerCase())) ?? teams[0];
      const other = teams.find((t) => t.id !== subj.id);
      const g = (await games(p, subj.id)).slice(0, 10);
      const margins = g.map((x) => x.pf - x.pa);
      const facts = [
        { label: "Spread", value: `${subj.abbreviation} by more than ${margin}` },
        { label: `${subj.abbreviation} avg margin (last 10)`, value: `${r1(avg(margins)) > 0 ? "+" : ""}${r1(avg(margins))}` },
        { label: `Won by ${margin}+`, value: `${margins.filter((m) => m > margin).length} of ${margins.length}`, tone: margins.filter((m) => m > margin).length / Math.max(1, margins.length) >= 0.5 ? ("good" as const) : ("bad" as const) },
      ];
      if (other) {
        const og = (await games(p, other.id)).slice(0, 10);
        facts.push({ label: `${other.abbreviation} avg margin (last 10)`, value: `${r1(avg(og.map((x) => x.pf - x.pa)))}` });
      }
      return live("espn", { kind: "facts", heading: `Point spread: ${subj.name}`, facts });
    });
  }
  // shared by match, spread and futures markets: records, form and the head-to-head
  steps.push(async () => {
    const { path: p, teams } = await teamsOf();
    if (!p || !teams.length) return null;
    const rows = await Promise.all(
      teams.slice(0, 2).map(async (t) => {
        const [sum, g] = await Promise.all([teamSummary(p, t.id), games(p, t.id)]);
        const last = g.slice(0, 10);
        return [t.name, sum.record ?? "–", sum.home ?? "–", sum.road ?? "–", form(g) || "–", r1(avg(last.map((x) => x.pf))), r1(avg(last.map((x) => x.pa))), sum.standing ?? "–"];
      }),
    );
    const subjectRow = rows.findIndex((r) => String(r[0]).toLowerCase().includes(s.subject.name.toLowerCase()));
    return live("espn", { kind: "table", heading: teams.length > 1 ? "Head to head: the two teams" : `${teams[0].name} this season`, columns: ["Team", "Record", "Home", "Road", "Last 5", "Scored", "Allowed", "Standing"], rows, highlight: subjectRow >= 0 ? subjectRow : undefined });
  });
  steps.push(async () => {
    const { path: p, teams } = await teamsOf();
    if (!p || teams.length < 2) return null;
    const g = (await games(p, teams[0].id)).filter((x) => x.opponent === teams[1].abbreviation || x.opponentName === teams[1].name);
    if (!g.length) return live("espn", { kind: "text", heading: "Meetings this season", text: `${teams[0].name} and ${teams[1].name} haven't played each other yet this season.` });
    return live("espn", { kind: "table", heading: "Meetings this season", columns: ["Date", "Where", "Score", "Winner"], rows: g.map((x) => [day(x.date), x.home ? teams[0].abbreviation : teams[1].abbreviation, `${x.pf}-${x.pa}`, x.won ? teams[0].name : teams[1].name]) });
  });
  steps.push(async () => {
    const { path: p, teams } = await teamsOf();
    if (p && teams.length) {
      // ESPN's team stories carry injury and lineup news, which matters most for a match
      const news = (await Promise.all(teams.slice(0, 2).map((t) => teamNews(p, t.id).catch(() => [])))).flat();
      news.sort((a, b) => (a.date < b.date ? 1 : -1));
      if (news.length) return live("espn", { kind: "list", heading: "Team news (injuries, lineups, form)", items: news.slice(0, 6).map((h) => ({ title: h.title, meta: h.date })) });
    }
    const names = teams.length ? teams.map((t) => `"${t.name}"`) : [`"${s.subject.name}"`];
    const items = await headlines(names.length > 1 ? `(${names.join(" OR ")})` : names[0]);
    return items.length ? live("gdelt", { kind: "list", heading: "Latest news", items: items.map((h) => ({ title: h.title, meta: h.date })) }) : null;
  });
  return steps;
}

function athleteNewsStep(s: Scenario, getSubject: () => Promise<Athlete | null>): Step {
  return async () => {
    const a = await getSubject().catch(() => null);
    const news = a ? await athleteNews(a).catch(() => []) : [];
    if (news.length) return live("espn", { kind: "list", heading: `Latest on ${a!.name}`, items: news.slice(0, 6).map((h) => ({ title: h.title, meta: h.date })) });
    return headlineStep(`"${s.subject.name}"`, `Latest on ${s.subject.name}`)();
  };
}

// ── Crypto ────────────────────────────────────────────────────────────
function cryptoSteps(s: Scenario): Step[] {
  const sym = s.symbol;
  const steps: Step[] = [];
  if (sym && s.type === "price-threshold" && s.condition?.value) {
    const strike = s.condition.value;
    const above = s.condition.op !== "below";
    const msLeft = s.deadline ? new Date(s.deadline).getTime() - Date.now() : 7 * 86400_000;
    const short = msLeft < 3 * 86400_000;
    steps.push(async () => {
      const hourly = await candles(sym, "1hr");
      const last = hourly[hourly.length - 1];
      const dist = (strike - last.c) / last.c;
      const needed = above ? Math.max(0, dist) : Math.max(0, -dist);
      return live("gemini-exchange", {
        kind: "facts",
        heading: `${sym}: where it stands against ${money(strike)}`,
        facts: [
          { label: "Latest price", value: money(last.c) },
          { label: "Strike", value: `${money(strike)} or ${above ? "above" : "below"}` },
          { label: needed ? "Move needed" : "Already past it by", value: needed ? `${above ? "+" : "−"}${(needed * 100).toFixed(2)}%` : `${(Math.abs(dist) * 100).toFixed(2)}%`, tone: needed ? "bad" : "good" },
          { label: "Time left", value: until(s.deadline) },
          { label: "24h change", value: `${(((last.c - hourly[Math.max(0, hourly.length - 25)].c) / hourly[Math.max(0, hourly.length - 25)].c) * 100).toFixed(2)}%` },
        ],
      });
    });
    steps.push(async () => {
      const cs = short ? (await candles(sym, "1hr")).slice(-48) : (await candles(sym, "1day")).slice(-30);
      return live("gemini-exchange", { kind: "series", heading: short ? `${sym}: last 48 hours` : `${sym}: last 30 days`, unit: "USD", points: cs.map((c) => ({ label: new Date(c.t).toISOString().slice(short ? 11 : 5, short ? 16 : 10), value: r2(c.c) })), threshold: strike });
    });
    steps.push(async () => {
      // how often has the price made the required move in a window this long?
      const hourly = await candles(sym, "1hr");
      const last = hourly[hourly.length - 1].c;
      const need = (strike - last) / last;
      const w = Math.max(1, Math.round(Math.min(msLeft, 30 * 86400_000) / 3600_000));
      const series = w > 48 ? await candles(sym, "1day") : hourly;
      const step = w > 48 ? Math.max(1, Math.round(w / 24)) : w;
      let hit = 0;
      let n = 0;
      for (let i = 0; i + step < series.length; i++) {
        const ch = (series[i + step].c - series[i].c) / series[i].c;
        n++;
        if (above ? ch >= need : ch <= need) hit++;
      }
      if (n < 10) return null;
      return live("gemini-exchange", { kind: "text", heading: "Has it moved this much before?", text: `Over recent history, ${sym} ended ${above ? "at least" : "at most"} ${(need * 100).toFixed(2)}% ${need >= 0 ? "higher" : "lower"} after ${w > 48 ? `${step} days` : `${w} hours`} in ${pct(hit / n)} of ${n} windows. That's a base rate, not a forecast.` });
    });
  } else if (sym && s.type === "price-direction") {
    steps.push(async () => {
      const h = await candles(sym, "1hr");
      const m5 = await candles(sym, "5m").catch(() => []);
      const last = (m5.length ? m5 : h)[(m5.length ? m5 : h).length - 1];
      const ago = (n: number) => h[Math.max(0, h.length - 1 - n)].c;
      return live("gemini-exchange", { kind: "facts", heading: `${sym}: momentum`, facts: [{ label: "Latest price", value: money(last.c) }, { label: "1h change", value: `${(((last.c - ago(1)) / ago(1)) * 100).toFixed(2)}%` }, { label: "24h change", value: `${(((last.c - ago(24)) / ago(24)) * 100).toFixed(2)}%` }, { label: "Closes at", value: s.deadline ? new Date(s.deadline).toISOString().slice(11, 16) + " UTC" : "–" }] });
    });
    steps.push(async () => {
      const m5 = (await candles(sym, "5m")).slice(-96);
      const ups = m5.filter((c) => c.c >= c.o).length;
      return live("gemini-exchange", { kind: "text", heading: "Up or down, recently", text: `In the last ${m5.length} five-minute candles, ${sym} closed higher than it opened ${ups} times (${pct(ups / Math.max(1, m5.length))}).` });
    });
    steps.push(async () => {
      const h = (await candles(sym, "1hr")).slice(-24);
      return live("gemini-exchange", { kind: "series", heading: `${sym}: last 24 hours`, unit: "USD", points: h.map((c) => ({ label: new Date(c.t).toISOString().slice(11, 16), value: r2(c.c) })) });
    });
  }
  if (!sym || sym === "SOL") steps.push(...networkSteps());
  if (sym) steps.push(headlineStep(`"${{ BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "XRP", DOGE: "dogecoin", HYPE: "hyperliquid" }[sym] ?? sym}"`, `Latest on ${sym}`));
  return steps;
}

/** Solana network intelligence, from the QuickNode Stream and RPC. */
export function networkSteps(): Step[] {
  return [
    async () => {
      const [tp, ep] = await Promise.all([throughput(), epoch()]);
      if (!tp.length) return null;
      const now = tp[tp.length - 1];
      return [
        live("quicknode", {
          kind: "facts",
          heading: `Solana network right now (${networkLabel()})`,
          facts: [
            { label: "Throughput", value: `${now.tps.toLocaleString("en-US")} tx/s` },
            ...(now.nonVoteTps !== null ? [{ label: "Non-vote", value: `${now.nonVoteTps.toLocaleString("en-US")} tx/s` }] : []),
            { label: "30-min average", value: `${Math.round(avg(tp.map((x) => x.tps))).toLocaleString("en-US")} tx/s` },
            { label: "Epoch", value: `${ep.epoch} (${pct(ep.progress)} done)` },
          ],
        }),
        live("quicknode", { kind: "series", heading: "Transactions per second, last 30 minutes", unit: "tx/s", points: tp.map((x) => ({ label: String(x.slot), value: x.tps })) }),
      ];
    },
    async () => {
      const w = streamWindow();
      if (!w) return null;
      const facts = [
        { label: "Blocks sampled", value: `${w.blocks} (slots ${w.from}–${w.to})` },
        { label: "Avg transactions / block", value: String(w.avgTx) },
        { label: "Failed", value: pct(w.failRate), tone: w.failRate > 0.2 ? ("bad" as const) : undefined },
        { label: "Vote share", value: pct(w.voteShare) },
      ];
      for (const [mint, t] of Object.entries(w.transfers)) facts.push({ label: `Watched token ${mint.slice(0, 4)}… transfers`, value: `${t.count} (${r2(t.amount)} tokens)` });
      return [
        live("quicknode-stream", { kind: "facts", heading: "Activity in sampled blocks (QuickNode Stream)", facts }),
        ...(w.topPrograms.length ? [live("quicknode-stream", { kind: "table" as const, heading: "Busiest programs (non-vote)", columns: ["Program", "Calls"], rows: w.topPrograms.map((p) => [p.name, p.calls]) })] : []),
      ];
    },
    async () => {
      const f = await fees();
      if (!f) return null;
      return live("quicknode", { kind: "facts", heading: "Fee pressure", facts: [{ label: "Median priority fee", value: `${f.median} µ-lamports/CU` }, { label: "90th percentile", value: `${f.p90} µ-lamports/CU` }, { label: "Slots paying priority", value: pct(f.nonzero) }] });
    },
    async () => {
      const g = gameActivity();
      return live("quicknode-stream", { kind: "facts", heading: "StakeClash on-chain (verified by the Stream)", facts: [{ label: "Game transactions, 24h", value: String(g.day) }, { label: "Badges confirmed, 24h", value: String(g.badges) }, { label: "Standings sealed, 24h", value: String(g.seals) }, { label: "Stream deliveries", value: String(g.deliveries) }] });
    },
  ];
}

// ── Economics ─────────────────────────────────────────────────────────
function economicsSteps(s: Scenario): Step[] {
  const ind = s.indicator ?? "cpi";
  const steps: Step[] = [];
  const target = s.condition?.value;
  // "cuts at least 25 bps" is a change in the rate; most others are a level
  const isChange = ind === "rates" && s.condition?.unit === "bps";
  steps.push(async () => {
    const ser = await indicatorSeries(ind);
    if (!ser.points.length) return null;
    const last = ser.points[ser.points.length - 1];
    const prev = ser.points[ser.points.length - 2];
    const facts = [
      { label: `Latest (${last.label})`, value: `${last.value}${ser.unit === "%" ? "%" : ser.unit === "k" ? "k" : ""}` },
      ...(prev ? [{ label: `Previous (${prev.label})`, value: `${prev.value}${ser.unit === "%" ? "%" : ""}` }] : []),
    ];
    if (target !== undefined && !isChange && ser.unit === "%") facts.push({ label: "The market's line", value: `${s.condition?.op === "below" ? "below" : "above"} ${target}%`, tone: (s.condition?.op === "below" ? last.value < target : last.value > target) ? ("good" as const) : ("bad" as const) } as any);
    if (isChange) facts.push({ label: "The market asks for", value: `a move of ${target} bps` } as any);
    return live(process.env.FRED_API_KEY ? "fred" : "worldbank", { kind: "facts", heading: `${ser.name}${ser.frequency === "annual" ? " (annual data)" : ""}`, facts });
  });
  steps.push(async () => {
    const ser = await indicatorSeries(ind);
    return live(process.env.FRED_API_KEY ? "fred" : "worldbank", { kind: "series", heading: `${ser.name}: history`, unit: ser.unit, points: ser.points, threshold: target !== undefined && !isChange && ser.unit === "%" ? target : undefined });
  });
  steps.push(async () => {
    const ser = await indicatorSeries(ind);
    const ch = ser.points.slice(1).map((p, i) => p.value - ser.points[i].value);
    if (ch.length < 4) return null;
    const need = isChange && target ? -target / 100 : target !== undefined ? target - ser.points[ser.points.length - 1].value : null;
    const per = ser.frequency === "annual" ? "year" : ser.frequency === "quarterly" ? "quarter" : "month";
    const big = need !== null ? ch.filter((c) => (need < 0 ? c <= need : c >= need)).length : 0;
    return live(process.env.FRED_API_KEY ? "fred" : "worldbank", {
      kind: "text",
      heading: "How fast does it move?",
      text: `Across the last ${ch.length} ${per}s the average change was ${r2(avg(ch.map(Math.abs)))} points.${need !== null ? ` A move of ${need >= 0 ? "+" : ""}${r2(need)} or more happened in ${big} of them.` : ""}${ser.frequency === "annual" ? " This is yearly data; add a FRED key for monthly figures." : ""}`,
    });
  });
  steps.push(headlineStep({ cpi: '"inflation" CPI', rates: '"Federal Reserve" rates', jobs: '"jobs report" payrolls', unemployment: '"unemployment rate"', gdp: '"GDP" economy' }[ind], "Latest economic news"));
  return steps;
}

// ── Weather ───────────────────────────────────────────────────────────
function weatherSteps(s: Scenario): Step[] {
  const steps: Step[] = [];
  const c = s.condition;
  const describe = () => (!c ? s.question : c.op === "between" ? `${c.value}–${c.value2}°F` : `${c.op} ${c.value}°F`);
  let cache: Promise<{ where: string; days: Awaited<ReturnType<typeof dailyWeather>> } | null> | null = null;
  const get = () =>
    (cache ??= (async () => {
      const g = await geocode(s.place!);
      return g ? { where: g.name, days: await dailyWeather(g.lat, g.lon) } : null;
    })());
  const pick = (d: { high: number; low: number }) => (s.stat === "low" ? d.low : d.high);
  steps.push(async () => {
    const w = await get();
    if (!w) return null;
    const d = w.days.find((x) => x.date === s.date);
    if (!d) return live("open-meteo", { kind: "text", heading: `${w.where} on ${s.date}`, text: `That date is outside the forecast window right now; forecasts reach about two weeks ahead.` });
    const past = s.date! < new Date().toISOString().slice(0, 10);
    const facts: { label: string; value: string; tone?: "good" | "bad" | "gold" }[] = [
      { label: past ? "Recorded high" : "Forecast high", value: `${r1(d.high)}°F` },
      { label: past ? "Recorded low" : "Forecast low", value: `${r1(d.low)}°F` },
    ];
    if (s.stat === "rain" || s.stat === "snow") {
      facts.push({ label: past ? "Precipitation" : "Chance of precipitation", value: past ? `${d.precip} in` : `${d.precipChance ?? "–"}%` });
      if (s.stat === "snow") facts.push({ label: "Snowfall", value: `${d.snow} cm` });
    } else if (c?.value !== undefined) {
      const v = pick(d);
      const inside = c.op === "between" ? v >= c.value && v <= (c.value2 ?? c.value) + 0.99 : c.op === "below" ? v < c.value : v > c.value;
      facts.push({ label: "Your range", value: describe() }, { label: "Forecast lands", value: inside ? "inside it" : "outside it", tone: inside ? "good" : "bad" });
    }
    return live("open-meteo", { kind: "facts", heading: `${w.where}, ${s.date}`, facts });
  });
  steps.push(async () => {
    const w = await get();
    if (!w) return null;
    const today = new Date().toISOString().slice(0, 10);
    const pts = w.days.filter((d) => d.date <= (s.date && s.date > today ? s.date : today)).slice(-14);
    return live("open-meteo", { kind: "series", heading: `${w.where}: daily ${s.stat === "low" ? "lows" : "highs"} (recorded, then forecast)`, unit: "°F", points: pts.map((d) => ({ label: d.date.slice(5), value: r1(pick(d)) })), threshold: c?.value });
  });
  steps.push(async () => {
    const w = await get();
    if (!w) return null;
    const today = new Date().toISOString().slice(0, 10);
    const next = w.days.filter((d) => d.date >= today).slice(0, 7);
    return live("open-meteo", { kind: "table", heading: "Next 7 days", columns: ["Day", "High", "Low", "Rain chance"], rows: next.map((d) => [d.date.slice(5), `${r1(d.high)}°`, `${r1(d.low)}°`, `${d.precipChance ?? "–"}%`]) });
  });
  steps.push(headlineStep(`"${s.place}" weather`, `Weather news for ${s.place}`));
  return steps;
}

// ── General ───────────────────────────────────────────────────────────
function generalSteps(s: Scenario): Step[] {
  const q = keywords(s.question) || keywords(s.eventTitle);
  return [headlineStep(q, `Latest on: ${s.question}`), headlineStep(keywords(s.eventTitle, 4) || s.topic, `Background: ${s.eventTitle}`)];
}

/** Every step for a scenario, most important first. */
export function stepsFor(s: Scenario): Step[] {
  if (s.type === "weather-threshold") return weatherSteps(s);
  if (s.category === "sports") return sportsSteps(s);
  if (s.category === "crypto") return cryptoSteps(s);
  if (s.category === "economics") return economicsSteps(s);
  return generalSteps(s);
}

/** A report about a whole category, for when no market fits (still live data, honestly titled). */
export function categorySteps(category: string, topic: string): { title: string; steps: Step[] } {
  if (category === "crypto") return { title: "Solana network report", steps: networkSteps() };
  if (category === "economics")
    return {
      title: "US economy briefing",
      steps: economicsSteps({ type: "indicator-threshold", category: "economics", topic, market: "", question: "", eventTitle: "", subject: { name: "US inflation (CPI)", kind: "indicator" }, indicator: "cpi", deadline: null, rivals: [] }),
    };
  if (category === "sports")
    return {
      title: "NBA standings",
      steps: [
        async () => {
          const j = await getJson("https://site.api.espn.com/apis/v2/sports/basketball/nba/standings", { ttlMs: 3 * 3600_000 });
          const out: Sourced[] = [];
          for (const conf of j.children ?? []) {
            const entries = (conf.standings?.entries ?? []).map((e: any) => {
              const st = (n: string) => e.stats?.find((x: any) => x.name === n)?.displayValue ?? "–";
              return { team: e.team?.displayName, w: st("wins"), l: st("losses"), pct: Number(st("winPercent")), gb: st("gamesBehind"), streak: st("streak") };
            });
            entries.sort((a: any, b: any) => b.pct - a.pct);
            out.push(live("espn", { kind: "table", heading: conf.name, columns: ["Team", "W", "L", "GB", "Streak"], rows: entries.slice(0, 8).map((e: any) => [e.team, e.w, e.l, e.gb, e.streak]) }));
          }
          return out;
        },
      ],
    };
  return { title: `${topic} briefing`, steps: [headlineStep(topic.toLowerCase(), `${topic}: latest`)] };
}
export { categoryOf };
