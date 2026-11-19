// Solana side of StakeClash: the game authority keypair, one Token-2022 collectible mint per badge,
// minting badges to players' wallets, sealing bounty results in memos, and wallet-link checks.
// Same code on the local LiteSVM chain and on devnet; only the RPC URL differs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import * as T22 from "@solana-program/token-2022";
import { getAddMemoInstruction, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from "@solana-program/memo";
import { BADGES, BADGE_IDS } from "../../shared/rules.js";
import { IS_LOCAL, env, explorerTx, networkDataDir, solanaRpcUrl } from "../config";
import { db, feed, type Bounty, type Player, type WalletKind } from "../db";

export const MEMO_PREFIX = "stakeclash:v1";
const AUTH_FILE = path.join(networkDataDir, "authority.json");
const BADGES_FILE = path.join(networkDataDir, "badges.json");

export const rpc = createSolanaRpc(solanaRpcUrl);

// ── Keys ──────────────────────────────────────────────────────────────
/** New ed25519 keypair as the 64-byte secret Solana tools use (seed ‖ public key). */
export function newSecret(): number[] {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return [...seed, ...pub];
}

function parseSecret(s: string): Uint8Array {
  const t = s.trim();
  if (t.startsWith("[")) return Uint8Array.from(JSON.parse(t));
  return getBase58Encoder().encode(t) as Uint8Array;
}

let authority: KeyPairSigner | null = null;
export async function loadAuthority({ create = IS_LOCAL } = {}): Promise<KeyPairSigner | null> {
  if (authority) return authority;
  let secret: Uint8Array | null = null;
  if (env.authorityKey) secret = parseSecret(env.authorityKey);
  else if (fs.existsSync(AUTH_FILE)) secret = Uint8Array.from(JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")));
  else if (create) {
    const s = newSecret();
    fs.mkdirSync(networkDataDir, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(s), { mode: 0o600 });
    secret = Uint8Array.from(s);
  }
  if (!secret) return null;
  authority = await createKeyPairSignerFromBytes(secret);
  return authority;
}

export function badgeMints(): Record<string, string> {
  return fs.existsSync(BADGES_FILE) ? JSON.parse(fs.readFileSync(BADGES_FILE, "utf8")) : {};
}

// ── Sending ───────────────────────────────────────────────────────────
let queue: Promise<unknown> = Promise.resolve();
/** Serialise chain writes so they land in order. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export async function send(instructions: Instruction[]): Promise<string> {
  const payer = await loadAuthority();
  if (!payer) throw new Error("No game authority key. Run `npm run setup-solana` first.");
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return sig;
}

/** Wait until a signature is confirmed (or fails). */
export async function confirm(sig: string, timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await rpc.getSignatureStatuses([sig as any]).send();
    const s = value[0];
    if (s?.err) throw new Error(`transaction failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return true;
    await new Promise((r) => setTimeout(r, IS_LOCAL ? 150 : 1200));
  }
  return false;
}

export async function balanceSol(addr: string) {
  const { value } = await rpc.getBalance(address(addr)).send();
  return Number(value) / 1e9;
}

export async function airdrop(addr: string, sol = 2) {
  const sig = await rpc.requestAirdrop(address(addr), lamports(BigInt(Math.round(sol * 1e9)))).send();
  if (!IS_LOCAL) await confirm(sig, 60_000).catch(() => false);
  return sig;
}

// ── Badge collectibles (Token-2022 with on-mint metadata) ─────────────
export const badgeName = (id: string) => `StakeClash: ${(BADGES as any)[id]?.name ?? id}`;
export const badgeUri = (id: string) => `${env.publicUrl.replace(/\/$/, "")}/meta/${id}.json`;

export async function createBadgeMint(id: string): Promise<string> {
  const payer = (await loadAuthority())!;
  const { generateKeyPairSigner } = await import("@solana/kit");
  const mint = await generateKeyPairSigner();
  const pointer = T22.extension("MetadataPointer", { authority: some(payer.address), metadataAddress: some(mint.address) });
  const metadata = T22.extension("TokenMetadata", {
    updateAuthority: some(payer.address),
    mint: mint.address,
    name: badgeName(id),
    symbol: "CLASH",
    uri: badgeUri(id),
    additionalMetadata: new Map([["game", "StakeClash"], ["badge", id]]),
  });
  const space = BigInt(T22.getMintSize([pointer]));
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(T22.getMintSize([pointer, metadata]))).send();
  const sig = await send([
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: T22.TOKEN_2022_PROGRAM_ADDRESS }),
    ...T22.getPreInitializeInstructionsForMintExtensions(mint.address, [pointer]),
    T22.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: payer.address }),
    ...T22.getPostInitializeInstructionsForMintExtensions(mint.address, payer, [metadata]),
  ]);
  await confirm(sig);
  return mint.address;
}

/** Make sure every badge has a mint (creates missing ones). */
export async function ensureBadgeMints(log = console.log) {
  const mints = badgeMints();
  for (const id of BADGE_IDS) {
    if (mints[id]) continue;
    mints[id] = await createBadgeMint(id);
    fs.writeFileSync(BADGES_FILE, JSON.stringify(mints, null, 2));
    log(`  badge mint ${id.padEnd(13)} ${mints[id]}`);
  }
  return mints;
}

const memo = (text: string) => getAddMemoInstruction({ memo: text }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 });

/** Mint one badge to the player's wallet, with a memo the Stream filter picks up. */
export function mintBadge(p: Player, badge: string) {
  return enqueue(async () => {
    const st = p.badges[badge];
    if (!st || !p.wallet) return;
    const mint = badgeMints()[badge];
    if (!mint) throw new Error(`badge ${badge} has no mint yet (run npm run setup-solana)`);
    const payer = (await loadAuthority())!;
    const owner = address(p.wallet.address);
    const [ata] = await T22.findAssociatedTokenPda({ owner, mint: address(mint), tokenProgram: T22.TOKEN_2022_PROGRAM_ADDRESS });
    st.status = "minting";
    st.owner = p.wallet.address;
    st.error = undefined;
    db.save();
    try {
      const sig = await send([
        T22.getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint: address(mint) }),
        T22.getMintToInstruction({ mint: address(mint), token: ata, mintAuthority: payer, amount: 1n }),
        memo(`${MEMO_PREFIX}:badge:${badge}:${p.id}`),
      ]);
      st.signature = sig;
      db.save();
      const ok = await confirm(sig);
      if (ok && st.status === "minting") (st as any).confirmed = true;
      db.save();
    } catch (e) {
      st.status = "failed";
      st.error = (e as Error).message.slice(0, 200);
      db.save();
    }
  });
}

/** Mint every badge the player earned before linking a wallet. */
export function claimAll(p: Player) {
  for (const [badge, st] of Object.entries(p.badges)) if (st.status === "unclaimed" || st.status === "failed") void mintBadge(p, badge);
}

/** Post a bounty's final standings hash in a memo, so anyone can check the results weren't changed. */
export function sealResults(b: Bounty) {
  if (!b.results) return;
  b.results.seal = { status: "sending" };
  db.save();
  return enqueue(async () => {
    try {
      const sig = await send([memo(`${MEMO_PREFIX}:result:${b.id}:${b.results!.hash}`)]);
      b.results!.seal = { signature: sig, status: "sent" };
      db.save();
      await confirm(sig);
    } catch (e) {
      b.results!.seal = { status: "failed", error: (e as Error).message.slice(0, 200) };
      db.save();
    }
  });
}

// ── Wallet linking ────────────────────────────────────────────────────
const challenges = new Map<string, { message: string; at: number }>();
export function walletChallenge(p: Player, wallet: string) {
  try {
    address(wallet);
  } catch {
    throw new Error("That isn't a Solana address.");
  }
  const message = `StakeClash: link this wallet to ${p.name}\nPlayer: ${p.id}\nWallet: ${wallet}\nNonce: ${crypto.randomBytes(8).toString("hex")}\nIssued: ${new Date().toISOString()}`;
  challenges.set(p.id, { message, at: Date.now() });
  return message;
}

/** Check an ed25519 signature from the wallet over the challenge message. */
export function verifyWalletSignature(p: Player, wallet: string, signatureB64: string) {
  const c = challenges.get(p.id);
  if (!c || Date.now() - c.at > 10 * 60_000) throw new Error("The link request expired. Try again.");
  if (!c.message.includes(`Wallet: ${wallet}\n`)) throw new Error("Signed message is for a different wallet.");
  const pub = Buffer.from(getAddressEncoder().encode(address(wallet)));
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
  const ok = crypto.verify(null, Buffer.from(c.message, "utf8"), key, Buffer.from(signatureB64, "base64"));
  if (!ok) throw new Error("Signature didn't verify.");
  challenges.delete(p.id);
}

export const WALLET_LABEL: Record<WalletKind, string> = { ingame: "In-game wallet", phantom: "Phantom", standard: "Solana wallet", address: "Address", demo: "Demo wallet" };

/** Link (or switch to) a wallet. Earned badges that aren't on-chain yet mint to it. */
export async function linkWallet(p: Player, wallet: string, kind: WalletKind, { label, verified }: { label?: string; verified: boolean }) {
  try {
    address(wallet);
  } catch {
    throw new Error("That isn't a Solana address.");
  }
  const switching = p.wallet && p.wallet.address !== wallet;
  p.wallet = { address: wallet, kind, label: label?.slice(0, 30) || WALLET_LABEL[kind], verified, linkedAt: Date.now() };
  feed({ kind: "wallet", text: `${p.name} ${switching ? "switched to" : "linked"} ${kind === "ingame" ? "an in-game" : "a"} Solana wallet`, player: p.id });
  db.save();
  claimAll(p);
}

export function unlinkWallet(p: Player) {
  if (!p.wallet) throw new Error("No wallet is linked.");
  p.wallet = undefined;
  db.save();
}

/** On-chain badge counts for a wallet, as seen through the Stream. */
export function holdingsFor(owner: string | undefined) {
  if (!owner) return {};
  const mints = badgeMints();
  const byMint = Object.fromEntries(Object.entries(mints).map(([id, m]) => [m, id]));
  const h = db.data.chain.holdings[owner] ?? {};
  return Object.fromEntries(Object.entries(h).filter(([m, n]) => byMint[m] && n > 0).map(([m, n]) => [byMint[m], n]));
}

export async function chainStatus() {
  const auth = await loadAuthority({ create: false });
  let sol: number | null = null;
  let ok = false;
  try {
    if (auth) sol = await balanceSol(auth.address);
    ok = true;
  } catch {
    ok = false;
  }
  return { network: IS_LOCAL ? "local" : "devnet", rpcOk: ok, authority: auth?.address ?? null, authoritySol: sol, mints: badgeMints(), explorer: auth ? explorerTx("") : null };
}

export type { Address };
