// Handles QuickNode Streams deliveries: verified, de-duplicated by transaction signature, then
// applied to the game (badges confirmed on-chain, bounty results sealed, badge holdings tracked).
import { BADGES } from "../../shared/rules.js";
import { db, feed, type ChainEvent, type NetworkSample } from "../db";
import { badgeMints, MEMO_PREFIX } from "./solana";
import { confirmWithdrawal, creditDeposit } from "../funds";
import { applyDuelMemo } from "../colosseum";
import { applyVaultMemo } from "../vault";

export type StreamEvent = {
  signature: string;
  slot: number;
  blockTime: number | null;
  memos: string[];
  badges: { mint: string; owner: string; pre: number; post: number }[];
  deposits?: { from: string | null; amount: number; keys: string[] }[]; // USDC into the game, in base units (micro-USDC)
};

/** Accepts the filter's output: { events: [...] }, a batch array of those, or a bare event list. */
export function extractEvents(body: unknown): StreamEvent[] {
  const out: StreamEvent[] = [];
  const visit = (x: any) => {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(visit);
    if (Array.isArray(x.events)) return x.events.forEach(visit);
    if (typeof x.signature === "string" && Array.isArray(x.memos)) out.push(x);
  };
  visit(body);
  return out;
}

/** Network samples from the filter's output ({ events, network: [...] }, or a batch of those). */
export function extractNetwork(body: unknown): Omit<NetworkSample, "receivedAt">[] {
  const out: Omit<NetworkSample, "receivedAt">[] = [];
  const visit = (x: any) => {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(visit);
    if (Array.isArray(x.network)) for (const n of x.network) if (Number.isInteger(n?.slot) && Number.isFinite(n?.txCount)) out.push(n);
  };
  visit(body);
  return out;
}

/** Keep a rolling window of sampled blocks, one per slot (redeliveries are ignored). */
export function applyNetwork(samples: Omit<NetworkSample, "receivedAt">[]) {
  if (!samples.length) return 0;
  const list = (db.data.chain.network ??= []);
  const have = new Set(list.map((s) => s.slot));
  let added = 0;
  for (const s of samples) {
    if (have.has(s.slot)) continue;
    have.add(s.slot);
    list.push({ slot: s.slot, blockTime: s.blockTime ?? null, txCount: s.txCount, failed: s.failed ?? 0, vote: s.vote ?? 0, programs: s.programs ?? {}, transfers: s.transfers ?? {}, receivedAt: Date.now() });
    added++;
  }
  list.sort((a, b) => a.slot - b.slot);
  if (list.length > 500) list.splice(0, list.length - 500);
  db.save();
  return added;
}

export function applyEvents(events: StreamEvent[]) {
  const chain = db.data.chain;
  chain.deliveries++;
  let applied = 0;
  const mintToBadge = Object.fromEntries(Object.entries(badgeMints()).map(([id, m]) => [m, id]));
  for (const e of events) {
    if (chain.processed[e.signature]) continue; // duplicate or redelivery
    chain.processed[e.signature] = Date.now();
    const rec: ChainEvent = { signature: e.signature, slot: e.slot, blockTime: e.blockTime, memos: e.memos, badges: e.badges, receivedAt: Date.now() };
    // USDC deposits: credited once, here, after the webhook's signature check and this dedupe
    for (const d of e.deposits ?? []) if (d.amount > 0 && Number.isInteger(d.amount)) creditDeposit({ signature: e.signature, from: d.from ?? "", usdc: d.amount, refs: Array.isArray(d.keys) ? d.keys.map(String) : [] });
    chain.events.push(rec);
    applied++;
    for (const m of e.memos) {
      const parts = m.split(":");
      if (`${parts[0]}:${parts[1]}` !== MEMO_PREFIX) continue;
      if (parts[2] === "badge") {
        const [badge, playerId] = [parts[3], parts.slice(4).join(":")];
        const p = db.data.players[playerId];
        const st = p?.badges[badge];
        if (st) {
          st.status = "onchain";
          st.signature = e.signature;
          feed({ kind: "chain", text: `Solana: ${p.name}'s ${(BADGES as any)[badge]?.name ?? badge} badge confirmed (slot ${e.slot})`, signature: e.signature, player: p.id });
        }
      } else if (parts[2] === "vault") {
        applyVaultMemo(parts.slice(3), e.signature); // SOL vault deposits, seen on-chain by the Stream
      } else if (parts[2] === "call" || parts[2] === "duel") {
        applyDuelMemo(parts[2], parts.slice(3), e.signature, e.slot); // Colosseum odds receipts and results
      } else if (parts[2] === "withdraw") {
        confirmWithdrawal(e.signature);
      } else if (parts[2] === "result") {
        const [bountyId, hash] = [parts[3], parts[4]];
        const b = db.data.bounties[bountyId];
        if (b?.results) {
          b.results.seal = { signature: e.signature, status: "onchain" };
          (b.results.seal as any).verified = hash === b.results.hash;
          feed({ kind: "chain", text: `Solana: ${bountyId} standings sealed (slot ${e.slot})`, signature: e.signature, bounty: bountyId });
        }
      }
    }
    for (const c of e.badges) {
      if (!mintToBadge[c.mint]) continue;
      const h = (chain.holdings[c.owner] ??= {});
      h[c.mint] = c.post;
      if (c.post < c.pre) feed({ kind: "chain", text: `Solana: a ${(BADGES as any)[mintToBadge[c.mint]]?.name} badge left ${c.owner.slice(0, 4)}…${c.owner.slice(-4)}`, signature: e.signature });
    }
  }
  // keep the processed-signature index bounded
  const sigs = Object.keys(chain.processed);
  if (sigs.length > 5000) for (const s of sigs.slice(0, sigs.length - 5000)) delete chain.processed[s];
  db.save();
  return applied;
}
