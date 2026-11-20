// Blockchain intelligence. Two QuickNode-backed sources, and nothing else:
//   1. Network samples the QuickNode Stream filter delivers to /webhooks/quicknode (one sampled
//      block every few seconds: transactions, failures, busiest programs, watched-token transfers).
//   2. The Solana RPC endpoint (SOLANA_RPC_URL, a QuickNode endpoint on devnet): throughput history,
//      epoch progress and fee pressure.
// Plus the game's own verified on-chain events, which also arrive through the Stream.
import { IS_LOCAL, NETWORK, solanaRpcUrl } from "../../config";
import { db } from "../../db";
import { rpcCall } from "../http";

const PROGRAM_NAMES: Record<string, string> = {
  Vote111111111111111111111111111111111111111: "Vote",
  "11111111111111111111111111111111": "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
};
const programName = (id: string) => PROGRAM_NAMES[id] ?? `${id.slice(0, 4)}…${id.slice(-4)}`;
export const networkLabel = () => (IS_LOCAL ? "local Solana chain" : `Solana ${NETWORK}`);

/** Throughput over the last ~30 minutes (one sample per minute), oldest first. */
export async function throughput() {
  const samples: any[] = await rpcCall(solanaRpcUrl, "getRecentPerformanceSamples", [30], { ttlMs: 60_000 });
  return samples
    .filter((s) => s.samplePeriodSecs > 0)
    .reverse()
    .map((s) => ({ slot: s.slot as number, tps: Math.round(s.numTransactions / s.samplePeriodSecs), nonVoteTps: s.numNonVoteTransactions !== undefined ? Math.round(s.numNonVoteTransactions / s.samplePeriodSecs) : null }));
}

export async function epoch() {
  const e: any = await rpcCall(solanaRpcUrl, "getEpochInfo", [], { ttlMs: 60_000 });
  return { epoch: e.epoch as number, progress: e.slotsInEpoch ? e.slotIndex / e.slotsInEpoch : 0, slot: e.absoluteSlot as number, txCount: (e.transactionCount as number | undefined) ?? null };
}

export async function fees() {
  const f: any[] = await rpcCall(solanaRpcUrl, "getRecentPrioritizationFees", [], { ttlMs: 60_000 });
  const v = f.map((x) => x.prioritizationFee as number).sort((a, b) => a - b);
  if (!v.length) return null;
  return { median: v[Math.floor(v.length / 2)], p90: v[Math.floor(v.length * 0.9)], nonzero: v.filter((x) => x > 0).length / v.length };
}

/** Summary of the sampled blocks the Stream has delivered recently. */
export function streamWindow(maxAgeMs = 2 * 3600_000) {
  const all = db.data.chain.network ?? [];
  const recent = all.filter((s) => Date.now() - s.receivedAt < maxAgeMs);
  if (!recent.length) return null;
  const tx = recent.reduce((s, x) => s + x.txCount, 0);
  const failed = recent.reduce((s, x) => s + x.failed, 0);
  const vote = recent.reduce((s, x) => s + x.vote, 0);
  const programs: Record<string, number> = {};
  for (const s of recent) for (const [p, n] of Object.entries(s.programs)) programs[p] = (programs[p] ?? 0) + n;
  const transfers: Record<string, { count: number; amount: number }> = {};
  for (const s of recent)
    for (const [m, t] of Object.entries(s.transfers)) {
      transfers[m] ??= { count: 0, amount: 0 };
      transfers[m].count += t.count;
      transfers[m].amount += t.amount;
    }
  return {
    blocks: recent.length,
    from: recent[0].slot,
    to: recent[recent.length - 1].slot,
    avgTx: Math.round(tx / recent.length),
    failRate: tx ? failed / tx : 0,
    voteShare: tx ? vote / tx : 0,
    topPrograms: Object.entries(programs)
      .filter(([p]) => p !== "Vote111111111111111111111111111111111111111")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([p, n]) => ({ name: programName(p), calls: n })),
    transfers,
    series: recent.slice(-24).map((s) => ({ label: String(s.slot), value: s.txCount })),
    lastAt: recent[recent.length - 1].receivedAt,
  };
}

/** The game's own transactions the Stream has confirmed (badges minted, standings sealed). */
export function gameActivity() {
  const ev = db.data.chain.events ?? [];
  const day = ev.filter((e) => Date.now() - e.receivedAt < 24 * 3600_000);
  const badges = day.filter((e) => e.memos.some((m) => m.includes(":badge:"))).length;
  const seals = day.filter((e) => e.memos.some((m) => m.includes(":result:"))).length;
  return { total: ev.length, day: day.length, badges, seals, deliveries: db.data.chain.deliveries };
}
