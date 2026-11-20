// The bridge between the game and the Fortune Front program. Every action that moves Gold, Might or a
// stake, decides a battle or changes a warlord's loadout goes through here:
//
//   game action ──> queue (persisted) ──> program instruction ──> Solana ──> QuickNode ──> indexer
//
// The game applies an action at once and marks it pending, so it stays responsive. The queue sends
// it, retrying until confirmed. While the program isn't deployed yet (or CHAIN_PROGRAM=off), each
// action instead produces the exact event the program would emit, labelled "local", so the board,
// profiles and dossiers work before deployment and switch to on-chain data afterwards.
//
// Gold and Might are kept in step by a shadow ledger: what the chain holds for each player after
// every queued instruction. Explicit actions (upgrades, ability unlocks, stakes) adjust it; a
// settlement every 30 seconds mints or burns the remaining difference, netting many small changes.
import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { db, type BattleRecord, type Player } from "../db";
import { loadAuthority, rpc, send, confirm } from "./solana";
import * as P from "./program";
import { backfill, finalize, ingest, refreshSupply, watchMints } from "./indexer";

export type QueueItem = {
  id: number;
  op: string;
  args: any;
  player?: string;
  status: "queued" | "sent" | "confirmed" | "failed";
  tries: number;
  at: number;
  sig?: string;
  sentAt?: number;
  error?: string;
};

type Shadow = { gold: number; might: number; registered: boolean; growth?: { might: number; usd: number }; vaultYield?: number };
type OnchainState = {
  seq: number;
  queue: QueueItem[];
  shadow: Record<string, Shadow>;
  stakes: Record<string, { id: number; remaining: number; mint: "gold" | "might"; owner: string }>;
  stakeSeq: number;
  mints?: { gold: string; might: string } | null;
};

export function state(): OnchainState {
  const d = db.data as any;
  d.onchain ??= { seq: 0, queue: [], shadow: {}, stakes: {}, stakeSeq: 0, mints: null };
  return d.onchain;
}

// ── Mode ──────────────────────────────────────────────────────────────
let mode: "local" | "chain" = "local";
let modeReason = "the program is not deployed yet";
export const chainMode = () => ({ mode, reason: modeReason, program: P.PROGRAM_ID });

/** Chain mode when the program's config account exists on the cluster (and CHAIN_PROGRAM != off). */
export async function detectMode() {
  if (process.env.CHAIN_PROGRAM === "off") return setMode("local", "turned off (CHAIN_PROGRAM=off)");
  try {
    const cfg = await P.configPda();
    const { value } = await rpc.getAccountInfo(cfg, { encoding: "base64" }).send();
    if (!value || value.owner !== P.PROGRAM_ID) return setMode("local", "the program is not deployed yet");
    const data = Buffer.from(value.data[0], "base64");
    // Config: discriminator, authority, gold_mint, might_mint, ...
    const { value: c } = P.decode([["authority", "pubkey"], ["gold", "pubkey"], ["might", "pubkey"]], data, 8);
    state().mints = { gold: c.gold, might: c.might };
    const auth = await loadAuthority();
    if (!auth || auth.address !== c.authority) return setMode("local", "this server's key is not the program authority");
    setMode("chain", "program deployed");
  } catch (e) {
    setMode("local", `cluster unreachable (${(e as Error).message})`);
  }
}
function setMode(m: "local" | "chain", why: string) {
  if (m !== mode) console.log(`on-chain program: ${m} mode (${why})`);
  mode = m;
  modeReason = why;
}

// ── Queue ─────────────────────────────────────────────────────────────
const shadowOf = (pid: string) => (state().shadow[pid] ??= { gold: 0, might: 0, registered: false });
export const keyOf = (pid: string): Address => P.playerKey(pid);

/** Queue one program action and, in local mode, record the events it would emit. */
function enqueue(op: string, args: any, player: string | undefined, localEvents: P.ProgramEvent[]) {
  const s = state();
  const item: QueueItem = { id: ++s.seq, op, args, player, status: "queued", tries: 0, at: Date.now() };
  s.queue.push(item);
  if (s.queue.length > 2000) s.queue.splice(0, s.queue.length - 2000);
  if (mode === "local") {
    ingest(localEvents.map((e, i) => ({ ...e, key: `local:${item.id}:${i}`, signature: `local:${item.id}`, slot: null, blockTime: Math.floor(Date.now() / 1000), status: "local" as const })));
    item.status = "confirmed";
    item.sig = `local:${item.id}`;
  }
  db.save();
  kick();
  return item;
}

const V = 1;
function ensureRegistered(p: Player) {
  const sh = shadowOf(p.id);
  if (sh.registered) return;
  sh.registered = true;
  const wallet = keyOf(p.id);
  enqueue("register", { wallet }, p.id, [{ name: "PlayerRegistered", data: { v: V, wallet, profile: "", at: Math.floor(Date.now() / 1000) } }]);
}

// ── Hooks the game calls ──────────────────────────────────────────────
export function onRegister(p: Player) {
  if (p.bot) return;
  ensureRegistered(p);
}

export function onUnitUpgrade(p: Player, unit: string, level: number, goldCost: number) {
  if (p.bot) return;
  ensureRegistered(p);
  const sh = shadowOf(p.id);
  sh.gold -= goldCost;
  enqueue("upgrade", { unit: P.unitIndex(unit), goldCost }, p.id, [{ name: "UnitUpgraded", data: { v: V, wallet: keyOf(p.id), unit: P.unitIndex(unit), level, drills: p.drills?.units?.[unit] ?? 0, gold_spent: goldCost } }]);
}

export function onDrills(p: Player, unit: string, points: number) {
  if (p.bot || points <= 0) return;
  ensureRegistered(p);
  enqueue("drills", { unit: P.unitIndex(unit), points }, p.id, [{ name: "UnitUpgraded", data: { v: V, wallet: keyOf(p.id), unit: P.unitIndex(unit), level: p.unitLevels[unit] ?? 1, drills: p.drills?.units?.[unit] ?? points, gold_spent: 0 } }]);
}

export function onAbilityUnlock(p: Player, ability: string, cost: number) {
  if (p.bot) return;
  ensureRegistered(p);
  settle(p); // the burn needs the Might on-chain first (called before the game deducts the price)
  shadowOf(p.id).might -= cost;
  const w = keyOf(p.id);
  const a = P.abilityIndex(ability);
  enqueue("ability", { ability: a }, p.id, [
    { name: "MightBurned", data: { v: V, wallet: w, amount: cost, reason: 0 } },
    { name: "AbilityUnlocked", data: { v: V, wallet: w, ability: a, might_spent: cost } },
  ]);
}

export function onLoadout(p: Player, loadout: string[]) {
  if (p.bot) return;
  ensureRegistered(p);
  const l = loadout.map(P.abilityIndex);
  const pair = [l[0] ?? P.NO_ABILITY, l[1] ?? P.NO_ABILITY];
  enqueue("loadout", { loadout: pair }, p.id, [{ name: "LoadoutSet", data: { v: V, wallet: keyOf(p.id), loadout: pair } }]);
}

export function onFormation(p: Player, f: { slots: ({ unit: string; n: number } | null)[]; order: string }) {
  if (p.bot) return;
  ensureRegistered(p);
  const formation = f.slots.map((s) => (s ? { unit: P.unitIndex(s.unit), n: s.n } : { unit: 0, n: 0 }));
  const order = P.orderIndex(f.order);
  enqueue("formation", { formation, order }, p.id, [{ name: "FormationSet", data: { v: V, wallet: keyOf(p.id), formation, order } }]);
}

export function onYieldConverted(p: Player, usdc: number, might: number) {
  if (p.bot) return;
  ensureRegistered(p);
  shadowOf(p.id).might += might;
  const realized = (p.funds?.converted ?? 0) + (shadowOf(p.id).vaultYield ?? 0);
  const w = keyOf(p.id);
  enqueue("convert", { usdc, might }, p.id, [
    { name: "MightMinted", data: { v: V, wallet: w, amount: might, reason: 0 } },
    { name: "YieldConverted", data: { v: V, wallet: w, usdc, might, realized_total: realized } },
  ]);
}

/**
 * SOL vault growth turned into Might (it accrues every price tick). Collected here and settled every
 * 30 seconds as one yield conversion, instead of a transaction per tick.
 */
export function onVaultGrowth(p: Player, might: number, usdMicro: number) {
  if (p.bot || might <= 0) return;
  const sh = shadowOf(p.id);
  sh.growth ??= { might: 0, usd: 0 };
  sh.growth.might += might;
  sh.growth.usd += usdMicro;
}

/**
 * Lock a player's Might (or Gold) in the vault for a duel or bounty. `key` names the stake. Call it
 * right after the game took the amount from the player's balance.
 */
export function onStake(p: Player, key: string, amount: number, memo: string, mint: "might" | "gold" = "might") {
  if (p.bot || amount <= 0) return;
  ensureRegistered(p);
  // the game already took the stake: settle as if it hadn't, so the chain holds it before escrow
  settle(p, mint === "might" ? amount : 0, mint === "gold" ? amount : 0);
  const s = state();
  const id = ++s.stakeSeq;
  s.stakes[key] = { id, remaining: amount, mint, owner: p.id };
  shadowOf(p.id)[mint] -= amount;
  enqueue("stake", { id, amount, memo, mint }, p.id, [{ name: "Escrowed", data: { v: V, stake: id, wallet: keyOf(p.id), mint: mint === "gold" ? "Gold" : "Might", amount, memo } }]);
}

/** Pay part of a stake to a player and burn part of it. */
export function onRelease(key: string, to: Player | null, pay: number, burn: number, memo: string) {
  const st = state().stakes[key];
  if (!st) return;
  pay = Math.max(0, Math.min(pay, st.remaining));
  burn = Math.max(0, Math.min(burn, st.remaining - pay));
  if (!pay && !burn) return;
  st.remaining -= pay + burn;
  const recipient = to && !to.bot ? to : (db.data.players[st.owner] ?? null);
  if (!recipient) return;
  if (pay) shadowOf(recipient.id)[st.mint] += pay;
  const events: P.ProgramEvent[] = [];
  if (pay) events.push({ name: "RewardPaid", data: { v: V, wallet: keyOf(recipient.id), mint: st.mint === "gold" ? "Gold" : "Might", amount: pay, memo } });
  if (burn && st.mint === "might") events.push({ name: "MightBurned", data: { v: V, wallet: keyOf(st.owner), amount: burn, reason: 1 } });
  events.push({ name: "Released", data: { v: V, stake: st.id, amount: pay, burned: burn } });
  enqueue("release", { id: st.id, to: recipient.id, pay, burn, memo, mint: st.mint }, recipient.id, events);
  if (st.remaining <= 0) delete state().stakes[key];
}
/**
 * Pay and burn from a pot made of several stakes (a duel: challenger then rival), in order. Any part
 * not backed by an on-chain stake (a rival warlord's side) is minted by the next settlement.
 */
export function releaseFromPot(keys: string[], to: Player | null, pay: number, burn: number, memo: string) {
  for (const k of keys) {
    const left = stakeRemaining(k);
    if (!left) continue;
    const p1 = Math.min(left, pay);
    const b1 = Math.min(left - p1, burn);
    onRelease(k, to, p1, b1, memo);
    pay -= p1;
    burn -= b1;
  }
}
export const stakeRemaining = (key: string) => state().stakes[key]?.remaining ?? 0;

/** A battle the game fought, resolved by the program too (engine 2 records only). */
export function onBattle(rec: BattleRecord, kind: "bounty" | "boss" | "duel" | "other") {
  if (rec.engine !== 2) return;
  if (rec.chain?.mode === "chain") return; // resolved by the program itself (the arbiter)
  const atkP = db.data.players[rec.attacker.id];
  const defP = db.data.players[rec.defender.id];
  const atkKey = atkP && !atkP.bot ? (ensureRegistered(atkP), keyOf(atkP.id)) : null;
  const defKey = defP && !defP.bot ? (ensureRegistered(defP), keyOf(defP.id)) : null;
  if (!atkKey && !defKey) return; // rival warlords fighting each other stay off-chain
  const attacker = P.battleSide(rec.attacker);
  const defender = P.battleSide(rec.defender);
  const r = rec.result as any;
  const context = (rec.bounty ?? rec.id).slice(0, 40);
  const lostArr = ["infantry", "archer", "tank", "cavalry", "siege", "support"].map((k) => r.lost?.[k] ?? 0);
  const local: P.ProgramEvent = {
    name: "BattleResolved",
    data: {
      v: V, seq: 0, kind: P.BATTLE_KIND[kind], context, attacker: atkKey ?? NO_KEY, defender: defKey ?? NO_KEY, seed: rec.seed,
      attacker_side: attacker, defender_side: defender, attacker_won: r.winner === "attacker", ticks: r.ticks,
      destruction_pm: Math.round(r.destruction * 10), survival_pm: Math.round(r.survival * 10), score: r.score, lost: lostArr,
      // game-side ids so the indexer can join (not part of the on-chain event)
      battleId: rec.id, attackerName: rec.attacker.name, defenderName: rec.defender.name,
    },
  };
  enqueue("battle", { kind: P.BATTLE_KIND[kind], context, attacker, defender, atk: atkP && !atkP.bot ? atkP.id : null, def: defP && !defP.bot ? defP.id : null, battleId: rec.id }, atkP?.id, [local]);
}
const NO_KEY = "11111111111111111111111111111111";

/** Net Gold and Might into the chain: mint or burn the difference from the shadow ledger. */
export function settle(p: Player, mightOffset = 0, goldOffset = 0) {
  if (p.bot) return;
  const sh = shadowOf(p.id);
  if (!sh.registered) return;
  const w = keyOf(p.id);
  const dg = Math.floor(p.gold) + goldOffset - sh.gold;
  if (dg !== 0) {
    sh.gold += dg;
    enqueue("gold", { delta: dg, reason: "net" }, p.id, [{ name: "GoldSettled", data: { v: V, wallet: w, delta: dg, balance: sh.gold, reason: sh.gold === dg ? "migration" : "net" } }]);
  }
  // vault growth since the last settlement goes on-chain as realized yield, not as a generic mint
  if (sh.growth && sh.growth.might > 0) {
    const g = sh.growth;
    sh.growth = { might: 0, usd: 0 };
    sh.might += g.might;
    sh.vaultYield = (sh.vaultYield ?? 0) + g.usd;
    enqueue("convert", { usdc: g.usd, might: g.might }, p.id, [
      { name: "MightMinted", data: { v: V, wallet: w, amount: g.might, reason: 0 } },
      { name: "YieldConverted", data: { v: V, wallet: w, usdc: g.usd, might: g.might, realized_total: (p.funds?.converted ?? 0) + sh.vaultYield } },
    ]);
  }
  const dm = Math.floor(p.might ?? 0) + mightOffset - sh.might;
  if (dm > 0) {
    sh.might += dm;
    enqueue("might", { amount: dm, reason: 3 }, p.id, [{ name: "MightMinted", data: { v: V, wallet: w, amount: dm, reason: sh.might === dm ? 2 : 3 } }]);
  } else if (dm < 0) {
    // Might left the game outside an explicit action (a refund correction or dev tool): burn it
    sh.might += dm;
    enqueue("mightburn", { amount: -dm, reason: 2 }, p.id, [{ name: "MightBurned", data: { v: V, wallet: w, amount: -dm, reason: 2 } }]);
  }
}

/** Every 30 seconds: settle every registered player's net Gold and Might. */
export function settleAll() {
  for (const p of Object.values(db.data.players)) if (!p.bot) {
    ensureRegistered(p);
    settle(p);
  }
}

// ── Sender ────────────────────────────────────────────────────────────
const waiters = new Map<number, { resolve: (sig: string) => void; reject: (e: Error) => void }>();

/** Queue an instruction and wait until it is confirmed (keeps queue order). Resolves with its signature. */
export function enqueueAndWait(op: string, args: any, player: string | undefined): Promise<string> {
  const s = state();
  const item: QueueItem = { id: ++s.seq, op, args, player, status: "queued", tries: 0, at: Date.now() };
  s.queue.push(item);
  db.save();
  const p = new Promise<string>((resolve, reject) => waiters.set(item.id, { resolve, reject }));
  kick();
  return p;
}
function settleWaiter(item: QueueItem) {
  const w = waiters.get(item.id);
  if (!w) return;
  if (item.status === "confirmed") (waiters.delete(item.id), w.resolve(item.sig!));
  else if (item.status === "failed") (waiters.delete(item.id), w.reject(new Error(item.error ?? "transaction failed")));
}

let running = false;
function kick() {
  if (mode !== "chain" || running) return;
  running = true;
  drain()
    .catch((e) => console.warn(`on-chain sender: ${(e as Error)?.message ?? e}`))
    .finally(() => (running = false));
}

async function drain() {
  const s = state();
  const auth = await loadAuthority();
  if (!auth || !s.mints) return;
  const mints = { gold: s.mints.gold as Address, might: s.mints.might as Address };
  for (const item of s.queue) {
    if (item.status === "confirmed" || item.status === "failed") continue;
    if (mode !== "chain") return;
    try {
      // Sent before but not confirmed yet: never send it again blindly (a battle or a Gold settlement
      // would run twice). Look it up; resend only once its blockhash has surely expired.
      if (item.status === "sent" && item.sig) {
        const { value } = await rpc.getSignatureStatuses([item.sig as any], { searchTransactionHistory: true }).send();
        const st = value[0];
        if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          item.status = "confirmed";
          settleWaiter(item);
          db.save();
          continue;
        }
        if (!st && Date.now() - (item.sentAt ?? 0) < 90_000) return; // may still land: wait
        if (st && !st.err) return; // processed, not confirmed yet
        item.status = "queued"; // failed or expired: safe to send again
      }
      const ix = await build(item, auth.address, mints);
      if (!ix) {
        item.status = "confirmed";
        continue;
      }
      item.tries++;
      item.status = "sent";
      item.sentAt = Date.now();
      item.sig = await send(ix);
      db.save();
      if (await confirm(item.sig)) item.status = "confirmed";
      else return; // not confirmed yet: stays "sent" and is looked up on the next pass
    } catch (e) {
      item.error = (e as Error).message.slice(0, 200);
      item.status = item.tries >= 5 ? "failed" : "queued";
      if (item.status === "failed") console.warn(`on-chain ${item.op} #${item.id} failed: ${item.error}`);
      settleWaiter(item);
      db.save();
      return; // keep order: try again on the next tick
    }
    settleWaiter(item);
    db.save();
  }
}

async function build(item: QueueItem, a: Address, m: P.Mints) {
  const w = item.player ? keyOf(item.player) : null;
  const x = item.args;
  switch (item.op) {
    case "register": return [await P.registerPlayerIx(a, m, x.wallet)];
    case "gold": return x.delta ? [await P.settleGoldIx(a, m, w!, x.delta, x.reason)] : null;
    case "mightburn": return [await P.burnMightIx(a, m, w!, x.amount, x.reason)];
    case "might": return [await P.mintMightIx(a, m, w!, x.amount, x.reason)];
    case "upgrade": return [await P.upgradeUnitIx(a, m, w!, x.unit, x.goldCost)];
    case "drills": return [await P.assignDrillsIx(a, w!, x.unit, x.points)];
    case "ability": return [await P.unlockAbilityIx(a, m, w!, x.ability)];
    case "loadout": return [await P.setLoadoutIx(a, w!, x.loadout)];
    case "formation": return [await P.setFormationIx(a, w!, x.formation, x.order)];
    case "convert": return [await P.convertYieldIx(a, m, w!, x.usdc, x.might)];
    case "stake": return [await P.escrowStakeIx(a, x.mint === "gold" ? m.gold : m.might, x.mint === "gold", w!, x.id, x.amount, x.memo)];
    case "release": return [await P.releaseStakeIx(a, x.mint === "gold" ? m.gold : m.might, x.mint === "gold", x.id, keyOf(x.to), x.pay, x.burn, x.memo)];
    case "battle": return [P.computeUnitLimitIx(1_400_000), await P.resolveBattleIx(a, x.kind, x.context, x.attacker, x.defender, x.atk ? keyOf(x.atk) : null, x.def ? keyOf(x.def) : null)];
  }
  return null;
}

/** Queue health for /api/chain/status and the board footer. */
export function queueStatus() {
  const q = state().queue;
  const by = (s: QueueItem["status"]) => q.filter((i) => i.status === s).length;
  return { ...chainMode(), queued: by("queued") + by("sent"), confirmed: by("confirmed"), failed: by("failed"), recentFailures: q.filter((i) => i.status === "failed").slice(-5).map((i) => ({ op: i.op, error: i.error })) };
}

/** Chain mode only: QuickNode RPC backfill, finality and supply, plus the WebSocket mint watch. */
let unwatch: (() => void) | null = null;
async function indexTick() {
  if (mode !== "chain") return;
  const s = state();
  try {
    await backfill();
    await finalize();
    await refreshSupply(s.mints);
    if (!unwatch && s.mints) unwatch = await watchMints(s.mints, () => (unwatch = null));
  } catch (e) {
    console.warn(`indexer: ${(e as Error).message}`);
  }
}

/** Start: detect the mode, settle every 30 s, keep the queue moving, index the chain. */
export function startOnchain() {
  void detectMode().then(() => {
    settleAll();
    kick();
    void indexTick();
  });
  setInterval(() => void indexTick(), 60_000).unref?.();
  setInterval(() => {
    settleAll();
    kick();
  }, 30_000).unref?.();
  setInterval(() => kick(), 3_000).unref?.(); // keeps sent-but-unconfirmed items moving
  setInterval(() => void detectMode().then(kick), 5 * 60_000).unref?.();
}

export const stakeKey = (...parts: string[]) => createHash("sha1").update(parts.join(":")).digest("hex").slice(0, 16);
