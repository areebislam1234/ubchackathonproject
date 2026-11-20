// The Vault: a player's crypto portfolio inside the game.
//
// Deposit (real, on-chain): SOL, USDC or any Solana token moves from your wallet to the game's vault
// account. The server builds the transfer with a memo naming the deposit; your wallet (Phantom,
// MetaMask, any Wallet Standard wallet, or the in-game wallet) signs it. The game checks the
// confirmed transaction before crediting it, once per signature, and QuickNode Streams marks it seen.
//
// Trade (game ledger): swap any priced holding for any coin Gemini prices in USD, at the live bid and
// ask, backed by what you deposited. Real on-chain swaps can replace the ledger on mainnet later.
//
// Might rewards smart trading:
//   realized profit: 100 Might per $1, once you pass your best realized result so far (a loss has to
//                    be won back first, so churning can't farm it; buys at the ask, sells at the bid)
//   holding:         25 Might per $1 a holding gains above its own high-water mark (a dip and
//                    recovery never pays twice; deposits and buys are never growth)
//
// Withdraw: SOL, USDC and deposited tokens go back to your verified wallet. Coins held only on the
// ledger are sold first.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import { getAddMemoInstruction, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from "@solana-program/memo";
import * as TK from "@solana-program/token";
import * as T22 from "@solana-program/token-2022";
import { ECONOMY, PORTFOLIO } from "../shared/rules.js";
import { IS_LOCAL, NETWORK, env, explorerAddress, explorerTx, networkDataDir } from "./config";
import { db, feed, type Player } from "./db";
import { GameError } from "./players";
import * as chain from "./chain/onchain";
import { getJson } from "./intel/http";
import { confirm, loadAuthority, rpc, send } from "./chain/solana";
import { usdcMint } from "./chain/usdc";

const LAMPORTS = 1_000_000_000;
const MICRO = 1_000_000; // micro-USD
const SYSTEM = "11111111111111111111111111111111";
const MEMO_PROGRAMS = new Set([LEGACY_MEMO_PROGRAM_ADDRESS_V3 as string, "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", "Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH"]);
export const VAULT = {
  mightPerUsd: PORTFOLIO.hodlMightPerUsd, // holding growth
  realizedMightPerUsd: PORTFOLIO.realizedMightPerUsd, // trading profit
  minSol: 0.01,
  maxSol: 1000,
  tickMs: 10_000,
  reserveLamports: 10_000_000, // 0.01 SOL the vault account always keeps for network fees and rent
};

// ── State ─────────────────────────────────────────────────────────────
/** One holding. `raw` is integer base units (SOL lamports, token base units, ledger coins at 8 dp). */
export type Holding = { raw: number; decimals: number; cost: number; hwm: number; mint?: string };
export type VaultEntry = {
  at: number;
  kind: "deposit" | "withdraw" | "withdraw-refund" | "growth" | "trade" | "profit" | "migrated";
  asset?: string;
  qty?: number;
  lamports?: number; // SOL entries, for older screens and tests
  usd?: number;
  might?: number;
  price?: number;
  from?: string;
  to?: string;
  toQty?: number;
  realized?: number;
  signature?: string;
  status?: "sending" | "sent" | "confirmed" | "failed";
  error?: string;
  streamed?: boolean;
  nonce?: string;
};
type Pending = { kind?: "sol" | "token"; raw?: number; lamports?: number; mint?: string; decimals?: number; tokenProgram?: string; at: number; wallet: string };
export type Vault = {
  holdings: Record<string, Holding>;
  realized: number; // cumulative realized trading P&L, micro-USD
  realizedPeak: number; // the realized P&L that Might has been paid up to
  mightTrading: number;
  mightHodl: number;
  pending: Record<string, Pending>;
  ledger: VaultEntry[];
  claims?: Record<string, { at: number; response: unknown }>; // trade / withdraw requestId → result
  // legacy SOL-only fields (kept so old saves load; migrated into holdings)
  lamports?: number;
  hwm?: number;
  mightEarned?: number;
};

const record = (v: Vault, e: Omit<VaultEntry, "at">) => {
  const entry = { at: Date.now(), ...e } as VaultEntry;
  v.ledger.push(entry);
  if (v.ledger.length > 300) v.ledger.splice(0, v.ledger.length - 300);
  return entry;
};
const sigs = () => ((db.data as any).vaultSigs ??= {}) as Record<string, string>;
/** True if this deposit signature has already been credited (by the vault or the Treasury link). */
export const depositCredited = (signature: string) => !!sigs()[signature];

/** The player's vault, migrating the old SOL-only vault and the old USDC Treasury once. */
export function vaultOf(p: Player): Vault {
  const v: Vault = ((p as any).vault ??= { holdings: {}, realized: 0, realizedPeak: 0, mightTrading: 0, mightHodl: 0, pending: {}, ledger: [] });
  if (!v.holdings) {
    v.holdings = {};
    v.realized = 0;
    v.realizedPeak = 0;
    v.mightTrading = 0;
    v.mightHodl = v.mightEarned ?? 0;
    v.pending = {};
    v.ledger ??= [];
    if ((v.lamports ?? 0) > 0) v.holdings.SOL = { raw: v.lamports!, decimals: 9, cost: v.hwm ?? 0, hwm: v.hwm ?? 0, mint: "native" };
    delete v.lamports;
    delete v.hwm;
  }
  // the old USDC Treasury: its cash and coins move into the vault (its history stays in the Treasury)
  const f = p.funds;
  if (f && !(f as any).movedToVault) {
    (f as any).movedToVault = Date.now();
    if (f.cash > 0) {
      addTo(v, "USDC", f.cash, 6, f.cash, usdcMint() ?? undefined);
      record(v, { kind: "migrated", asset: "USDC", qty: f.cash / MICRO, usd: f.cash });
      f.cash = 0;
    }
    for (const [coin, pos] of Object.entries(f.positions ?? {})) {
      if (!(pos.qty > 0)) continue;
      const raw = Math.round(pos.qty * 10 ** PORTFOLIO.ledgerDecimals);
      addTo(v, coin, raw, PORTFOLIO.ledgerDecimals, pos.cost);
      record(v, { kind: "migrated", asset: coin, qty: pos.qty, usd: pos.cost });
    }
    f.positions = {};
  }
  return v;
}
function addTo(v: Vault, asset: string, raw: number, decimals: number, entryValue: number, mint?: string) {
  const h = (v.holdings[asset] ??= { raw: 0, decimals, cost: 0, hwm: 0, ...(mint ? { mint } : {}) });
  if (h.decimals !== decimals) {
    // keep one precision per holding
    raw = Math.round((raw * 10 ** h.decimals) / 10 ** decimals);
  }
  h.raw += raw;
  h.cost += entryValue;
  h.hwm += entryValue; // new money enters at today's value: deposits and buys are never growth
  if (!Number.isSafeInteger(h.raw)) throw new GameError("That amount is too large to hold.");
  return h;
}
const qtyOf = (h: Holding) => h.raw / 10 ** h.decimals;

// ── Prices (Gemini) ───────────────────────────────────────────────────
export type Px = { bid: number; ask: number; mid: number; open24h: number | null; at: number; source: "gemini" | "dev" | "stable" };
const devPrices = new Map<string, number>(); // dev tools: fixed prices for demos and tests
const lastPx = new Map<string, Px>();
const isStable = (sym: string) => (PORTFOLIO.stable as string[]).includes(sym);
const priced = (asset: string) => !asset.startsWith("mint:");

export async function priceOf(sym: string): Promise<Px | null> {
  sym = sym.toUpperCase();
  if (isStable(sym)) return { bid: 1, ask: 1, mid: 1, open24h: 1, at: Date.now(), source: "stable" };
  const dev = devPrices.get(sym);
  if (dev !== undefined) {
    const px: Px = { bid: dev, ask: dev, mid: dev, open24h: null, at: Date.now(), source: "dev" };
    lastPx.set(sym, px);
    return px;
  }
  try {
    const t: any = await getJson(`https://api.gemini.com/v2/ticker/${sym.toLowerCase()}usd`, { ttlMs: 5000, timeoutMs: 6000 });
    const bid = Number(t.bid);
    const ask = Number(t.ask);
    const close = Number(t.close);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : close;
    if (mid > 0) {
      const px: Px = { bid: bid > 0 ? bid : mid, ask: ask > 0 ? ask : mid, mid, open24h: Number(t.open) || null, at: Date.now(), source: "gemini" };
      lastPx.set(sym, px);
      return px;
    }
  } catch {
    /* fall through to the last known price */
  }
  return lastPx.get(sym) ?? null;
}
const cached = (sym: string) => (isStable(sym) ? ({ bid: 1, ask: 1, mid: 1, open24h: 1, at: Date.now(), source: "stable" } as Px) : (lastPx.get(sym) ?? null));

/** The SOL price (kept for the HUD, older screens and tests). */
export async function solPrice() {
  const px = await priceOf("SOL");
  return px ? { usd: px.mid, at: px.at, source: px.source === "dev" ? ("dev" as const) : ("gemini" as const) } : null;
}
export const lastPrice = () => {
  const px = lastPx.get("SOL");
  return px ? { usd: px.mid, at: px.at, source: px.source } : null;
};

/** Dev tools: set a demo price for a coin (SOL by default), nudge it by a percentage, or go back to live. */
export async function devSetPrice(body: { coin?: unknown; usd?: unknown; pct?: unknown; live?: unknown }) {
  const sym = typeof body.coin === "string" && /^[A-Za-z0-9]{1,12}$/.test(body.coin) ? body.coin.toUpperCase() : "SOL";
  if (body.live) {
    if (body.coin) devPrices.delete(sym);
    else devPrices.clear();
  } else if (body.usd !== undefined) devPrices.set(sym, Math.max(0.000001, Number(body.usd) || 0));
  else if (body.pct !== undefined) {
    const base = devPrices.get(sym) ?? (await priceOf(sym))?.mid ?? 100;
    devPrices.set(sym, Math.max(0.000001, Math.round(base * (1 + Number(body.pct) / 100) * 1e6) / 1e6));
  }
  await accrueAll();
  return sym === "SOL" ? solPrice() : priceOf(sym);
}

/** Every coin Gemini prices in USD (cached for an hour), for the Trade tab. */
let coinCache: { at: number; list: string[] } | null = null;
export async function coinList(): Promise<string[]> {
  if (coinCache && Date.now() - coinCache.at < 3600_000) return coinCache.list;
  try {
    const syms: string[] = (await getJson("https://api.gemini.com/v1/symbols", { ttlMs: 3600_000, timeoutMs: 8000 })) as any;
    const bases = syms
      .map((s) => String(s).toLowerCase())
      .filter((s) => s.endsWith("usd") && !s.endsWith("gusd") && !s.endsWith("rlusd") && !s.endsWith("dusd"))
      .map((s) => s.slice(0, -3).toUpperCase())
      .filter((b) => b && !isStable(b) && /^[A-Z0-9]{1,12}$/.test(b));
    const list = [...new Set(["SOL", ...ECONOMY.coins, ...bases])].sort((a, b) => (a === "SOL" ? -1 : b === "SOL" ? 1 : a.localeCompare(b)));
    coinCache = { at: Date.now(), list };
    return list;
  } catch {
    return coinCache?.list ?? ["SOL", ...ECONOMY.coins.filter((c) => c !== "SOL")];
  }
}

/** Quotes for many coins at once (for the Trade tab). */
export async function quotesFor(symbols: string[]) {
  const out = await Promise.all(symbols.slice(0, 400).map(async (s) => [s, await priceOf(s).catch(() => null)] as const));
  return Object.fromEntries(out.filter(([, q]) => q).map(([s, q]) => [s, { bid: q!.bid, ask: q!.ask, mid: q!.mid, open24h: q!.open24h, source: q!.source }]));
}

const valueOf = (h: Holding, mid: number) => Math.round(qtyOf(h) * mid * MICRO);

// ── Holding growth → Might (25 per $1 above each holding's high-water mark) ──
/** Pay Might for every priced holding above its high-water mark, at the last known prices. */
export function accrue(p: Player) {
  const v = vaultOf(p);
  let paid = 0;
  for (const [asset, h] of Object.entries(v.holdings)) {
    if (!h.raw || !priced(asset) || isStable(asset)) continue;
    const px = cached(asset);
    if (!px) continue;
    const value = valueOf(h, px.mid);
    if (value <= h.hwm) continue;
    const might = Math.floor(((value - h.hwm) * VAULT.mightPerUsd) / MICRO);
    if (might < 1) continue; // too small yet: the remainder keeps counting toward the next Might
    h.hwm += Math.round((might * MICRO) / VAULT.mightPerUsd);
    paid += might;
    // fold growth into one ledger line per minute per coin instead of one per tick
    const lastE = [...v.ledger].reverse().find((e) => e.kind === "growth" && e.asset === asset);
    if (lastE && Date.now() - lastE.at < 60_000) (lastE.might = (lastE.might ?? 0) + might), (lastE.price = px.mid);
    else record(v, { kind: "growth", asset, might, price: px.mid });
  }
  if (paid) {
    v.mightHodl += paid;
    p.might = (p.might ?? 0) + paid;
    chain.onVaultGrowth(p, paid, Math.round((paid * MICRO) / VAULT.mightPerUsd));
  }
  return paid;
}

export async function accrueAll() {
  const players = Object.values(db.data.players).filter((p) => !p.bot && (p as any).vault);
  const syms = new Set<string>();
  for (const p of players) for (const [a, h] of Object.entries(vaultOf(p).holdings)) if (h.raw && priced(a) && !isStable(a)) syms.add(a);
  await Promise.all([...syms].map((s) => priceOf(s).catch(() => null)));
  let total = 0;
  for (const p of players) {
    const m = accrue(p);
    if (m >= 50) feed({ kind: "economy", text: `New highs: ${p.name}'s holdings earned ${m} Might`, player: p.id });
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

// ── Trading (game ledger, live Gemini prices) ─────────────────────────
function claimed(v: Vault, requestId: unknown) {
  const rid = typeof requestId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(requestId) ? requestId : null;
  if (!rid) throw new GameError("Missing request id.");
  v.claims ??= {};
  return { rid, prev: v.claims[rid]?.response };
}
function remember(v: Vault, rid: string, response: unknown) {
  v.claims ??= {};
  v.claims[rid] = { at: Date.now(), response };
  const keys = Object.keys(v.claims);
  if (keys.length > 40) for (const k of keys.sort((a, b) => v.claims![a].at - v.claims![b].at).slice(0, keys.length - 40)) delete v.claims[k];
  return response;
}
const decimalsFor = (asset: string) => (asset === "SOL" ? 9 : asset === "USDC" ? 6 : PORTFOLIO.ledgerDecimals);

/**
 * Swap `amount` of one holding into another coin at live prices: sold at the bid, bought at the ask
 * (through USDC). Realized profit above your best result so far pays Might.
 */
export async function trade(p: Player, body: { from?: unknown; to?: unknown; amount?: unknown; requestId?: unknown }) {
  const v = vaultOf(p);
  const { rid, prev } = claimed(v, body.requestId);
  if (prev) return prev;
  const from = String(body.from ?? "").toUpperCase();
  const to = String(body.to ?? "").toUpperCase();
  if (!from || !to || from === to) throw new GameError("Pick two different coins.");
  if (!priced(from) || !priced(to)) throw new GameError("That token has no live price, so it can't be traded. You can still withdraw it.");
  const h = v.holdings[from];
  if (!h?.raw) throw new GameError(`You don't hold any ${from}.`);
  const amount = Number(body.amount);
  if (!(amount > 0)) throw new GameError("Enter an amount to trade.");
  const rawOut = Math.min(h.raw, Math.round(amount * 10 ** h.decimals));
  if (rawOut <= 0) throw new GameError("That amount is too small.");
  if (rawOut > h.raw || amount > qtyOf(h) * 1.0000001) throw new GameError(`You hold ${qtyOf(h)} ${from}.`);
  if (to !== "USDC" && !(await coinList()).includes(to)) throw new GameError(`${to} isn't a coin Gemini prices in USD.`);
  const [pf, pt] = await Promise.all([priceOf(from), priceOf(to)]);
  if (!pf || !pt) throw new GameError("No live price right now. Try again in a moment.", 503);
  // sell
  const fraction = rawOut / h.raw;
  const costOut = Math.round(h.cost * fraction);
  const hwmOut = Math.round(h.hwm * fraction);
  const proceeds = Math.round((rawOut / 10 ** h.decimals) * pf.bid * MICRO);
  if (proceeds < PORTFOLIO.minTradeUsd * MICRO) throw new GameError(`Trade at least $${PORTFOLIO.minTradeUsd}.`);
  const realized = isStable(from) ? 0 : proceeds - costOut;
  // buy
  const toDec = v.holdings[to]?.decimals ?? decimalsFor(to);
  const rawIn = Math.floor(((proceeds / MICRO) / pt.ask) * 10 ** toDec);
  if (rawIn <= 0) throw new GameError("That's too little to buy any of it.");
  h.raw -= rawOut;
  h.cost -= costOut;
  h.hwm -= hwmOut;
  if (!h.raw && from !== "SOL" && from !== "USDC") delete v.holdings[from];
  addTo(v, to, rawIn, toDec, proceeds, to === "USDC" ? (usdcMint() ?? undefined) : to === "SOL" ? "native" : undefined);
  // realized profit → Might (only above the best realized result so far)
  v.realized += realized;
  let might = 0;
  if (v.realized > v.realizedPeak) {
    might = Math.floor(((v.realized - v.realizedPeak) * VAULT.realizedMightPerUsd) / MICRO);
    if (might >= 1) {
      v.realizedPeak += Math.round((might * MICRO) / VAULT.realizedMightPerUsd);
      v.mightTrading += might;
      p.might = (p.might ?? 0) + might;
      chain.onYieldConverted(p, Math.round((might * MICRO) / VAULT.realizedMightPerUsd), might);
    } else might = 0;
  }
  const qOut = rawOut / 10 ** h.decimals;
  const qIn = rawIn / 10 ** toDec;
  record(v, { kind: "trade", from, to, qty: qOut, toQty: qIn, price: pf.bid, usd: proceeds, realized, might: might || undefined });
  if (might >= 100) feed({ kind: "economy", text: `${p.name} took profit on ${from} and earned ${might} Might`, player: p.id });
  db.save();
  return remember(v, rid, { trade: { from, to, sold: qOut, bought: qIn, priceFrom: pf.bid, priceTo: pt.ask, usd: proceeds, realized, might }, vault: await vaultView(p) });
}

// ── Deposits ──────────────────────────────────────────────────────────
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
/** The asset a token mint is held as: its known symbol, or `mint:<address>` (unpriced). */
export function assetForMint(mint: string) {
  if (mint === usdcMint()) return "USDC";
  return (PORTFOLIO.mints as Record<string, string>)[mint] ?? `mint:${mint}`;
}

async function unsignedFor(from: string, ixs: Instruction[]) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(from), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}
function keepPending(v: Vault, nonce: string, x: Pending) {
  v.pending[nonce] = x;
  for (const [k, y] of Object.entries(v.pending)) if (Date.now() - y.at > 30 * 60_000) delete v.pending[k];
  db.save();
}

/** Build the unsigned SOL transfer for the player's wallet to sign. */
export async function prepareDeposit(p: Player, sol: unknown) {
  const from = signerWallet(p);
  const amount = Number(sol);
  if (!(amount >= VAULT.minSol && amount <= VAULT.maxSol)) throw new GameError(`Deposit between ${VAULT.minSol} and ${VAULT.maxSol} SOL.`);
  const price = await solPrice();
  if (!price) throw new GameError("No SOL price from Gemini right now, so deposits are paused for a moment.", 503);
  const lamports = Math.round(amount * LAMPORTS);
  const vault = await vaultAddress();
  const nonce = crypto.randomBytes(6).toString("hex");
  const tx = await unsignedFor(from, [getTransferSolInstruction({ source: createNoopSigner(address(from)), destination: address(vault), amount: BigInt(lamports) }), getAddMemoInstruction({ memo: memoFor(p, nonce) }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 })]);
  keepPending(vaultOf(p), nonce, { kind: "sol", lamports, raw: lamports, at: Date.now(), wallet: from });
  return { tx, nonce, lamports, vault, from, asset: "SOL", chain: IS_LOCAL ? "solana:localnet" : "solana:devnet", network: NETWORK };
}

/** A token mint's decimals and token program (Token or Token-2022). */
async function mintInfo(mint: string) {
  const { value } = await rpc.getAccountInfo(address(mint), { encoding: "jsonParsed" }).send();
  const owner = String(value?.owner ?? "");
  const decimals = (value?.data as any)?.parsed?.info?.decimals;
  if (!value || (owner !== TK.TOKEN_PROGRAM_ADDRESS && owner !== T22.TOKEN_2022_PROGRAM_ADDRESS) || typeof decimals !== "number") throw new GameError("That isn't a token mint on this network.");
  return { decimals, tokenProgram: owner };
}
const ataOf = async (owner: string, mint: string, tokenProgram: string) => (await TK.findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(tokenProgram) }))[0];

/** The tokens in the player's linked wallet (for the Deposit tab), read through QuickNode RPC. */
export async function walletTokens(p: Player) {
  const w = p.wallet?.address;
  if (!w) return [];
  const out: { mint: string; asset: string; amount: number; decimals: number }[] = [];
  for (const programId of [TK.TOKEN_PROGRAM_ADDRESS, T22.TOKEN_2022_PROGRAM_ADDRESS]) {
    try {
      const { value } = await rpc.getTokenAccountsByOwner(address(w), { programId }, { encoding: "jsonParsed" }).send();
      for (const a of value as any[]) {
        const info = a.account?.data?.parsed?.info;
        const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (info?.mint && amt > 0) out.push({ mint: info.mint, asset: assetForMint(info.mint), amount: amt, decimals: info.tokenAmount.decimals });
      }
    } catch {
      /* this RPC may not support Token-2022 lookups; skip */
    }
  }
  return out;
}

/** Build the unsigned token transfer (any SPL or Token-2022 token) for the player's wallet to sign. */
export async function prepareTokenDeposit(p: Player, body: { mint?: unknown; amount?: unknown }) {
  const from = signerWallet(p);
  const mint = String(body.mint ?? "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new GameError("Pick a token to deposit.");
  const amount = Number(body.amount);
  if (!(amount > 0)) throw new GameError("Enter how much to deposit.");
  const { decimals, tokenProgram } = await mintInfo(mint);
  const raw = Math.round(amount * 10 ** decimals);
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new GameError("That amount isn't valid for this token.");
  const vault = await vaultAddress();
  const source = await ataOf(from, mint, tokenProgram);
  const dest = await ataOf(vault, mint, tokenProgram);
  try {
    const { value } = await rpc.getTokenAccountBalance(source).send();
    if (Number(value.amount) < raw) throw new GameError(`Your wallet holds ${value.uiAmountString ?? Number(value.amount) / 10 ** decimals} of that token.`);
  } catch (e) {
    if (e instanceof GameError) throw e;
    throw new GameError("Your wallet doesn't hold that token.");
  }
  const payer = createNoopSigner(address(from));
  const lib: any = tokenProgram === T22.TOKEN_2022_PROGRAM_ADDRESS ? T22 : TK;
  const nonce = crypto.randomBytes(6).toString("hex");
  const tx = await unsignedFor(from, [
    lib.getCreateAssociatedTokenIdempotentInstruction({ payer, ata: dest, owner: address(vault), mint: address(mint), tokenProgram: address(tokenProgram) }),
    lib.getTransferCheckedInstruction({ source, mint: address(mint), destination: dest, authority: payer, amount: BigInt(raw), decimals }, { programAddress: address(tokenProgram) }),
    getAddMemoInstruction({ memo: memoFor(p, nonce) }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 }),
  ]);
  keepPending(vaultOf(p), nonce, { kind: "token", raw, mint, decimals, tokenProgram, at: Date.now(), wallet: from });
  return { tx, nonce, raw, mint, asset: assetForMint(mint), decimals, vault, from, chain: IS_LOCAL ? "solana:localnet" : "solana:devnet", network: NETWORK };
}

/** What a SOL deposit transaction does: the SOL moved from `from` to `to`, and its memos. */
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
 * Credit a signed deposit (SOL or token): either the signed transaction (the game sends it) or the
 * signature of a transaction the wallet already sent. Checked against the chain before crediting, once.
 */
export async function submitDeposit(p: Player, body: { nonce?: unknown; tx?: unknown; signature?: unknown }) {
  const v = vaultOf(p);
  const nonce = String(body.nonce ?? "");
  const pending = v.pending[nonce];
  if (!pending) throw new GameError("That deposit has expired or was already credited. Start a new one.");
  const vault = await vaultAddress();
  const isToken = pending.kind === "token";
  let signature: string;
  let bytes: Uint8Array | null = null;
  if (typeof body.tx === "string" && body.tx) {
    bytes = Uint8Array.from(Buffer.from(body.tx, "base64"));
    const t = readTransfer(bytes);
    signature = getSignatureFromTransaction(t.decoded as any);
    if (t.feePayer !== pending.wallet) throw new GameError("That transaction was signed by a different wallet than the one linked to your warlord.");
    if (!t.memos.includes(memoFor(p, nonce))) throw new GameError("That transaction isn't the deposit the game prepared.");
    if (!isToken) check(p, t, pending, vault, nonce);
    if (sigs()[signature]) throw new GameError("That deposit was already credited.");
    try {
      await rpc.sendTransaction(body.tx as any, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    } catch (e) {
      const m = (e as Error).message;
      throw new GameError(/insufficient|0x1\b|debit an account/i.test(m) ? "Your wallet doesn't have enough for that deposit and its fee." : `Solana refused the deposit: ${m.slice(0, 160)}`);
    }
  } else if (typeof body.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(body.signature)) {
    signature = body.signature;
    if (sigs()[signature]) throw new GameError("That deposit was already credited.");
  } else throw new GameError("Missing the signed deposit.");
  if (!(await confirm(signature, 90_000).catch((e) => Promise.reject(new GameError(`The deposit failed on-chain: ${(e as Error).message.slice(0, 120)}`))))) throw new GameError("The deposit hasn't confirmed yet. Try again in a moment.");
  if (isToken) return creditTokenDeposit(p, v, nonce, pending, signature, vault);
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
  const price = await priceOf("SOL");
  if (!price) throw new GameError("No SOL price right now. Your deposit is safe on-chain; try again in a moment.", 503);
  sigs()[signature] = p.id;
  delete v.pending[nonce];
  accrue(p); // pay any growth earned before this deposit at the old size
  const usd = Math.round((lamports / LAMPORTS) * price.mid * MICRO);
  addTo(v, "SOL", lamports, 9, usd, "native");
  record(v, { kind: "deposit", asset: "SOL", qty: lamports / LAMPORTS, lamports, usd, price: price.mid, signature, status: "confirmed", nonce });
  feed({ kind: "economy", text: `${p.name} moved ${(lamports / LAMPORTS).toFixed(3)} SOL into the vault`, player: p.id, signature });
  db.save();
  return vaultView(p);
}

/** A token deposit: credit exactly what the vault's token account gained in that transaction. */
async function creditTokenDeposit(p: Player, v: Vault, nonce: string, pending: Pending, signature: string, vault: string) {
  const r: any = await rpc.getTransaction(signature as any, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" } as any).send();
  if (!r) throw new GameError("Couldn't read the deposit back from the chain yet. Try again in a moment.");
  if (r.meta?.err) throw new GameError("The deposit transaction failed on-chain.");
  const keys: any[] = r.transaction?.message?.accountKeys ?? [];
  const payer = typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey;
  if (payer !== pending.wallet) throw new GameError("That transaction was signed by a different wallet than the one linked to your warlord.");
  const logs: string[] = r.meta?.logMessages ?? [];
  const ixMemos = (r.transaction?.message?.instructions ?? []).filter((i: any) => i.program === "spl-memo").map((i: any) => i.parsed);
  if (!ixMemos.includes(memoFor(p, nonce)) && !logs.some((l) => l.includes(memoFor(p, nonce)))) throw new GameError("That transaction isn't the deposit the game prepared.");
  const sum = (list: any[]) => list.filter((b) => b.mint === pending.mint && b.owner === vault).reduce((s, b) => s + Number(b.uiTokenAmount?.amount ?? 0), 0);
  const gained = sum(r.meta?.postTokenBalances ?? []) - sum(r.meta?.preTokenBalances ?? []);
  if (!(gained > 0)) throw new GameError("That transaction doesn't send the token to the vault.");
  if (sigs()[signature]) throw new GameError("That deposit was already credited.");
  sigs()[signature] = p.id;
  delete v.pending[nonce];
  const asset = assetForMint(pending.mint!);
  const px = priced(asset) ? await priceOf(asset) : null;
  const qty = gained / 10 ** pending.decimals!;
  const usd = px ? Math.round(qty * px.mid * MICRO) : 0;
  accrue(p);
  addTo(v, asset, gained, pending.decimals!, usd, pending.mint);
  record(v, { kind: "deposit", asset, qty, usd: px ? usd : undefined, price: px?.mid, signature, status: "confirmed", nonce });
  feed({ kind: "economy", text: `${p.name} deposited ${qty} ${asset.startsWith("mint:") ? "tokens" : asset} into the vault`, player: p.id, signature });
  db.save();
  return vaultView(p);
}

function check(p: Player, t: ReturnType<typeof readTransfer>, pending: Pending, vault: string, nonce: string) {
  if (t.feePayer !== pending.wallet) throw new GameError("That transaction was signed by a different wallet than the one linked to your warlord.");
  const moved = t.transfers.filter((x) => x.from === pending.wallet && x.to === vault).reduce((s, x) => s + x.lamports, 0);
  if (!moved) throw new GameError("That transaction doesn't send SOL to the vault.");
  if (!t.memos.includes(memoFor(p, nonce))) throw new GameError("That transaction isn't the deposit the game prepared.");
}

/** USDC that reached the game another way (a Solana Pay link the Stream matched to this player). */
export function creditUsdc(p: Player, micro: number, signature: string) {
  if (sigs()[signature]) return false;
  sigs()[signature] = p.id;
  const v = vaultOf(p);
  addTo(v, "USDC", micro, 6, micro, usdcMint() ?? undefined);
  record(v, { kind: "deposit", asset: "USDC", qty: micro / MICRO, usd: micro, price: 1, signature, status: "confirmed", streamed: true });
  db.save();
  return true;
}
/** Dev tools: add test USDC to the vault without a chain transfer. */
export function devCreditUsdc(p: Player, micro: number) {
  const v = vaultOf(p);
  addTo(v, "USDC", micro, 6, micro, usdcMint() ?? undefined);
  record(v, { kind: "deposit", asset: "USDC", qty: micro / MICRO, usd: micro, price: 1, status: "confirmed" });
  db.save();
}

// ── Withdraw ──────────────────────────────────────────────────────────
export async function withdrawSol(p: Player, body: { sol?: unknown; requestId?: unknown }) {
  return withdraw(p, { asset: "SOL", amount: body.sol, requestId: body.requestId });
}

/** Send SOL, USDC or a deposited token back to the player's verified wallet. */
export async function withdraw(p: Player, body: { asset?: unknown; amount?: unknown; requestId?: unknown }) {
  const v = vaultOf(p);
  const { rid, prev } = claimed(v, body.requestId);
  if (prev) return prev;
  const to = signerWallet(p);
  const asset = String(body.asset ?? "SOL").startsWith("mint:") ? String(body.asset) : String(body.asset ?? "SOL").toUpperCase();
  const h = v.holdings[asset];
  if (!h?.raw) throw new GameError(`Your vault holds no ${asset}.`);
  if (!h.mint) throw new GameError(`${asset} is held on the game ledger only. Sell it for SOL or USDC first, then withdraw that.`);
  const raw = Math.round(Number(body.amount) * 10 ** h.decimals);
  if (!(raw > 0)) throw new GameError("Enter how much to withdraw.");
  if (raw > h.raw) throw new GameError(`Your vault holds ${qtyOf(h)} ${asset}.`);
  const authority = await loadAuthority();
  if (!authority) throw new GameError("The game has no vault on this network yet. Run `npm run setup-solana` first.", 503);
  const isSol = asset === "SOL";
  let ixs: Instruction[];
  if (isSol) {
    // The vault is the game's own account, which also pays network fees: never send so much that it
    // can't cover the fee and stay rent-exempt. Explain how to top it up instead of failing on-chain.
    const held = Number((await rpc.getBalance(authority.address, { commitment: "confirmed" }).send()).value);
    if (held - raw < VAULT.reserveLamports)
      throw new GameError(
        `The game's vault account (${authority.address}) holds ${(held / LAMPORTS).toFixed(4)} SOL and needs to keep ${(VAULT.reserveLamports / LAMPORTS).toFixed(2)} SOL for network fees. Send it about 0.1 devnet SOL (from Phantom, or faucet.solana.com), then withdraw again. Your SOL is safe in your vault.`,
        503,
      );
    ixs = [getTransferSolInstruction({ source: authority, destination: address(to), amount: BigInt(raw) })];
  } else {
    const { decimals, tokenProgram } = await mintInfo(h.mint);
    const lib: any = tokenProgram === T22.TOKEN_2022_PROGRAM_ADDRESS ? T22 : TK;
    const source = await ataOf(authority.address, h.mint, tokenProgram);
    const dest = await ataOf(to, h.mint, tokenProgram);
    let held = 0;
    try {
      held = Number((await rpc.getTokenAccountBalance(source).send()).value.amount);
    } catch {
      held = 0;
    }
    if (held < raw) throw new GameError(`The game's vault holds only ${held / 10 ** decimals} ${asset} on-chain right now (it backs trades with test funds). Your balance is safe; try a smaller amount or withdraw SOL.`, 503);
    ixs = [
      lib.getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: dest, owner: address(to), mint: address(h.mint), tokenProgram: address(tokenProgram) }),
      lib.getTransferCheckedInstruction({ source, mint: address(h.mint), destination: dest, authority, amount: BigInt(raw), decimals }, { programAddress: address(tokenProgram) }),
    ];
  }
  if (await priceOf("SOL")) accrue(p); // settle growth up to now first
  // cost and high-water mark shrink in proportion, so withdrawing never creates or destroys growth
  const fraction = raw / h.raw;
  const costOut = Math.round(h.cost * fraction);
  const hwmOut = Math.round(h.hwm * fraction);
  h.raw -= raw;
  h.cost -= costOut;
  h.hwm -= hwmOut;
  const entry = record(v, { kind: "withdraw", asset, qty: raw / 10 ** h.decimals, ...(isSol ? { lamports: raw } : {}), status: "sending" });
  db.save();
  try {
    const sig = await send([...ixs, getAddMemoInstruction({ memo: `stakeclash:v1:vault-out:${p.id}` }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 })]);
    entry.signature = sig;
    entry.status = "sent";
    db.save();
    await confirm(sig);
    entry.status = "confirmed";
    feed({ kind: "economy", text: `${p.name} withdrew ${raw / 10 ** h.decimals} ${asset.startsWith("mint:") ? "tokens" : asset} from the vault`, player: p.id, signature: sig });
  } catch (e) {
    // put it back exactly as it was
    h.raw += raw;
    h.cost += costOut;
    h.hwm += hwmOut;
    entry.status = "failed";
    entry.error = (e as Error).message.slice(0, 160);
    record(v, { kind: "withdraw-refund", asset, qty: raw / 10 ** h.decimals, ...(isSol ? { lamports: raw } : {}), status: "confirmed" });
    db.save();
    throw new GameError(`The withdrawal didn't go through, so it stays in your vault: ${entry.error}`);
  }
  const response = await vaultView(p);
  remember(v, rid, response);
  db.save();
  return response;
}

// ── Faucets and dev tools ─────────────────────────────────────────────
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

/**
 * Dev tools: create a test token on this network (once) and send 1,000 to the player's wallet, to show
 * that any Solana token can be deposited. It has no market price, so it shows as unpriced.
 */
export async function devTestToken(p: Player) {
  const to = signerWallet(p);
  const payer = await loadAuthority();
  if (!payer) throw new GameError("No game authority key. Run `npm run setup-solana` first.", 503);
  const file = path.join(networkDataDir, "test-token.json");
  let mint: string;
  const instructions: Instruction[] = [];
  if (fs.existsSync(file)) mint = JSON.parse(fs.readFileSync(file, "utf8")).mint;
  else {
    const kp = await generateKeyPairSigner();
    mint = kp.address;
    const space = BigInt(TK.getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    instructions.push(getCreateAccountInstruction({ payer, newAccount: kp, lamports: rent, space, programAddress: TK.TOKEN_PROGRAM_ADDRESS }), TK.getInitializeMint2Instruction({ mint: kp.address, decimals: 6, mintAuthority: payer.address }));
    fs.writeFileSync(file, JSON.stringify({ mint }, null, 2));
  }
  const ata = await ataOf(to, mint, TK.TOKEN_PROGRAM_ADDRESS);
  instructions.push(TK.getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner: address(to), mint: address(mint) }), TK.getMintToInstruction({ mint: address(mint), token: ata, mintAuthority: payer, amount: 1000n * 10n ** 6n }));
  try {
    const sig = await send(instructions);
    await confirm(sig, 60_000);
    return { mint, amount: 1000, signature: sig };
  } catch (e) {
    if (!fs.existsSync(file) || instructions.length > 2) fs.rmSync(file, { force: true });
    throw new GameError(`Couldn't create the test token: ${(e as Error).message.slice(0, 140)}. The game authority needs a little devnet SOL.`, 503);
  }
}

// ── View ──────────────────────────────────────────────────────────────
export async function vaultView(p: Player) {
  const v = vaultOf(p);
  await Promise.all(Object.keys(v.holdings).filter(priced).map((a) => priceOf(a).catch(() => null)));
  if (accrue(p)) db.save();
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
  const holdings = Object.entries(v.holdings)
    .filter(([, h]) => h.raw > 0)
    .map(([asset, h]) => {
      const px = priced(asset) ? cached(asset) : null;
      const value = px ? valueOf(h, px.mid) : null;
      const qty = qtyOf(h);
      return {
        asset,
        name: asset.startsWith("mint:") ? `Token ${asset.slice(5, 9)}…${asset.slice(-4)}` : asset,
        qty,
        raw: h.raw,
        decimals: h.decimals,
        price: px?.mid ?? null,
        change24h: px?.open24h ? px.mid / px.open24h - 1 : null,
        valueUsd: value,
        costUsd: h.cost,
        unrealizedUsd: value === null ? null : value - h.cost,
        hwmUsd: h.hwm,
        // the price this holding must pass to earn more Might
        nextAtPrice: qty > 0 && px && !isStable(asset) ? h.hwm / MICRO / qty : null,
        withdrawable: !!h.mint,
        priced: !!px,
        stable: isStable(asset),
      };
    })
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const total = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
  const sol = v.holdings.SOL;
  const solPx = cached("SOL");
  return {
    network: NETWORK,
    chain: IS_LOCAL ? "solana:localnet" : "solana:devnet",
    vault: vault?.address ?? null,
    vaultExplorer: vault ? explorerAddress(vault.address) : null,
    vaultLamports,
    reserveLamports: VAULT.reserveLamports,
    wallet: p.wallet ? { address: p.wallet.address, kind: p.wallet.kind, label: p.wallet.label ?? null, verified: p.wallet.kind === "address" ? false : (p.wallet.verified ?? true) } : null,
    walletLamports,
    holdings,
    totalUsd: total,
    realizedUsd: v.realized,
    realizedPeakUsd: v.realizedPeak,
    mightTrading: v.mightTrading,
    mightHodl: v.mightHodl,
    might: p.might ?? 0,
    rates: { realized: VAULT.realizedMightPerUsd, hodl: VAULT.mightPerUsd },
    minSol: VAULT.minSol,
    minTradeUsd: PORTFOLIO.minTradeUsd,
    // SOL fields kept for the HUD, older screens and tests
    lamports: sol?.raw ?? 0,
    price: solPx ? { usd: solPx.mid, at: solPx.at, source: solPx.source } : null,
    valueUsd: sol && solPx ? valueOf(sol, solPx.mid) : sol ? null : 0,
    hwmUsd: sol?.hwm ?? 0,
    highWaterPrice: sol?.raw ? sol.hwm / MICRO / qtyOf(sol) : null,
    mightEarned: v.mightHodl,
    mightPerUsd: VAULT.mightPerUsd,
    ledger: v.ledger.slice(-60).reverse().map((e) => ({ ...e, explorer: e.signature ? explorerTx(e.signature) : null })),
    tickSeconds: VAULT.tickMs / 1000,
  };
}

/** For the HUD: SOL held and the whole portfolio's value at the last known prices. */
export function vaultSummary(p: Player) {
  const v = (p as any).vault as Vault | undefined;
  if (!v) return { lamports: 0, valueUsd: 0, totalUsd: 0 };
  const vv = vaultOf(p);
  let total = 0;
  for (const [a, h] of Object.entries(vv.holdings)) {
    const px = priced(a) ? cached(a) : null;
    if (px) total += valueOf(h, px.mid);
  }
  const sol = vv.holdings.SOL;
  const solPx = cached("SOL");
  return { lamports: sol?.raw ?? 0, valueUsd: sol && solPx ? valueOf(sol, solPx.mid) : null, totalUsd: total };
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
