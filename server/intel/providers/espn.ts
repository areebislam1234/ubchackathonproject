// Sports data from ESPN's public JSON endpoints (no key). Athletes are resolved to ESPN ids through
// search, so a report is about exactly the player or team in the market.
import { getJson } from "../http";

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const WEB = "https://site.web.api.espn.com/apis/common/v3";
const SEARCH = "https://site.web.api.espn.com/apis/common/v3/search";

/** Gemini ticker league → ESPN sport/league path. */
export const LEAGUE_PATH: Record<string, string> = {
  NBA: "basketball/nba",
  WNBA: "basketball/wnba",
  NCAAM: "basketball/mens-college-basketball",
  NCAAW: "basketball/womens-college-basketball",
  NFL: "football/nfl",
  NCAAF: "football/college-football",
  MLB: "baseball/mlb",
  NHL: "hockey/nhl",
  EPL: "soccer/eng.1",
  UCL: "soccer/uefa.champions",
  MLS: "soccer/usa.1",
  LIGAMX: "soccer/mex.1",
  LALIGA: "soccer/esp.1",
  SERIEA: "soccer/ita.1",
  BUNDESLIGA: "soccer/ger.1",
};
const ESPN_LEAGUE_TO_PATH: Record<string, string> = Object.fromEntries(Object.values(LEAGUE_PATH).map((p) => [p.split("/")[1], p]));

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export type Athlete = { id: string; name: string; path: string };

/** Find an athlete by name, preferring the market's league. */
export async function findAthlete(name: string, league?: string): Promise<Athlete | null> {
  const j = await getJson(`${SEARCH}?query=${encodeURIComponent(name)}&limit=8&type=player`, { ttlMs: 24 * 3600_000 });
  const want = league ? LEAGUE_PATH[league] : undefined;
  const items = (j.items ?? []).filter((i: any) => i.type === "player" && ESPN_LEAGUE_TO_PATH[i.league]);
  const exact = items.filter((i: any) => norm(i.displayName) === norm(name));
  const pick = [...exact, ...items].find((i: any) => !want || ESPN_LEAGUE_TO_PATH[i.league] === want) ?? exact[0] ?? items[0];
  return pick ? { id: String(pick.id), name: pick.displayName, path: ESPN_LEAGUE_TO_PATH[pick.league] } : null;
}

export async function athleteProfile(a: Athlete) {
  const j = await getJson(`${WEB}/sports/${a.path}/athletes/${a.id}`, { ttlMs: 6 * 3600_000 });
  const x = j.athlete ?? j;
  return { name: x.displayName as string, position: x.position?.abbreviation as string | undefined, team: x.team ? { id: String(x.team.id), name: x.team.displayName as string } : null };
}

/** Season and career averages (labels + values). */
export async function athleteSeason(a: Athlete) {
  const j = await getJson(`${WEB}/sports/${a.path}/athletes/${a.id}/overview`, { ttlMs: 3 * 3600_000 });
  const st = j.statistics ?? {};
  const labels: string[] = st.labels ?? [];
  const split = (name: RegExp) => (st.splits ?? []).find((s: any) => name.test(s.displayName ?? ""))?.stats as string[] | undefined;
  return { labels, season: split(/regular|season|postseason/i) ?? (st.splits?.[0]?.stats as string[] | undefined), career: split(/career/i) };
}

export type GameLine = { date: string; opponent: string; atVs: string; result: string; score: string; stats: Record<string, string> };

/** Most recent games first, each with every stat keyed by ESPN's stat name (e.g. points, rushingTouchdowns). */
export async function athleteGames(a: Athlete): Promise<GameLine[]> {
  const j = await getJson(`${WEB}/sports/${a.path}/athletes/${a.id}/gamelog`, { ttlMs: 3 * 3600_000 });
  const names: string[] = j.names ?? [];
  const out: GameLine[] = [];
  for (const st of j.seasonTypes ?? [])
    for (const cat of st.categories ?? [])
      for (const e of cat.events ?? []) {
        const meta = j.events?.[e.eventId];
        if (!meta || out.some((g) => g.date === meta.gameDate)) continue;
        out.push({
          date: meta.gameDate,
          opponent: meta.opponent?.abbreviation ?? meta.opponent?.displayName ?? "?",
          atVs: meta.atVs ?? "vs",
          result: meta.gameResult ?? "",
          score: meta.score ?? "",
          stats: Object.fromEntries(names.map((n, i) => [n, e.stats?.[i] ?? ""])),
        });
      }
  return out.sort((x, y) => (x.date < y.date ? 1 : -1));
}

/** ESPN's own recent stories about an athlete. */
export async function athleteNews(a: Athlete) {
  const j = await getJson(`${WEB}/sports/${a.path}/athletes/${a.id}/overview`, { ttlMs: 3 * 3600_000 });
  return (j.news ?? []).map((n: any) => ({ title: String(n.headline ?? "").trim(), date: String(n.published ?? "").slice(0, 10) })).filter((n: any) => n.title) as { title: string; date: string }[];
}

/** ESPN's recent stories about a team (injuries, trades, form). */
export async function teamNews(path: string, id: string) {
  const j = await getJson(`${SITE}/${path}/news?team=${id}&limit=8`, { ttlMs: 60 * 60_000 });
  return (j.articles ?? []).map((n: any) => ({ title: String(n.headline ?? "").trim(), date: String(n.published ?? "").slice(0, 10) })).filter((n: any) => n.title) as { title: string; date: string }[];
}

export type Team = { id: string; name: string; abbreviation: string; location: string; nickname: string };

export async function leagueTeams(path: string): Promise<Team[]> {
  const j = await getJson(`${SITE}/${path}/teams?limit=500`, { ttlMs: 24 * 3600_000 });
  return (j.sports?.[0]?.leagues?.[0]?.teams ?? []).map((t: any) => ({ id: String(t.team.id), name: t.team.displayName, abbreviation: t.team.abbreviation, location: t.team.location ?? "", nickname: t.team.name ?? "" }));
}

/** Match a Gemini participant ("San Antonio Spurs" / "SAS", or "Los Angeles C") to an ESPN team. */
export async function findTeam(path: string, want: { name: string; abbreviation?: string }) {
  const teams = await leagueTeams(path);
  const n = norm(want.name);
  return (
    teams.find((t) => norm(t.name) === n) ??
    teams.find((t) => want.abbreviation && t.abbreviation.toUpperCase() === want.abbreviation.toUpperCase()) ??
    teams.find((t) => norm(t.location) === n || norm(t.nickname) === n) ??
    teams.find((t) => norm(t.name).startsWith(n) || n.startsWith(norm(t.location))) ??
    null
  );
}

export async function teamSummary(path: string, id: string) {
  const j = await getJson(`${SITE}/${path}/teams/${id}`, { ttlMs: 3 * 3600_000 });
  const t = j.team ?? {};
  const rec = (type: string) => (t.record?.items ?? []).find((i: any) => i.type === type)?.summary as string | undefined;
  return { name: t.displayName as string, standing: (t.standingSummary as string | undefined) ?? null, record: rec("total") ?? null, home: rec("home") ?? null, road: rec("road") ?? null };
}

export type TeamGame = { date: string; opponent: string; opponentName: string; home: boolean; pf: number; pa: number; won: boolean };

/** Completed games this season, most recent first. */
export async function teamGames(path: string, id: string): Promise<TeamGame[]> {
  const j = await getJson(`${SITE}/${path}/teams/${id}/schedule`, { ttlMs: 3 * 3600_000 });
  const out: TeamGame[] = [];
  for (const e of j.events ?? []) {
    const c = e.competitions?.[0];
    if (!c?.status?.type?.completed) continue;
    const me = c.competitors?.find((x: any) => String(x.team?.id ?? x.id) === id);
    const op = c.competitors?.find((x: any) => String(x.team?.id ?? x.id) !== id);
    if (!me || !op) continue;
    const score = (x: any) => Number(typeof x.score === "object" ? (x.score?.value ?? x.score?.displayValue) : x.score);
    const pf = score(me);
    const pa = score(op);
    if (!Number.isFinite(pf) || !Number.isFinite(pa)) continue;
    out.push({ date: e.date, opponent: op.team?.abbreviation ?? "?", opponentName: op.team?.displayName ?? "", home: me.homeAway === "home", pf, pa, won: me.winner === true || pf > pa });
  }
  return out.sort((x, y) => (x.date < y.date ? 1 : -1));
}
