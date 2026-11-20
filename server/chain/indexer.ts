// The Fortune Front indexer. QuickNode is the primary way the game reads the chain:
//   - live:     QuickNode Streams delivers program transactions (their logs) to /webhooks/quicknode
//   - history:  QuickNode RPC getSignaturesForAddress(program) + getTransaction fill any gaps
//   - state:    QuickNode RPC getTokenSupply, plus a QuickNode WebSocket accountSubscribe on the mints
// Events are de-duplicated by (signature, event index), failed transactions are skipped, and each
// event is provisional at "confirmed" and final at "finalized". Every derived number keeps the
// signatures it came from, so the board can link to the explorer.
//
// Before the program is deployed, the bridge (onchain.ts) feeds the same events in, labelled
// "local", so the screens work; they switch to on-chain data once the program is live.
import { createSolanaRpcSubscriptions, type Address } from "@solana/kit";
import { ABILITIES, ABILITY_KEYS, ORDERS, ORDER_KEYS, UNITS, UNIT_KEYS, UNIT_CLASS } from "../../shared/rules.js";
import { explorerTx, solanaRpcUrl } from "../config";
import { db, type Player } from "../db";
import { eventsFromLogs, PROGRAM_ID, playerKey, type ProgramEvent } from "./program";
import { rpc } from "./solana";

export type IndexedEvent = ProgramEvent & {
  key: string; // signature:index (or local:queueId:index)
  signature: string;
  slot: number | null;
  blockTime: number | null;
  status: "local" | "confirmed" | "finalized";
};

type IndexState = { events: IndexedEvent[]; seen: Record<string, 1>; cursor: string | null; supply: { gold: number | null; might: number | null; at: number } | null; backfilledAt: number };

function store(): IndexState {
  const d = db.data as any;
  d.index ??= { events: [], seen: {}, cursor: null, supply: null, backfilledAt: 0 };
  return d.index;
}

/** Add events, skipping any already seen (Stream redeliveries, backfill overlap). */
export function ingest(list: IndexedEvent[]) {
  const s = store();
  let added = 0;
  for (const e of list) {
    if (s.seen[e.key]) {
      // a later, more final sighting upgrades the status
      if (e.status === "finalized") for (const x of s.events) if (x.key === e.key) x.status = "finalized";
      continue;
    }
    s.seen[e.key] = 1;
    s.events.push(e);
    added++;
  }
  if (s.events.length > 20000) {
    const drop = s.events.splice(0, s.events.length - 20000);
    for (const d of drop) delete s.seen[d.key];
  }
  if (added) db.save();
  return added;
}

/** One transaction's program events. Failed transactions never reach here (filter and backfill skip them). */
export function ingestTransaction(signature: string, slot: number | null, blockTime: number | null, logs: string[], status: "confirmed" | "finalized" = "confirmed") {
  const evs = eventsFromLogs(logs);
  return ingest(evs.map((e, i) => ({ ...e, key: `${signature}:${i}`, signature, slot, blockTime, status })));
}

/** QuickNode RPC backfill: every program transaction since the saved cursor. */
export async function backfill(limit = 500) {
  const s = store();
  let before: string | undefined;
  const fresh: { signature: string; slot: number; blockTime: number | null }[] = [];
  for (let page = 0; page < 10 && fresh.length < limit; page++) {
    const sigs = await rpc.getSignaturesForAddress(PROGRAM_ID, { limit: 100, ...(before ? { before: before as any } : {}), ...(s.cursor ? { until: s.cursor as any } : {}), commitment: "confirmed" }).send();
    if (!sigs.length) break;
    for (const x of sigs) if (!x.err) fresh.push({ signature: x.signature, slot: Number(x.slot), blockTime: x.blockTime == null ? null : Number(x.blockTime) });
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 100) break;
  }
  let added = 0;
  for (const f of fresh.reverse()) {
    if (s.seen[`${f.signature}:0`]) continue;
    const tx = await rpc.getTransaction(f.signature as any, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }).send();
    if (!tx || tx.meta?.err) continue;
    added += ingestTransaction(f.signature, f.slot, f.blockTime, (tx.meta?.logMessages ?? []) as string[]);
  }
  if (fresh.length) s.cursor = fresh[fresh.length - 1].signature;
  s.backfilledAt = Date.now();
  db.save();
  return added;
}

/** Promote confirmed events to finalized; drop any whose transaction turned out to fail or vanish. */
export async function finalize() {
  const s = store();
  const pending = [...new Set(s.events.filter((e) => e.status === "confirmed").map((e) => e.signature))].slice(0, 200);
  if (!pending.length) return 0;
  const { value } = await rpc.getSignatureStatuses(pending as any, { searchTransactionHistory: true }).send();
  let changed = 0;
  pending.forEach((sig, i) => {
    const st = value[i];
    if (st?.err) {
      s.events = s.events.filter((e) => e.signature !== sig);
      changed++;
    } else if (st?.confirmationStatus === "finalized") {
      for (const e of s.events) if (e.signature === sig) e.status = "finalized";
      changed++;
    }
  });
  if (changed) db.save();
  return changed;
}

/** QuickNode RPC token supply for the Gold and Might mints. */
export async function refreshSupply(mints: { gold: string; might: string } | null | undefined) {
  if (!mints) return;
  const [g, m] = await Promise.all([rpc.getTokenSupply(mints.gold as Address).send(), rpc.getTokenSupply(mints.might as Address).send()]);
  store().supply = { gold: Number(g.value.amount), might: Number(m.value.amount), at: Date.now() };
  db.save();
}

/** QuickNode WebSocket: refresh supply whenever a mint account changes. */
export async function watchMints(mints: { gold: string; might: string }) {
  const wsUrl = process.env.SOLANA_WS_URL ?? solanaRpcUrl.replace(/^http/, "ws");
  const subs = createSolanaRpcSubscriptions(wsUrl);
  const abort = new AbortController();
  for (const mint of [mints.gold, mints.might]) {
    const stream = await subs.accountNotifications(mint as Address, { commitment: "confirmed", encoding: "base64" }).subscribe({ abortSignal: abort.signal });
    void (async () => {
      for await (const _ of stream) await refreshSupply(mints).catch(() => {});
    })();
  }
  return () => abort.abort();
}

// ── Derived views ─────────────────────────────────────────────────────
const events = () => store().events;
const isGold = (mint: string, mints?: { gold: string } | null) => mint === "Gold" || (!!mints && mint === mints.gold);
const sourceOf = (e: IndexedEvent) => ({ signature: e.signature, status: e.status, url: e.status === "local" ? null : explorerTx(e.signature) });
const walletOwner = (() => {
  let cache: Map<string, Player> | null = null;
  let size = -1;
  return (w: string) => {
    const players = Object.values(db.data.players);
    if (!cache || size !== players.length) {
      cache = new Map(players.map((p) => [playerKey(p.id) as string, p]));
      size = players.length;
    }
    return cache.get(w) ?? null;
  };
})();

function series(points: { at: number; v: number }[], buckets = 24, spanMs = 24 * 3600_000) {
  const end = Date.now();
  const start = end - spanMs;
  const step = spanMs / buckets;
  const out = Array.from({ length: buckets }, (_, i) => ({ t: Math.round(start + i * step), v: 0 }));
  for (const p of points) if (p.at >= start) out[Math.min(buckets - 1, Math.floor((p.at - start) / step))].v += p.v;
  return out;
}

/** The Economic Board: Gold, Might and USDC, from indexed events (and QuickNode supply when on-chain). */
export function economyBoard(mints?: { gold: string; might: string } | null) {
  const ev = events();
  const at = (e: IndexedEvent) => (e.blockTime ?? 0) * 1000;
  const src = (list: IndexedEvent[]) => list.slice(-12).reverse().map(sourceOf);
  const sum = (list: IndexedEvent[], f: (e: IndexedEvent) => number) => list.reduce((s, e) => s + f(e), 0);

  // Gold
  const settles = ev.filter((e) => e.name === "GoldSettled");
  const upgrades = ev.filter((e) => e.name === "UnitUpgraded" && e.data.gold_spent > 0);
  const goldEsc = ev.filter((e) => e.name === "Escrowed" && isGold(e.data.mint, mints));
  const goldPaid = ev.filter((e) => e.name === "RewardPaid" && isGold(e.data.mint, mints));
  const goldMinted = sum(settles, (e) => Math.max(0, e.data.delta));
  const goldBurned = sum(settles, (e) => Math.max(0, -e.data.delta)) + sum(upgrades, (e) => e.data.gold_spent);
  const goldSupplyLocal = goldMinted - goldBurned;
  // Might
  const minted = ev.filter((e) => e.name === "MightMinted");
  const burned = ev.filter((e) => e.name === "MightBurned");
  const mightEsc = ev.filter((e) => e.name === "Escrowed" && !isGold(e.data.mint, mints));
  const mightPaid = ev.filter((e) => e.name === "RewardPaid" && !isGold(e.data.mint, mints));
  const released = ev.filter((e) => e.name === "Released");
  const yields = ev.filter((e) => e.name === "YieldConverted");
  const abilities = ev.filter((e) => e.name === "AbilityUnlocked");
  const mintedBy = (r: number) => sum(minted.filter((e) => e.data.reason === r), (e) => e.data.amount);
  const burnedBy = (r: number) => sum(burned.filter((e) => e.data.reason === r), (e) => e.data.amount);
  const mightSupplyLocal = sum(minted, (e) => e.data.amount) - sum(burned, (e) => e.data.amount);
  const escrowedNow = (isG: boolean) => {
    const stakes = ev.filter((e) => e.name === "Escrowed" && isGold(e.data.mint, mints) === isG);
    const ids = new Set(stakes.map((e) => e.data.stake));
    return sum(stakes, (e) => e.data.amount) - sum(released.filter((e) => ids.has(e.data.stake)), (e) => e.data.amount + e.data.burned);
  };
  const supply = store().supply;
  const holders = (name: "gold" | "might") => {
    const bal = new Map<string, number>();
    const add = (w: string, v: number) => bal.set(w, (bal.get(w) ?? 0) + v);
    for (const e of ev) {
      if (name === "gold") {
        if (e.name === "GoldSettled") add(e.data.wallet, e.data.delta);
        if (e.name === "UnitUpgraded") add(e.data.wallet, -e.data.gold_spent);
        if (e.name === "Escrowed" && isGold(e.data.mint, mints)) add(e.data.wallet, -e.data.amount);
        if (e.name === "RewardPaid" && isGold(e.data.mint, mints)) add(e.data.wallet, e.data.amount);
      } else {
        if (e.name === "MightMinted") add(e.data.wallet, e.data.amount);
        if (e.name === "MightBurned" && e.data.reason !== 1) add(e.data.wallet, -e.data.amount);
        if (e.name === "Escrowed" && !isGold(e.data.mint, mints)) add(e.data.wallet, -e.data.amount);
        if (e.name === "RewardPaid" && !isGold(e.data.mint, mints)) add(e.data.wallet, e.data.amount);
      }
    }
    return [...bal].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w, v]) => ({ name: walletOwner(w)?.name ?? `${w.slice(0, 4)}…${w.slice(-4)}`, playerId: walletOwner(w)?.id ?? null, balance: v }));
  };

  // Portfolio: every vault's deposits (by asset), trades and the Might trading and holding earned
  const vaults = Object.values(db.data.players).filter((p) => !p.bot && (p as any).vault?.holdings).map((p) => ({ p, v: (p as any).vault }));
  const vEntries = vaults.flatMap(({ p, v }) => (v.ledger ?? []).map((e: any) => ({ ...e, player: p.name })));
  const vDeposits = vEntries.filter((e) => e.kind === "deposit");
  const vTrades = vEntries.filter((e) => e.kind === "trade");
  const byAsset: Record<string, { count: number; usd: number }> = {};
  for (const e of vDeposits) {
    const k = String(e.asset ?? "SOL").startsWith("mint:") ? "Other tokens" : String(e.asset ?? "SOL");
    byAsset[k] ??= { count: 0, usd: 0 };
    byAsset[k].count++;
    byAsset[k].usd += e.usd ?? 0;
  }
  const traded: Record<string, number> = {};
  for (const e of vTrades) for (const c of [e.from, e.to]) if (c && c !== "USDC") traded[c] = (traded[c] ?? 0) + 1;
  const portfolio = {
    players: vaults.length,
    deposits: vDeposits.length,
    depositsByAsset: Object.entries(byAsset).sort((a, b) => b[1].usd - a[1].usd).map(([asset, x]) => ({ asset, ...x })),
    trades: vTrades.length,
    volume: vTrades.reduce((s, e) => s + (e.usd ?? 0), 0),
    realizedProfit: vTrades.reduce((s, e) => s + Math.max(0, e.realized ?? 0), 0),
    realizedLoss: vTrades.reduce((s, e) => s + Math.min(0, e.realized ?? 0), 0),
    mightTrading: vaults.reduce((s, { v }) => s + (v.mightTrading ?? 0), 0),
    mightHodl: vaults.reduce((s, { v }) => s + (v.mightHodl ?? 0), 0),
    mostTraded: Object.entries(traded).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([coin, n]) => ({ coin, n })),
    history: series(vTrades.map((e) => ({ at: e.at, v: e.usd ?? 0 }))),
    sources: vDeposits.filter((e) => e.signature).slice(-12).reverse().map((e) => ({ signature: e.signature, status: e.streamed ? "finalized" : "confirmed", url: explorerTx(e.signature) })),
  };

  // USDC: deposits and withdrawals are real devnet USDC transfers the QuickNode Stream confirmed
  const ledgers = Object.values(db.data.players).flatMap((p) => (p.funds?.ledger ?? []).map((l) => ({ ...l, player: p.name })));
  const deposits = ledgers.filter((l) => l.kind === "deposit");
  const withdrawals = ledgers.filter((l) => l.kind === "withdraw" && l.status !== "failed");
  const converts = ledgers.filter((l) => l.kind === "convert");
  const sells = ledgers.filter((l) => l.kind === "sell");
  const usdcSrc = (list: typeof ledgers) => list.filter((l) => l.signature).slice(-12).reverse().map((l) => ({ signature: l.signature!, status: l.status ?? "confirmed", url: explorerTx(l.signature!) }));
  const mightTxCount = minted.length + burned.length + mightEsc.length + mightPaid.length;

  return {
    gold: {
      supply: supply?.gold ?? goldSupplyLocal,
      supplySource: supply?.gold != null ? "QuickNode getTokenSupply" : "indexed events",
      minted: goldMinted,
      burned: goldBurned,
      spentOnUpgrades: sum(upgrades, (e) => e.data.gold_spent),
      escrowed: escrowedNow(true),
      rewardsPaid: sum(goldPaid, (e) => e.data.amount),
      transactions: settles.length + upgrades.length + goldEsc.length + goldPaid.length,
      holders: holders("gold"),
      history: series(settles.map((e) => ({ at: at(e), v: e.data.delta })).concat(upgrades.map((e) => ({ at: at(e), v: -e.data.gold_spent })))),
      sources: src([...settles, ...upgrades, ...goldEsc, ...goldPaid].sort((a, b) => at(a) - at(b))),
    },
    might: {
      supply: supply?.might ?? mightSupplyLocal,
      supplySource: supply?.might != null ? "QuickNode getTokenSupply" : "indexed events",
      minted: sum(minted, (e) => e.data.amount),
      mintedFromYield: mintedBy(0),
      mintedFromDuels: mintedBy(1),
      migrated: mintedBy(2),
      burned: sum(burned, (e) => e.data.amount),
      spentOnAbilities: burnedBy(0),
      burnedInDuels: burnedBy(1),
      escrowed: escrowedNow(false),
      rewardsPaid: sum(mightPaid, (e) => e.data.amount),
      abilitiesUnlocked: abilities.length,
      popularAbilities: Object.entries(abilities.reduce((m: Record<string, number>, e) => ((m[ABILITY_KEYS[e.data.ability]] = (m[ABILITY_KEYS[e.data.ability]] ?? 0) + 1), m), {}))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, n]) => ({ ability: (ABILITIES as any)[k]?.name ?? k, n })),
      transactions: mightTxCount,
      holders: holders("might"),
      yieldRecords: yields.slice(-10).reverse().map((e) => ({ player: walletOwner(e.data.wallet)?.name ?? "?", usdc: e.data.usdc, might: e.data.might, ...sourceOf(e) })),
      history: series(minted.map((e) => ({ at: at(e), v: e.data.amount })).concat(burned.map((e) => ({ at: at(e), v: -e.data.amount })))),
      sources: src([...minted, ...burned, ...mightEsc, ...mightPaid].sort((a, b) => at(a) - at(b))),
    },
    usdc: {
      deposited: deposits.reduce((s, l) => s + l.usdc, 0),
      withdrawn: withdrawals.reduce((s, l) => s - l.usdc, 0),
      realizedYield: sells.reduce((s, l) => s + Math.max(0, l.realized ?? 0), 0),
      convertedToMight: converts.reduce((s, l) => s - l.usdc, 0),
      deposits: deposits.length,
      withdrawals: withdrawals.length,
      history: series(deposits.map((l) => ({ at: l.at, v: l.usdc })).concat(withdrawals.map((l) => ({ at: l.at, v: l.usdc })))),
      sources: usdcSrc([...deposits, ...withdrawals].sort((a, b) => a.at - b.at)),
      sourceNote: "Deposits and withdrawals are devnet USDC transfers confirmed through the QuickNode Stream.",
    },
    portfolio,
    events: ev.length,
    local: ev.filter((e) => e.status === "local").length,
    finalized: ev.filter((e) => e.status === "finalized").length,
  };
}

/** Public stats for one warlord: what anyone may see. */
export function publicStats(p: Player) {
  const w = playerKey(p.id) as string;
  const ev = events();
  const battles = ev.filter((e) => e.name === "BattleResolved" && (e.data.attacker === w || e.data.defender === w));
  const kinds = ["bounty", "boss", "duel", "other"];
  const rec = kinds.map(() => ({ wins: 0, losses: 0 }));
  for (const b of battles) {
    const won = b.data.attacker === w ? b.data.attacker_won : !b.data.attacker_won;
    rec[Math.min(3, b.data.kind)][won ? "wins" : "losses"]++;
  }
  const wins = rec.reduce((s, r) => s + r.wins, 0);
  const losses = rec.reduce((s, r) => s + r.losses, 0);
  const upgrades = ev.filter((e) => e.name === "UnitUpgraded" && e.data.wallet === w);
  const yields = ev.filter((e) => e.name === "YieldConverted" && e.data.wallet === w);
  const unlocks = ev.filter((e) => e.name === "AbilityUnlocked" && e.data.wallet === w);
  const onchain = battles.some((b) => b.status !== "local");
  return {
    id: p.id,
    name: p.name,
    wallet: w,
    keep: p.buildings.keep,
    trophies: p.trophies,
    battles: wins + losses,
    wins,
    losses,
    winRate: wins + losses ? Math.round((wins / (wins + losses)) * 100) : null,
    byKind: Object.fromEntries(kinds.map((k, i) => [k, rec[i]])),
    gold: Math.floor(p.gold),
    might: p.might ?? 0,
    realizedYield: yields.length ? yields[yields.length - 1].data.realized_total : (p.funds?.converted ?? 0),
    unitLevels: Object.fromEntries(UNIT_KEYS.map((k) => [k, p.unitLevels[k] ?? 1])),
    abilities: unlocks.map((e) => (ABILITIES as any)[ABILITY_KEYS[e.data.ability]]?.name),
    progression: upgrades.slice(-8).reverse().map((e) => ({ unit: (UNITS as any)[UNIT_KEYS[e.data.unit]]?.name, level: e.data.level, drills: e.data.drills, ...sourceOf(e) })),
    recent: battles.slice(-5).reverse().map((b) => ({ kind: kinds[Math.min(3, b.data.kind)], context: b.data.context, won: b.data.attacker === w ? b.data.attacker_won : !b.data.attacker_won, score: b.data.score, ...sourceOf(b) })),
    source: onchain ? "on-chain" : battles.length ? "local (program not deployed yet)" : "no battles yet",
  };
}

/**
 * The Warlord dossier (relic intelligence): how a rival fights, from their indexed battle history.
 * Only revealed through an Information Relic.
 */
export function dossier(p: Player) {
  const w = playerKey(p.id) as string;
  const ev = events();
  const sides = ev
    .filter((e) => e.name === "BattleResolved" && (e.data.attacker === w || e.data.defender === w))
    .map((e) => ({ side: e.data.attacker === w ? e.data.attacker_side : e.data.defender_side, attacking: e.data.attacker === w, won: e.data.attacker === w ? e.data.attacker_won : !e.data.attacker_won, at: e.blockTime, source: sourceOf(e) }));
  const tally = <K extends string>(keys: K[]) => {
    const m: Record<string, number> = {};
    for (const k of keys) m[k] = (m[k] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const orders = tally(sides.map((s) => ORDER_KEYS[s.side.order] ?? "hold"));
  const abil = tally(sides.flatMap((s) => s.side.abilities.filter((a: number) => a !== 255).map((a: number) => ABILITY_KEYS[a])));
  const classCount: Record<string, number> = {};
  const frontCount: Record<string, number> = {};
  let units = 0;
  let wingRaiders = 0;
  let raiders = 0;
  for (const s of sides)
    s.side.slots.forEach((slot: any, i: number) => {
      if (!slot.n) return;
      const cls = (UNIT_CLASS as any)[UNIT_KEYS[slot.unit]];
      classCount[cls] = (classCount[cls] ?? 0) + slot.n;
      units += slot.n;
      if (i < 3) frontCount[cls] = (frontCount[cls] ?? 0) + slot.n;
      if (cls === "raider") {
        raiders += slot.n;
        if (i % 3 !== 1) wingRaiders += slot.n;
      }
    });
  const mix = Object.entries(classCount).sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ cls: c, share: Math.round((n / Math.max(1, units)) * 100) }));
  const tendencies: string[] = [];
  if (orders[0]) tendencies.push(`Favours the ${(ORDERS as any)[orders[0][0]]?.name ?? orders[0][0]} order (${orders[0][1]} of ${sides.length} battles).`);
  if (mix[0]) tendencies.push(`Army is mostly ${mix[0].cls}s (${mix[0].share}% of troops fielded).`);
  if (raiders && wingRaiders / raiders >= 0.6) tendencies.push("Puts Raiders on the wings to slip past Guardians: keep Guardians on the flanks or bring Taunt.");
  const front = Object.entries(frontCount).sort((a, b) => b[1] - a[1])[0];
  if (front && front[0] !== "guardian") tendencies.push(`Front row is often ${front[0]}s, not Guardians: the backline behind it is easy to expose.`);
  if (abil[0]) tendencies.push(`Brings ${(ABILITIES as any)[abil[0][0]]?.name} most often. Answer: ${(ABILITIES as any)[abil[0][0]]?.counter}`);
  const atk = sides.filter((s) => s.attacking);
  const def = sides.filter((s) => !s.attacking);
  const rate = (l: typeof sides) => (l.length ? Math.round((l.filter((s) => s.won).length / l.length) * 100) : null);
  return {
    name: p.name,
    battles: sides.length,
    attackWinRate: rate(atk),
    defenseWinRate: rate(def),
    orders: orders.map(([k, n]) => ({ order: (ORDERS as any)[k]?.name ?? k, n })),
    abilities: abil.map(([k, n]) => ({ ability: (ABILITIES as any)[k]?.name ?? k, n })),
    mix,
    tendencies,
    lastFormation: sides.length ? sides[sides.length - 1].side.slots.map((s: any) => (s.n ? { unit: UNIT_KEYS[s.unit], n: s.n } : null)) : null,
    sources: sides.slice(-6).reverse().map((s) => s.source),
  };
}

/** Indexer health for the board footer. */
export function indexStatus() {
  const s = store();
  return { events: s.events.length, cursor: s.cursor, backfilledAt: s.backfilledAt || null, supplyAt: s.supply?.at ?? null };
}
