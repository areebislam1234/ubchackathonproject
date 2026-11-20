// The SOL vault: move real (devnet) SOL from your wallet into the game, and earn Might automatically
// as SOL's price rises.
//
// Deposit: the server builds a transfer from your wallet to the game's vault with a memo naming the
// deposit; your wallet (Phantom, MetaMask, any Wallet Standard wallet, or the in-game wallet) signs
// it. The game checks the transaction on-chain before crediting it, once per signature.
// Growth → Might: every few seconds the vault is valued at Gemini's live SOL/USD price. Whenever its
// value reaches a new high (a high-water mark), the growth above the old high becomes Might, at the
// same rate as the Treasury: 100 Might per $1. A dip and recovery never pays twice, deposits never
// count as growth, and you never have to sell.
// Withdraw: the game sends SOL from the vault back to your verified wallet.
import crypto from "node:crypto";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getAddMemoInstruction, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from "@solana-program/memo";
import { ECONOMY } from "../shared/rules.js";
import { IS_LOCAL, NETWORK, env, explorerAddress, explorerTx } from "./config";
import { db, feed, type Player } from "./db";
import { GameError } from "./players";
import * as chain from "./chain/onchain";
import { getJson } from "./intel/http";
import { confirm, loadAuthority, rpc, send } from "./chain/solana";

const LAMPORTS = 1_000_000_000;
const MICRO = 1_000_000; // micro-USD
const SYSTEM = "11111111111111111111111111111111";
const MEMO_PROGRAMS = new Set([LEGACY_MEMO_PROGRAM_ADDRESS_V3 as string, "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", "Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH"]);
export const VAULT = {
  mightPerUsd: ECONOMY.mightPerUsdc, // 100 Might per $1 of growth, the same rate as converted yield
  minSol: 0.01,
  maxSol: 1000,
  tickMs: 10_000,
  reserveLamports: 10_000_000, // 0.01 SOL the vault account always keeps for network fees and rent
};

export type VaultEntry = { at: number; kind: "deposit" | "withdraw" | "withdraw-refund" | "growth"; lamports?: number; usd?: number; might?: number; price?: number; signature?: string; status?: "sending" | "sent" | "confirmed" | "failed"; error?: string; streamed?: boolean; nonce?: string };
export type Vault = {
  lamports: number; // SOL in the vault for this player
  hwm: number; // high-water mark of the vault's value, micro-USD
  mightEarned: number;
  pending: Record<string, { lamports: number; at: number; wallet: string }>; // prepared deposits by nonce
  ledger: VaultEntry[];
  claims?: Record<string, { at: number; response: unknown }>; // withdraw requestId → result
};
export const vaultOf = (p: Player): Vault => ((p as any).vault ??= { lamports: 0, hwm: 0, mightEarned: 0, pending: {}, ledger: [] });
const record = (v: Vault, e: Omit<VaultEntry, "at">) => {
  const entry = { at: Date.now(), ...e };
  v.ledger.push(entry);
  if (v.ledger.length > 200) v.ledger.splice(0, v.ledger.length - 200);
  return entry;
};
const sigs = () => ((db.data as any).vaultSigs ??= {}) as Record<string, string>;

// ── SOL/USD price (Gemini) ────────────────────────────────────────────
let devPrice: number | null = null; // dev tools: a fixed price for demos and tests
let last: { usd: number; at: number; source: "gemini" | "dev" } | null = null;
export async function solPrice() {
  if (devPrice !== null) return (last = { usd: devPrice, at: Date.now(), source: "dev" });
  try {
    const t: any = await getJson("https://api.gemini.com/v2/ticker/solusd", { ttlMs: 5000, timeoutMs: 6000 });
    const bid = Number(t.bid);
    const ask = Number(t.ask);
    const usd = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(t.close);
    if (usd > 0) return (last = { usd, at: Date.now(), source: "gemini" });
  } catch {
    /* fall through to the last known price */
  }
  return last;
}
export const lastPrice = () => last;
/** Dev tools: set a demo price (USD), nudge it by a percentage, or go back to Gemini's live price. */
export async function devSetPrice(body: { usd?: unknown; pct?: unknown; live?: unknown }) {
  if (body.live) devPrice = null;
  else if (body.usd !== undefined) devPrice = Math.max(0.01, Number(body.usd) || 0);
  else if (body.pct !== undefined) {
    const base = devPrice ?? (await solPrice())?.usd ?? 150;
    devPrice = Math.max(0.01, Math.round(base * (1 + Number(body.pct) / 100) * 100) / 100);
  }
  await accrueAll();
  return solPrice();
}

// ── Growth → Might ────────────────────────────────────────────────────
const valueOf = (lamports: number, usd: number) => Math.round((lamports / LAMPORTS) * usd * MICRO);

/** Pay Might for growth above the high-water mark. Returns the Might paid. */
export function accrue(p: Player, usd: number) {
  const v = vaultOf(p);
  if (!v.lamports) return 0;
  const value = valueOf(v.lamports, usd);
  if (value <= v.hwm) return 0;
  const might = Math.floor(((value - v.hwm) * VAULT.mightPerUsd) / MICRO);
  if (might < 1) return 0; // too small yet: the remainder keeps counting toward the next Might
  v.hwm += Math.round((might * MICRO) / VAULT.mightPerUsd);
  v.mightEarned += might;
  p.might = (p.might ?? 0) + might;
  chain.onVaultGrowth(p, might, Math.round((might * MICRO) / VAULT.mightPerUsd));
  // fold growth into one ledger line per minute instead of one per tick
  const lastE = v.ledger[v.ledger.length - 1];
  if (lastE?.kind === "growth" && Date.now() - lastE.at < 60_000) (lastE.might = (lastE.might ?? 0) + might), (lastE.price = usd);
  else record(v, { kind: "growth", might, price: usd });
  return might;
}

export async function accrueAll() {
  const price = await solPrice();
  if (!price) return;
  let total = 0;
  for (const p of Object.values(db.data.players)) {
    if (p.bot || !(p as any).vault?.lamports) continue;
    const m = accrue(p, price.usd);
    if (m >= 50) feed({ kind: "economy", text: `SOL rose to $${price.usd.toFixed(2)}: ${p.name}'s vault earned ${m} Might`, player: p.id });
    total += m;
  }
  if (total) db.save();
}
let lastTick = 0;
export async function vaultTick() {
  if (Date.now() - lastTick < VAULT.tickMs) return;
  lastTick = Date.now();
  await accrueAll();
}

// ── Deposit ───────────────────────────────────────────────────────────
async function vaultAddress() {
  const a = await loadAuthority();
  if (!a) throw new GameError("The game has no vault on this network yet. Run `npm run setup-solana` first.", 503);
  return a.address as string;
}
function signerWallet(p: Player) {
  const w = p.wallet;
  if (!w || w.kind === "address" || w.verified === false) throw new GameError("Link a wallet you can sign with first (Profile → Solana wallet): the in-game wallet, Phantom, MetaMask or another Solana wallet.");
  return w.address;
}
const memoFor = (p: Player, nonce: string) => `stakeclash:v1:vault:${p.id}:${nonce}`;

/** Build the unsigned transfer for the player's wallet to sign. */
export async function prepareDeposit(p: Player, sol: unknown) {
  const from = signerWallet(p);
  const amount = Number(sol);
  if (!(amount >= VAULT.minSol && amount <= VAULT.maxSol)) throw new GameError(`Deposit between ${VAULT.minSol} and ${VAULT.maxSol} SOL.`);
  const price = await solPrice();
  if (!price) throw new GameError("No SOL price from Gemini right now, so deposits are paused for a moment.", 503);
  const lamports = Math.round(amount * LAMPORTS);
  const vault = await vaultAddress();
  const nonce = crypto.randomBytes(6).toString("hex");
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const payer = createNoopSigner(address(from));
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(from), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: payer, destination: address(vault), amount: BigInt(lamports) }), getAddMemoInstruction({ memo: memoFor(p, nonce) }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 })], m),
  );
  const tx = getBase64EncodedWireTransaction(compileTransaction(msg));
  const v = vaultOf(p);
  v.pending[nonce] = { lamports, at: Date.now(), wallet: from };
  for (const [k, x] of Object.entries(v.pending)) if (Date.now() - x.at > 30 * 60_000) delete v.pending[k];
  db.save();
  return { tx, nonce, lamports, vault, from, chain: IS_LOCAL ? "solana:localnet" : "solana:devnet", network: NETWORK };
}

/** What a deposit transaction actually does: the SOL moved from `from` to `to`, and its memos. */
function readTransfer(bytes: Uint8Array) {
  const decoded = getTransactionDecoder().decode(bytes);
  const msg: any = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const keys: string[] = msg.staticAccounts.map(String);
  const transfers: { from: string; to: string; lamports: number }[] = [];
  const memos: string[] = [];
  for (const ix of msg.instructions) {
    const program = keys[ix.programAddressIndex];
    const data: Uint8Array = ix.data ?? new Uint8Array();
    const accts: number[] = ix.accountIndices ?? [];
    if (program === SYSTEM && data.length >= 12 && data[0] === 2 && data[1] === 0 && data[2] === 0 && data[3] === 0) {
      const lamports = Number(new DataView(data.buffer, data.byteOffset + 4, 8).getBigUint64(0, true));
      transfers.push({ from: keys[accts[0]], to: keys[accts[1]], lamports });
    } else if (MEMO_PROGRAMS.has(program)) memos.push(new TextDecoder().decode(data));
  }
  return { decoded, transfers, memos, feePayer: keys[0] };
}

/**
 * Credit a signed deposit: either the signed transaction (the game sends it) or the signature of a
 * transaction the wallet already sent. Checked against the chain before crediting, once.
 */
export async function submitDeposit(p: Player, body: { nonce?: unknown; tx?: unknown; signature?: unknown }) {
  const v = vaultOf(p);
  const nonce = String(body.nonce ?? "");
  const pending = v.pending[nonce];
  if (!pending) throw new GameError("That deposit has expired or was already credited. Start a new one.");
  const vault = await vaultAddress();
  let signature: string;
  let bytes: Uint8Array | null = null;
  if (typeof body.tx === "string" && body.tx) {
    bytes = Uint8Array.from(Buffer.from(body.tx, "base64"));
    const t = readTransfer(bytes);
    signature = getSignatureFromTransaction(t.decoded as any);
    check(p, t, pending, vault, nonce);
    if (sigs()[signature]) throw new GameError("That deposit was already credited.");
    try {
      await rpc.sendTransaction(body.tx as any, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    } catch (e) {
      const m = (e as Error).message;
      throw new GameError(/insufficient|0x1\b|debit an account/i.test(m) ? "Your wallet doesn't have enough SOL for that deposit and its fee." : `Solana refused the deposit: ${m.slice(0, 160)}`);
    }
  } else if (typeof body.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(body.signature)) {
    signature = body.signature;
    if (sigs()[signature]) throw new GameError("That deposit was already credited.");
  } else throw new GameError("Missing the signed deposit.");
  if (!(await confirm(signature, 90_000).catch((e) => Promise.reject(new GameError(`The deposit failed on-chain: ${(e as Error).message.slice(0, 120)}`))))) throw new GameError("The deposit hasn't confirmed yet. Try again in a moment.");
  if (!bytes) {
    // the wallet sent it: read it back from the chain
    const r: any = await rpc.getTransaction(signature as any, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" } as any).send();
    const raw = Array.isArray(r?.transaction) ? r.transaction[0] : null;
    if (!raw) throw new GameError("Couldn't read the deposit back from the chain yet. Try again in a moment.");
    if (r.meta?.err) throw new GameError("The deposit transaction failed on-chain.");
    bytes = Uint8Array.from(Buffer.from(raw, "base64"));
    check(p, readTransfer(bytes), pending, vault, nonce);
  }
  if (sigs()[signature]) throw new GameError("That deposit was already credited.");
  const t = readTransfer(bytes);
  const lamports = t.transfers.filter((x) => x.from === pending.wallet && x.to === vault).reduce((s, x) => s + x.lamports, 0);
  const price = (await solPrice()) ?? last;
  if (!price) throw new GameError("No SOL price right now. Your deposit is safe on-chain; try again in a moment.", 503);
  sigs()[signature] = p.id;
  delete v.pending[nonce];
  accrue(p, price.usd); // pay any growth earned before this deposit at the old size
  v.lamports += lamports;
  v.hwm += valueOf(lamports, price.usd); // new SOL enters at today's value: deposits are never growth
  record(v, { kind: "deposit", lamports, usd: valueOf(lamports, price.usd), price: price.usd, signature, status: "confirmed", nonce });
  feed({ kind: "economy", text: `${p.name} moved ${(lamports / LAMPORTS).toFixed(3)} SOL into the vault`, player: p.id, signature });
  db.save();
  return vaultView(p);
}

function check(p: Player, t: ReturnType<typeof readTransfer>, pending: { lamports: number; wallet: string }, vault: string, nonce: string) {
  if (t.feePayer !== pending.wallet) throw new GameError("That transaction was signed by a different wallet than the one linked to your warlord.");
  const moved = t.transfers.filter((x) => x.from === pending.wallet && x.to === vault).reduce((s, x) => s + x.lamports, 0);
  if (!moved) throw new GameError("That transaction doesn't send SOL to the vault.");
  if (!t.memos.includes(memoFor(p, nonce))) throw new GameError("That transaction isn't the deposit the game prepared.");
}

// ── Withdraw ──────────────────────────────────────────────────────────
export async function withdrawSol(p: Player, body: { sol?: unknown; requestId?: unknown }) {
  const rid = typeof body.requestId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.requestId) ? body.requestId : null;
  if (!rid) throw new GameError("Missing request id.");
  const v = vaultOf(p);
  v.claims ??= {};
  if (v.claims[rid]) return v.claims[rid].response;
  const to = signerWallet(p);
  const lamports = Math.round(Number(body.sol) * LAMPORTS);
  if (!(lamports > 0)) throw new GameError("Enter how much SOL to withdraw.");
  if (lamports > v.lamports) throw new GameError(`Your vault holds ${(v.lamports / LAMPORTS).toFixed(4)} SOL.`);
  // The vault is the game's own account, which also pays network fees: never send so much that it
  // can't cover the fee and stay rent-exempt. Explain how to top it up instead of failing on-chain.
  const authority = await loadAuthority();
  if (!authority) throw new GameError("The game has no vault on this network yet. Run `npm run setup-solana` first.", 503);
  const held = Number((await rpc.getBalance(authority.address, { commitment: "confirmed" }).send()).value);
  if (held - lamports < VAULT.reserveLamports)
    throw new GameError(
      `The game's vault account (${authority.address}) holds ${(held / LAMPORTS).toFixed(4)} SOL and needs to keep ${(VAULT.reserveLamports / LAMPORTS).toFixed(2)} SOL for network fees. Send it about 0.1 devnet SOL (from Phantom, or faucet.solana.com), then withdraw again. Your SOL is safe in your vault.`,
      503,
    );
  const price = await solPrice();
  if (price) accrue(p, price.usd); // settle growth up to now first
  // the high-water mark shrinks in proportion, so withdrawing never creates or destroys growth
  const hwmOut = Math.round((v.hwm * lamports) / v.lamports);
  v.lamports -= lamports;
  v.hwm -= hwmOut;
  const entry = record(v, { kind: "withdraw", lamports, price: price?.usd, status: "sending" });
  db.save();
  try {
    const sig = await send([getTransferSolInstruction({ source: authority, destination: address(to), amount: BigInt(lamports) }), getAddMemoInstruction({ memo: `stakeclash:v1:vault-out:${p.id}` }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 })]);
    entry.signature = sig;
    entry.status = "sent";
    db.save();
    await confirm(sig);
    entry.status = "confirmed";
    feed({ kind: "economy", text: `${p.name} withdrew ${(lamports / LAMPORTS).toFixed(3)} SOL from the vault`, player: p.id, signature: sig });
  } catch (e) {
    // put it back exactly as it was
    v.lamports += lamports;
    v.hwm += hwmOut;
    entry.status = "failed";
    entry.error = (e as Error).message.slice(0, 160);
    record(v, { kind: "withdraw-refund", lamports, status: "confirmed" });
    db.save();
    throw new GameError(`The withdrawal didn't go through, so your SOL stays in the vault: ${entry.error}`);
  }
  const response = vaultView(p);
  v.claims[rid] = { at: Date.now(), response };
  const keys = Object.keys(v.claims);
  if (keys.length > 30) for (const k of keys.sort((a, b) => v.claims![a].at - v.claims![b].at).slice(0, keys.length - 30)) delete v.claims[k];
  db.save();
  return response;
}

// ── Faucet (local chain; devnet when the RPC allows it) ───────────────
export async function airdrop(p: Player) {
  const to = signerWallet(p);
  try {
    const sig = await rpc.requestAirdrop(address(to), BigInt(2 * LAMPORTS) as any, { commitment: "confirmed" }).send();
    await confirm(sig as string, 60_000);
    return { ok: true, sol: 2, signature: sig };
  } catch (e) {
    throw new GameError(IS_LOCAL ? `Airdrop failed: ${(e as Error).message.slice(0, 120)}` : "This RPC endpoint doesn't hand out devnet SOL. Get some at faucet.solana.com, or switch Phantom to Devnet and use its faucet.", 503);
  }
}

// ── View ──────────────────────────────────────────────────────────────
export async function vaultView(p: Player) {
  const v = vaultOf(p);
  const price = await solPrice();
  if (price && accrue(p, price.usd)) db.save();
  const vault = await loadAuthority({ create: false });
  let walletLamports: number | null = null;
  if (p.wallet?.address) {
    try {
      walletLamports = Number((await rpc.getBalance(address(p.wallet.address), { commitment: "confirmed" }).send()).value);
    } catch {
      walletLamports = null;
    }
  }
  let vaultLamports: number | null = null;
  if (vault) {
    try {
      vaultLamports = Number((await rpc.getBalance(vault.address, { commitment: "confirmed" }).send()).value);
    } catch {
      vaultLamports = null;
    }
  }
  const value = price ? valueOf(v.lamports, price.usd) : null;
  // the SOL price the vault must pass to earn more Might
  const nextAt = v.lamports ? (v.hwm / MICRO / (v.lamports / LAMPORTS)) : null;
  return {
    network: NETWORK,
    chain: IS_LOCAL ? "solana:localnet" : "solana:devnet",
    vault: vault?.address ?? null,
    vaultExplorer: vault ? explorerAddress(vault.address) : null,
    vaultLamports,
    reserveLamports: VAULT.reserveLamports,
    wallet: p.wallet ? { address: p.wallet.address, kind: p.wallet.kind, label: p.wallet.label ?? null, verified: p.wallet.kind === "address" ? false : (p.wallet.verified ?? true) } : null,
    walletLamports,
    lamports: v.lamports,
    price,
    valueUsd: value,
    hwmUsd: v.hwm,
    highWaterPrice: nextAt,
    mightEarned: v.mightEarned,
    might: p.might ?? 0,
    mightPerUsd: VAULT.mightPerUsd,
    minSol: VAULT.minSol,
    ledger: v.ledger.slice(-40).reverse().map((e) => ({ ...e, explorer: e.signature ? explorerTx(e.signature) : null })),
    tickSeconds: VAULT.tickMs / 1000,
  };
}

/** For the HUD: the vault's SOL and value at the last known price. */
export function vaultSummary(p: Player) {
  const v = (p as any).vault as Vault | undefined;
  if (!v) return { lamports: 0, valueUsd: 0 };
  return { lamports: v.lamports, valueUsd: last ? valueOf(v.lamports, last.usd) : null };
}

/** The Stream saw a vault deposit memo: mark the ledger entry as seen on-chain by QuickNode. */
export function applyVaultMemo(parts: string[], signature: string) {
  const [playerId, nonce] = parts;
  const p = db.data.players[playerId];
  const e = p ? vaultOf(p).ledger.find((x) => x.signature === signature || (nonce && x.nonce === nonce)) : null;
  if (e) {
    e.streamed = true;
    db.save();
  }
}
void env;
