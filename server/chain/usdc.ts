// USDC on Solana for the yield economy: which mint, where deposits go, and sending withdrawals.
//   devnet: Circle's devnet USDC (free from faucet.circle.com)
//   local:  a test USDC mint `npm run setup-solana` creates on the local chain
//   mainnet (later): set USDC_MINT to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
// Deposits go to the game authority's USDC account; the QuickNode Stream filter reports them.
import fs from "node:fs";
import path from "node:path";
import { address, generateKeyPairSigner, type Address } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import * as TK from "@solana-program/token";
import { getAddMemoInstruction, LEGACY_MEMO_PROGRAM_ADDRESS_V3 } from "@solana-program/memo";
import { IS_LOCAL, networkDataDir } from "../config";
import { MEMO_PREFIX, confirm, loadAuthority, rpc, send } from "./solana";

export const USDC_DECIMALS = 6;
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const LOCAL_FILE = path.join(networkDataDir, "usdc.json");

/** The USDC mint for this network, or null when the local test mint hasn't been created yet. */
export function usdcMint(): string | null {
  if (process.env.USDC_MINT?.trim()) return process.env.USDC_MINT.trim();
  if (!IS_LOCAL) return DEVNET_USDC;
  return fs.existsSync(LOCAL_FILE) ? JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8")).mint : null;
}

export async function tokenAccount(owner: string, mint: string): Promise<Address> {
  const [ata] = await TK.findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TK.TOKEN_PROGRAM_ADDRESS });
  return ata;
}

/** Where players send USDC: the authority (Solana Pay recipient) and its USDC token account. */
export async function depositTarget() {
  const auth = await loadAuthority({ create: false });
  const mint = usdcMint();
  if (!auth || !mint) return null;
  return { owner: auth.address as string, account: (await tokenAccount(auth.address, mint)) as string, mint };
}

/** A Solana Pay transfer request: Phantom and other wallets open it as a ready-to-sign USDC payment. */
export function solanaPayUrl(recipient: string, mint: string, amountUsdc: number | null, reference: string) {
  const q = new URLSearchParams({ "spl-token": mint, reference, label: "StakeClash", message: "Deposit test USDC into StakeClash" });
  if (amountUsdc && amountUsdc > 0) q.set("amount", String(amountUsdc));
  return `solana:${recipient}?${q.toString()}`;
}

/** Send USDC from the game to a player's wallet (creating their token account if needed). */
export async function sendUsdc(to: string, micro: number, memoText: string) {
  const payer = await loadAuthority();
  const mint = usdcMint();
  if (!payer || !mint) throw new Error("USDC isn't set up on this server.");
  const source = await tokenAccount(payer.address, mint);
  const dest = await tokenAccount(to, mint);
  const sig = await send([
    TK.getCreateAssociatedTokenIdempotentInstruction({ payer, ata: dest, owner: address(to), mint: address(mint) }),
    TK.getTransferCheckedInstruction({ source, mint: address(mint), destination: dest, authority: payer, amount: BigInt(micro), decimals: USDC_DECIMALS }),
    getAddMemoInstruction({ memo: `${MEMO_PREFIX}:${memoText}` }, { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 }),
  ]);
  void confirm(sig).catch(() => {});
  return sig;
}

/** The game's USDC balance (what withdrawals can draw on). */
export async function treasuryBalance() {
  const t = await depositTarget();
  if (!t) return null;
  try {
    const { value } = await rpc.getTokenAccountBalance(address(t.account)).send();
    return Number(value.amount) / 10 ** USDC_DECIMALS;
  } catch {
    return 0; // no token account yet
  }
}

/** Local chain only: create a test USDC mint and give the game a float for withdrawals. */
export async function ensureLocalUsdc(log = console.log) {
  if (!IS_LOCAL || usdcMint()) return usdcMint();
  const payer = (await loadAuthority())!;
  const mint = await generateKeyPairSigner();
  const space = BigInt(TK.getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  const ata = await tokenAccount(payer.address, mint.address);
  const sig = await send([
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TK.TOKEN_PROGRAM_ADDRESS }),
    TK.getInitializeMint2Instruction({ mint: mint.address, decimals: USDC_DECIMALS, mintAuthority: payer.address }),
    TK.getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner: payer.address, mint: mint.address }),
    TK.getMintToInstruction({ mint: mint.address, token: ata, mintAuthority: payer, amount: 1_000_000n * 10n ** BigInt(USDC_DECIMALS) }),
  ]);
  await confirm(sig);
  fs.writeFileSync(LOCAL_FILE, JSON.stringify({ mint: mint.address }, null, 2));
  log(`test USDC   ${mint.address}`);
  return mint.address as string;
}
