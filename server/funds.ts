// The yield economy: a player's USDC in the game, investments at real market prices, realized
// yield converted into Might (which unlocks class abilities).
//
// Rules this file enforces:
//   - money is integer micro-USDC (6 decimals) and only ever changes here, on the server
//   - principal (what was deposited) is tracked apart from gains; only realized gains convert
//   - trades fill at the live bid/ask fetched on the server, never at a price the client sends
//   - every money action carries a request id: a retried request returns the stored result
import crypto from "node:crypto";
import { ECONOMY } from "../shared/rules.js";
import { db, feed, type Funds, type LedgerEntry, type Player } from "./db";
import { GameError, award } from "./players";
import * as chain from "./chain/onchain";
import { getJson } from "./intel/http";

export const MICRO = 1_000_000;
const now = () => Date.now();
export const toMicro = (usdc: number) => Math.round(usdc * MICRO);
const LEDGER_KEPT = 500;
const CLAIMS_KEPT = 50;

export function funds(p: Player): Funds {
  p.funds ??= { cash: 0, principal: 0, positions: {}, realized: 0, converted: 0, ledger: [] };
  return p.funds;
}
function record(p: Player, e: Omit<LedgerEntry, "at">) {
  const f = funds(p);
  const entry = { at: now(), ...e };
  f.ledger.push(entry);
  if (f.ledger.length > LEDGER_KEPT) f.ledger.splice(0, f.ledger.length - LEDGER_KEPT);
  return entry;
}

// ── Idempotency ───────────────────────────────────────────────────────
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
function claimed(p: Player, requestId: unknown) {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new GameError("Missing request id.");
  return p.fundClaims?.[requestId]?.response;
}
function remember<T>(p: Player, requestId: string, response: T): T {
  p.fundClaims ??= {};
  p.fundClaims[requestId] = { at: now(), response };
  const keys = Object.keys(p.fundClaims);
  if (keys.length > CLAIMS_KEPT) for (const k of keys.sort((a, b) => p.fundClaims![a].at - p.fundClaims![b].at).slice(0, keys.length - CLAIMS_KEPT)) delete p.fundClaims[k];
  db.save();
  return response;
}

// ── Prices ────────────────────────────────────────────────────────────
export type Quote = { coin: string; bid: number; ask: number; open24h: number | null; at: number };

/**
 * How trades are filled. Devnet uses PaperExecutor: positions are recorded at real Gemini prices
 * with test USDC. A mainnet SwapExecutor (real DEX swaps) is the piece to build for real money.
 */
export interface Executor {
  readonly name: string;
  quote(coin: string): Promise<Quote>;
}
export const PaperExecutor: Executor = {
  name: "paper",
  async quote(coin) {
    const t: any = await getJson(`https://api.gemini.com/v2/ticker/${coin.toLowerCase()}usd`, { ttlMs: 5000, timeoutMs: 6000 });
    const bid = Number(t.bid);
    const ask = Number(t.ask);
    if (!(bid > 0 && ask > 0 && ask >= bid)) throw new GameError(`No live price for ${coin} right now, so trading is paused. Try again in a moment.`, 503);
    return { coin, bid, ask, open24h: Number(t.open) || null, at: now() };
  },
};
export const SwapExecutor: Executor = {
  name: "swap",
  async quote() {
    throw new GameError("Real-money trading isn't enabled in this build.", 501);
  },
};
export const executor: Executor = process.env.EXECUTOR === "swap" ? SwapExecutor : PaperExecutor;

function coinOf(c: unknown) {
  const coin = String(c ?? "").toUpperCase();
  if (!ECONOMY.coins.includes(coin)) throw new GameError("That coin isn't available.");
  return coin;
}

export async function quotes() {
  const out = await Promise.all(ECONOMY.coins.map((c) => executor.quote(c).catch(() => null)));
  return out.filter(Boolean) as Quote[];
}

// ── Views ─────────────────────────────────────────────────────────────
/** Everything the Treasury shows. Values are micro-USDC; `quotes` may be partial if a price is missing. */
export function fundsView(p: Player, qs: Quote[] = []) {
  const f = funds(p);
  const priced = new Map(qs.map((q) => [q.coin, q]));
  const positions = Object.entries(f.positions).map(([coin, pos]) => {
    const q = priced.get(coin);
    const value = q ? Math.round(pos.qty * q.bid * MICRO) : null;
    return { coin, qty: pos.qty, cost: pos.cost, value, unrealized: value === null ? null : value - pos.cost, avgPrice: pos.qty > 0 ? pos.cost / MICRO / pos.qty : 0 };
  });
  const invested = positions.reduce((s, x) => s + (x.value ?? x.cost), 0);
  return {
    cash: f.cash,
    principal: f.principal,
    realized: f.realized,
    converted: f.converted,
    eligible: Math.max(0, f.realized - f.converted),
    invested,
    unrealized: positions.reduce((s, x) => s + (x.unrealized ?? 0), 0),
    positions,
    might: p.might ?? 0,
    abilities: p.abilities?.unlocked ?? [],
    mightPerUsdc: ECONOMY.mightPerUsdc,
    executor: executor.name,
    ledger: f.ledger.slice(-60).reverse(),
  };
}

// ── Trading ───────────────────────────────────────────────────────────
export async function buy(p: Player, coinIn: unknown, usdcIn: unknown, requestId: unknown) {
  const prev = claimed(p, requestId);
  if (prev) return prev;
  const coin = coinOf(coinIn);
  const amount = toMicro(Number(usdcIn));
  if (!(amount >= toMicro(ECONOMY.minTradeUsdc))) throw new GameError(`The smallest trade is ${ECONOMY.minTradeUsdc} USDC.`);
  const q = await executor.quote(coin);
  // from here on nothing awaits: the checks and the change happen together
  const again = claimed(p, requestId);
  if (again) return again;
  const f = funds(p);
  if (amount > f.cash) throw new GameError(`You have ${(f.cash / MICRO).toFixed(2)} USDC to invest.`);
  const fee = Math.round((amount * ECONOMY.feeBps) / 10000);
  const qty = (amount - fee) / MICRO / q.ask;
  const pos = (f.positions[coin] ??= { qty: 0, cost: 0 });
  pos.qty += qty;
  pos.cost += amount;
  f.cash -= amount;
  const entry = record(p, { kind: "buy", usdc: -amount, coin, qty, price: q.ask });
  return remember(p, requestId as string, { ok: true, fill: entry, funds: fundsView(p, [q]) });
}

export async function sell(p: Player, coinIn: unknown, qtyIn: unknown, requestId: unknown) {
  const prev = claimed(p, requestId);
  if (prev) return prev;
  const coin = coinOf(coinIn);
  const q = await executor.quote(coin);
  const again = claimed(p, requestId);
  if (again) return again;
  const f = funds(p);
  const pos = f.positions[coin];
  if (!pos || pos.qty <= 0) throw new GameError(`You don't hold any ${coin}.`);
  const all = qtyIn === "all" || Number(qtyIn) >= pos.qty * 0.999999;
  const qty = all ? pos.qty : Number(qtyIn);
  if (!(qty > 0)) throw new GameError("Enter how much to sell.");
  const gross = Math.round(qty * q.bid * MICRO);
  const fee = Math.round((gross * ECONOMY.feeBps) / 10000);
  const proceeds = gross - fee;
  if (proceeds < toMicro(ECONOMY.minTradeUsdc) && !all) throw new GameError(`The smallest trade is ${ECONOMY.minTradeUsdc} USDC.`);
  const basis = all ? pos.cost : Math.round((pos.cost * qty) / pos.qty);
  const realized = proceeds - basis;
  f.realized += realized;
  f.cash += proceeds;
  if (all) delete f.positions[coin];
  else {
    pos.qty -= qty;
    pos.cost -= basis;
  }
  if (realized > 0) award(p, "first-profit");
  const entry = record(p, { kind: "sell", usdc: proceeds, coin, qty, price: q.bid, realized });
  return remember(p, requestId as string, { ok: true, fill: entry, funds: fundsView(p, [q]) });
}

// ── Yield → Might ───────────────────────────────────────────────────────────────────────────────────────────────
/** Convert realized yield (never principal) into Might at the published rate. */
export function convert(p: Player, usdcIn: unknown, requestId: unknown) {
  const prev = claimed(p, requestId);
  if (prev) return prev;
  const f = funds(p);
  const eligible = Math.max(0, f.realized - f.converted);
  const amount = usdcIn === "all" ? Math.min(eligible, f.cash) : toMicro(Number(usdcIn));
  if (!(amount > 0)) throw new GameError("Enter how much yield to convert.");
  if (amount > eligible) throw new GameError(`Only realized yield converts: you have ${(eligible / MICRO).toFixed(2)} USDC eligible. Sell an investment at a profit to realize more.`);
  if (amount > f.cash) throw new GameError("That yield is still invested. Sell first, then convert.");
  const might = Math.floor((amount * ECONOMY.mightPerUsdc) / MICRO);
  if (might < 1) throw new GameError(`Convert at least ${(1 / ECONOMY.mightPerUsdc).toFixed(2)} USDC (1 Might).`);
  f.cash -= amount;
  f.converted += amount;
  p.might = (p.might ?? 0) + might;
  chain.onYieldConverted(p, amount, might);
  record(p, { kind: "convert", usdc: -amount, might });
  feed({ kind: "economy", text: `${p.name} turned ${(amount / MICRO).toFixed(2)} USDC of yield into ${might} Might`, player: p.id });
  return remember(p, requestId as string, { ok: true, might, funds: fundsView(p) });
}


// ── Deposits ──────────────────────────────────────────────────────────
function depositBook() {
  db.data.deposits ??= { refs: {}, unclaimed: [] };
  return db.data.deposits;
}

/** A one-time reference key for a Solana Pay deposit link, so the deposit can be matched to this player. */
export function newDepositReference(p: Player) {
  // a reference is any valid public key; 32 random bytes in base58 is enough (it never signs)
  const ref = b58(crypto.randomBytes(32));
  const book = depositBook();
  book.refs[ref] = { player: p.id, at: now() };
  for (const [k, v] of Object.entries(book.refs)) if (now() - v.at > 7 * 86400_000) delete book.refs[k];
  db.save();
  return ref;
}

/**
 * Credit a deposit the Stream delivered (after the webhook's HMAC check and signature dedupe).
 * Matched by Solana Pay reference first, then by the sender's verified linked wallet.
 */
export function creditDeposit(d: { signature: string; from: string; usdc: number; refs: string[] }) {
  const book = depositBook();
  const byRef = d.refs.map((r) => book.refs[r]?.player).find(Boolean);
  const byWallet = Object.values(db.data.players).find((p) => !p.bot && p.wallet?.address === d.from && p.wallet.kind !== "address");
  const p = (byRef && db.data.players[byRef]) || byWallet;
  if (!p) {
    book.unclaimed.push({ signature: d.signature, from: d.from, usdc: d.usdc, at: now() });
    if (book.unclaimed.length > 200) book.unclaimed.splice(0, book.unclaimed.length - 200);
    db.save();
    return null;
  }
  const f = funds(p);
  if (f.ledger.some((e) => e.signature === d.signature && e.kind === "deposit")) return p; // already credited
  f.cash += d.usdc;
  f.principal += d.usdc;
  record(p, { kind: "deposit", usdc: d.usdc, signature: d.signature, status: "confirmed" });
  feed({ kind: "economy", text: `${p.name} deposited ${(d.usdc / MICRO).toFixed(2)} USDC (confirmed by the Stream)`, signature: d.signature, player: p.id });
  db.save();
  return p;
}

/** Dev tools only: add test USDC without a chain transfer (counted as principal). */
export function devCredit(p: Player, usdc: number) {
  const amount = toMicro(usdc);
  const f = funds(p);
  f.cash += amount;
  f.principal += amount;
  record(p, { kind: "dev-credit", usdc: amount });
  db.save();
}

// ── Withdrawals ───────────────────────────────────────────────────────
type Sender = (to: string, micro: number, memo: string) => Promise<string>;
let sender: Sender | null = null;
/** server/chain/usdc.ts installs the real on-chain sender at startup. */
export const setWithdrawSender = (fn: Sender) => (sender = fn);

export function withdraw(p: Player, usdcIn: unknown, requestId: unknown) {
  const prev = claimed(p, requestId);
  if (prev) return prev;
  const amount = toMicro(Number(usdcIn));
  if (!(amount >= toMicro(ECONOMY.minWithdrawUsdc))) throw new GameError(`The smallest withdrawal is ${ECONOMY.minWithdrawUsdc} USDC.`);
  if (!p.wallet) throw new GameError("Link a wallet first (Profile → Solana wallet).");
  if (p.wallet.kind === "address" || p.wallet.verified === false) throw new GameError("Withdrawals go only to a wallet you've proven is yours (sign in with Phantom or the in-game wallet), not a pasted address.");
  const f = funds(p);
  if (amount > f.cash) throw new GameError(`You have ${(f.cash / MICRO).toFixed(2)} USDC in cash. Sell investments first to withdraw more.`);
  if (!sender) throw new GameError("Withdrawals aren't available on this server right now.", 503);
  // hold the money now; refund if the transfer fails
  f.cash -= amount;
  f.principal -= amount;
  const entry = record(p, { kind: "withdraw", usdc: -amount, status: "pending" });
  const to = p.wallet.address;
  const response = remember(p, requestId as string, { ok: true, withdrawal: entry, funds: fundsView(p) });
  void sender(to, amount, `withdraw:${p.id}`)
    .then((sig) => {
      entry.signature = sig;
      entry.status = "sent";
      db.save();
    })
    .catch((e) => {
      entry.status = "failed";
      entry.error = (e as Error).message.slice(0, 200);
      f.cash += amount;
      f.principal += amount;
      record(p, { kind: "withdraw-refund", usdc: amount });
      db.save();
    });
  return response;
}

/** The Stream saw a withdrawal land: mark it confirmed. */
export function confirmWithdrawal(signature: string) {
  for (const p of Object.values(db.data.players))
    for (const e of p.funds?.ledger ?? [])
      if (e.kind === "withdraw" && e.signature === signature) {
        e.status = "confirmed";
        db.save();
        return p;
      }
  return null;
}

// base58 for reference keys (Bitcoin alphabet)
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Buffer) {
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = ALPHA[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
