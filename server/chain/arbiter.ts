// The chain decides the battle. A fight is split in three: the game validates it, the Fortune Front
// program resolves it (its seed comes from SlotHashes, so nobody can pick it), and only then does the
// game apply the result. The game re-runs the same engine with the chain's seed (the Rust and
// JavaScript engines are identical), so the replay the player watches is exactly what was decided.
//
//   chain     the program resolves the battle; ~0.5–2 s
//   simulate  CHAIN_PROGRAM=simulate: behaves like the chain (delay, seed from a fake slot hash) for
//             testing the waiting flow without a cluster
//   local     program not deployed: the server rolls the seed and applies at once (synchronously)
import crypto from "node:crypto";
import { simulate } from "../../shared/battle.js";
import { UNIT_KEYS } from "../../shared/rules.js";
import { explorerTx } from "../config";
import { db, type BattleRecord, type Player } from "../db";
import { GameError } from "../players";
import { ingestTransaction } from "./indexer";
import { chainMode, enqueueAndWait, keyOf } from "./onchain";
import { eventsFromLogs, battleSide, BATTLE_KIND } from "./program";
import { rpc } from "./solana";

export type ChainInfo = { mode: "chain" | "simulate"; seed: number; signature: string; slot: number | null; url: string | null; engineMismatch?: boolean };
type Side = BattleRecord["attacker"] | BattleRecord["defender"];
export type BattleInput = {
  kind: "bounty" | "boss" | "duel" | "other";
  context: string;
  attacker: Side;
  defender: Side;
  /** humans on each side: their on-chain profiles are bound to the battle and their records updated */
  atkPlayer?: Player | null;
  defPlayer?: Player | null;
};
export type Decision = { seed: number; chain: ChainInfo | null; levels?: { attacker?: Record<string, number>; defender?: Record<string, number> } };

const TIMEOUT_MS = Number(process.env.CHAIN_BATTLE_TIMEOUT_MS ?? 12_000);
const SIM_DELAY_MS = Number(process.env.CHAIN_SIMULATE_DELAY_MS ?? 1500);
/** After this long the game gives up on the chain: nothing is applied and stakes are refunded. */
const DEADLINE_MS = Number(process.env.CHAIN_BATTLE_DEADLINE_MS ?? 90_000);

export const arbiterMode = (): "chain" | "simulate" | "local" => (process.env.CHAIN_PROGRAM === "simulate" ? "simulate" : chainMode().mode === "chain" ? "chain" : "local");

const human = (p?: Player | null) => (p && !p.bot ? p : null);

/** Ask the program to resolve the battle and read back its seed (chain or simulate mode). */
async function decideOnChain(input: BattleInput): Promise<Decision> {
  if (arbiterMode() === "simulate") {
    await new Promise((r) => setTimeout(r, SIM_DELAY_MS));
    // test switches for the failure paths: a transaction that fails, or one that never lands
    if (process.env.CHAIN_SIMULATE_FAIL === "fail") throw new GameError("The battle transaction failed on Solana. Nothing was applied; try again.");
    if (process.env.CHAIN_SIMULATE_FAIL === "hang") await new Promise(() => {});
    const fakeHash = crypto.randomBytes(32);
    const seq = ((db.data as any).simBattleSeq = ((db.data as any).simBattleSeq ?? 0) + 1);
    const seed = (fakeHash.readUInt32LE(0) ^ seq) >>> 0;
    return { seed, chain: { mode: "simulate", seed, signature: `sim-${crypto.randomBytes(8).toString("hex")}`, slot: null, url: null } };
  }
  const atk = human(input.atkPlayer);
  const def = human(input.defPlayer);
  const args = {
    kind: BATTLE_KIND[input.kind],
    context: input.context.slice(0, 40),
    attacker: battleSide(input.attacker),
    defender: battleSide(input.defender),
    atk: atk?.id ?? null,
    def: def?.id ?? null,
  };
  const sig = await enqueueAndWait("battle", args, atk?.id ?? def?.id);
  const tx = await rpc.getTransaction(sig as any, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }).send();
  if (!tx || tx.meta?.err) throw new GameError("The battle transaction failed on Solana. Nothing was applied; try again.");
  const logs = (tx.meta?.logMessages ?? []) as string[];
  ingestTransaction(sig, Number(tx.slot), tx.blockTime == null ? null : Number(tx.blockTime), logs);
  const ev = eventsFromLogs(logs).find((e) => e.name === "BattleResolved");
  if (!ev) throw new GameError("The battle transaction had no result. Nothing was applied; try again.");
  const toLevels = (arr: number[]) => Object.fromEntries(UNIT_KEYS.map((k, i) => [k, arr[i]]));
  return {
    seed: ev.data.seed,
    chain: { mode: "chain", seed: ev.data.seed, signature: sig, slot: Number(tx.slot), url: explorerTx(sig), ...{ result: ev.data } } as any,
    // the program binds player sides to their on-chain profile levels
    levels: { attacker: atk ? toLevels(ev.data.attacker_side.levels) : undefined, defender: def ? toLevels(ev.data.defender_side.levels) : undefined },
  };
}

/**
 * Check the game's engine against the chain's result for the same seed. They are the same engine,
 * so a mismatch means a bug; the chain's numbers would win, and the record is flagged.
 */
export function verifyAgainstChain(rec: BattleRecord) {
  const ev = (rec.chain as any)?.result;
  if (!ev) return true;
  const r = rec.result as any;
  const same = (r.winner === "attacker") === ev.attacker_won && r.score === ev.score && r.ticks === ev.ticks;
  if (!same) {
    rec.chain!.engineMismatch = true;
    console.error(`battle ${rec.id}: the game engine and the chain disagree (seed ${rec.seed})`);
  }
  delete (rec.chain as any).result; // keep the record small; the event stays in the index
  return same;
}

// ── Running a battle ──────────────────────────────────────────────────
const inFlight = new Set<string>();
type Pending = { id: string; player: string; status: "deciding" | "done" | "failed"; response?: unknown; error?: string; at: number };
const pending = new Map<string, Pending>();

export const battleInFlight = (playerId: string) => inFlight.has(playerId);

/**
 * Decide a battle, then apply it. In local mode this runs synchronously and returns apply's value.
 * Otherwise it waits for the chain; if that takes longer than the timeout the caller gets
 * `{ pending: id }` and the battle is applied when the chain answers (poll pendingBattle).
 * `apply` must re-check the game state (things can change while the chain decides) and throw a
 * GameError to cancel; `onCancel` undoes anything taken up front (for example a duel stake).
 */
export function runBattle<T>(input: BattleInput, apply: (d: Decision) => T, opts: { lockPlayer?: Player | null; onCancel?: (why: string) => void } = {}): T | Promise<T | { pending: string; deciding: true }> {
  const lock = opts.lockPlayer && !opts.lockPlayer.bot ? opts.lockPlayer.id : null;
  if (lock && inFlight.has(lock)) throw new GameError("Your last battle is still being decided on Solana. Give it a moment.", 409);
  if (arbiterMode() === "local") return apply({ seed: crypto.randomBytes(4).readUInt32LE(0), chain: null });

  if (lock) inFlight.add(lock);
  const id = `PB-${crypto.randomBytes(6).toString("hex")}`;
  let deadline: NodeJS.Timeout;
  const late = new Promise<never>((_, rej) => {
    deadline = setTimeout(() => rej(new GameError("Solana didn't decide this battle in time. Nothing was applied, and any stake is back with you. Try again.")), DEADLINE_MS);
  });
  // a decision that lands after the deadline is ignored: the race has already moved on
  const job = Promise.race([decideOnChain(input), late])
    .finally(() => clearTimeout(deadline))
    .then((d) => apply(d))
    .catch((e) => {
      opts.onCancel?.((e as Error).message);
      throw e;
    })
    .finally(() => lock && inFlight.delete(lock));
  const entry: Pending = { id, player: lock ?? input.atkPlayer?.id ?? "", status: "deciding", at: Date.now() };
  job.then(
    (response) => ((entry.status = "done"), (entry.response = response)),
    (e) => ((entry.status = "failed"), (entry.error = (e as Error).message)),
  );
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ pending: string; deciding: true }>((res) => {
    timer = setTimeout(() => {
      pending.set(id, entry);
      res({ pending: id, deciding: true });
    }, TIMEOUT_MS);
  });
  return Promise.race([job.finally(() => clearTimeout(timer)), timeout]);
}

/** A battle that took longer than the timeout: the client polls this until it is decided. */
export function pendingBattle(p: Player, id: string) {
  const e = pending.get(id);
  if (!e || e.player !== p.id) throw new GameError("No such battle.", 404);
  if (e.status !== "deciding") pending.delete(id);
  return { status: e.status, response: e.response ?? null, error: e.error ?? null };
}
// forget pending entries nobody collected after an hour
setInterval(() => {
  for (const [k, e] of pending) if (Date.now() - e.at > 3600_000) pending.delete(k);
}, 600_000).unref?.();

/** Put the chain's decision on a battle record, using the profile levels the program bound. */
export function stamp(rec: BattleRecord, d: Decision) {
  if (!d.chain) return rec;
  rec.chain = { ...d.chain };
  return rec;
}

/** Re-run the engine for a decision (the attacker/defender levels the chain used, if any). */
export function resultFor(attacker: Side, defender: Side, d: Decision) {
  if (d.levels?.attacker) attacker.levels = d.levels.attacker;
  if (d.levels?.defender) defender.levels = d.levels.defender;
  return simulate({ engine: 2, attacker: attacker as any, defender: defender as any, seed: d.seed }) as any;
}

void keyOf;
