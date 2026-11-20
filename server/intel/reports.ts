// Intelligence reports: granted the instant a boss drops one (so the reward is atomic with the
// fight), then filled in a few seconds later from live sources about one specific market.
import crypto from "node:crypto";
import { BOSSES } from "../../shared/rules.js";
import { mulberry32, strSeed } from "../../shared/rng.js";
import { contractPricesBps } from "../../gemini/client";
import { gemini } from "../bounties";
import { env } from "../config";
import { db, type Player } from "../db";
import { award } from "../players";
import { categorySteps, stepsFor } from "./builders";
import { sampleSections } from "./providers/mock";
import { parseScenario, type MarketContract, type MarketEvent } from "./scenario";
import { chooseMarket, type Pick } from "./subjects";
import type { IntelCategory, IntelRarity, IntelReport, Scenario, Section, Sourced } from "./types";

/** How many sections each rarity reveals. Legendary also gets the market's own odds. */
const DEPTH: Record<IntelRarity, number> = { common: 1, rare: 2, epic: 3, legendary: 8 };
const MAX_BYTES = 20_000;
const COMPILE_MS = 40_000; // headlines can take ~20s; reports fill in the background

export function intelList(p: Player) {
  p.intel ??= [];
  return p.intel;
}

/** Add a report to the player's collection right now; its contents follow shortly. */
export function grantReport(p: Player, bossKey: string, rarity: IntelRarity): IntelReport {
  const boss = (BOSSES as any)[bossKey];
  const r: IntelReport = {
    id: `R-${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    rarity,
    category: boss.intel.category as IntelCategory,
    topic: boss.intel.topic,
    boss: bossKey,
    bossName: boss.name,
    collectedAt: Date.now(),
    status: "compiling",
    title: `${boss.intel.topic} intelligence`,
    subject: null,
    market: null,
    scenario: null,
    live: false,
    partial: false,
    dataAsOf: null,
    sections: [],
  };
  intelList(p).push(r);
  if (intelList(p).length >= 10) award(p, "spymaster");
  db.save();
  setImmediate(() => void compileReport(p.id, r.id).catch((e) => console.error("intel:", (e as Error).message)));
  return r;
}

function titleFor(s: Scenario) {
  switch (s.type) {
    case "award-race":
      return `Dossier: ${s.subject.name}`;
    case "player-line":
      return `Dossier: ${s.subject.name}, ${s.stat}`;
    case "game-outcome":
    case "game-total":
    case "game-spread":
      return `Scouting report: ${s.teams && s.teams.length > 1 ? s.teams.map((t) => t.name).join(" vs ") : s.subject.name}`;
    case "price-threshold":
    case "price-direction":
      return `${s.symbol ?? s.subject.name} price watch`;
    case "indicator-threshold":
      return `${s.subject.name} briefing`;
    case "weather-threshold":
      return `Forecast: ${s.place}`;
    default:
      return `Briefing: ${s.question.length > 60 ? `${s.question.slice(0, 57)}…` : s.question}`;
  }
}

/** The market's own odds: every outcome in its event, plus how the line moved since a bounty reveal. */
async function oddsSection(pick: Pick): Promise<Sourced | null> {
  let event = pick.event as any;
  if (!event.contracts?.some((c: any) => c.prices)) {
    const found = await gemini.findContract(pick.contract.instrumentSymbol).catch(() => null);
    if (found) event = found.event;
  }
  const rows: (string | number)[][] = [];
  let highlight: number | undefined;
  for (const c of (event.contracts ?? []).slice(0, 8)) {
    const p = contractPricesBps(c);
    if (p.midBps === null) continue;
    if (c.instrumentSymbol === pick.contract.instrumentSymbol) highlight = rows.length;
    rows.push([c.label ?? c.instrumentSymbol, `${Math.round(p.midBps / 100)}%`]);
  }
  if (!rows.length) return null;
  const b = pick.bounty;
  if (b?.revealQuote?.bidBps != null && b.revealQuote.askBps != null && highlight !== undefined) rows[highlight].push(`${Math.round((b.revealQuote.bidBps + b.revealQuote.askBps) / 200)}% at the reveal`);
  const section: Section = { kind: "table", heading: "What the market thinks (Gemini odds)", columns: rows.some((r) => r.length > 2) ? ["Outcome", "Implied chance", "Then"] : ["Outcome", "Implied chance"], rows, highlight };
  return { section, live: env.geminiMode === "live", fetchedAt: Date.now(), provider: "gemini" };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** Run builder steps in parallel and keep their sections in priority order. */
async function runSteps(steps: (() => Promise<Sourced | Sourced[] | null>)[], ms: number) {
  const results = await Promise.all(steps.map((s) => withTimeout(s().catch(() => null), ms)));
  return results.flatMap((r) => (r ? (Array.isArray(r) ? r : [r]) : []));
}

export async function compileReport(playerId: string, reportId: string) {
  const p = db.data.players[playerId];
  const r = p?.intel?.find((x) => x.id === reportId);
  if (!p || !r || r.status === "ready") return;
  const rnd = mulberry32(strSeed(reportId));
  let got: Sourced[] = [];
  let scenario: Scenario | null = null;
  let pick: Pick | null = null;
  if (env.intel) {
    pick = await withTimeout(chooseMarket(p, r.category, r.topic, rnd).catch(() => null), 10_000);
    if (pick) {
      scenario = parseScenario(pick.event, pick.contract);
      got = await runSteps(stepsFor(scenario), COMPILE_MS - 12_000);
    }
    if (!got.length) {
      // nothing specific could be fetched: fall back to a category-wide report, titled as such
      const cat = categorySteps(r.category, r.topic);
      got = await runSteps(cat.steps, 25_000);
      if (got.length) {
        r.title = cat.title;
        scenario = null;
      }
    }
  }
  const depth = DEPTH[r.rarity];
  let chosen = got.slice(0, depth);
  if (r.rarity === "legendary" && pick) {
    const odds = await withTimeout(oddsSection(pick).catch(() => null), 8000);
    if (odds) chosen.push(odds);
  }
  if (!chosen.length) chosen = sampleSections(scenario, r.topic);
  if (scenario) {
    r.title = titleFor(scenario);
    r.subject = scenario.subject.name;
    r.scenario = scenario.type;
  }
  if (pick) r.market = { symbol: pick.contract.instrumentSymbol, question: pick.contract.label ?? pick.event.title ?? "", eventTitle: pick.event.title ?? "", practice: env.geminiMode !== "live", why: pick.why };
  r.sections = chosen.map((c) => ({ ...c.section, live: c.live }));
  // keep reports small: trim long tables until it fits
  while (JSON.stringify(r.sections).length > MAX_BYTES) {
    const t = r.sections.find((s) => (s.kind === "table" && s.rows.length > 3) || (s.kind === "series" && s.points.length > 6) || (s.kind === "list" && s.items.length > 2));
    if (!t) break;
    if (t.kind === "table") t.rows = t.rows.slice(0, -1);
    if (t.kind === "series") t.points = t.points.slice(1);
    if (t.kind === "list") t.items = t.items.slice(0, -1);
  }
  r.live = r.sections.length > 0 && r.sections.every((s) => s.live);
  r.partial = r.sections.some((s) => !s.live) && r.sections.some((s) => s.live);
  r.dataAsOf = Math.min(...chosen.map((c) => c.fetchedAt));
  r._provider = [...new Set(chosen.map((c) => c.provider))];
  r.status = "ready";
  db.save();
}

/** What the client sees: no internal provider ids. */
export function reportView(r: IntelReport) {
  const { _provider, ...rest } = r;
  void _provider;
  return rest;
}

/** On boot, finish any report a restart interrupted. */
export function resumeCompiling() {
  for (const p of Object.values(db.data.players)) for (const r of p.intel ?? []) if (r.status === "compiling") void compileReport(p.id, r.id).catch(() => {});
}

export type { MarketContract, MarketEvent };
