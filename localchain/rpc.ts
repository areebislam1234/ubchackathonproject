// A local Solana JSON-RPC endpoint backed by LiteSVM (an in-process Solana runtime with the real
// SPL Token-2022, Associated Token and Memo programs). `npm run dev` uses it so the game runs real
// Solana transactions with nothing to install. On devnet the same server code talks to a real RPC.
//
// Supports the methods the game, setup script and stream relay use:
//   getHealth getVersion getGenesisHash getSlot getBlockHeight getLatestBlockhash
//   getMinimumBalanceForRentExemption getBalance getAccountInfo requestAirdrop
//   sendTransaction getSignatureStatuses getTransaction getBlock getBlocks getSignaturesForAddress
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { LiteSVM } from "litesvm";
import {
  address,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  type Address,
} from "@solana/kit";
import { env, DATA_DIR } from "../server/config";

const DIR = path.join(DATA_DIR, "local", "chain");
const SVM_FILE = path.join(DIR, "svm.bin");
const BLOCKS_FILE = path.join(DIR, "blocks.json");
fs.mkdirSync(DIR, { recursive: true });

const TOKEN_PROGRAMS = new Set(["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
const b58 = getBase58Decoder();

let svm: LiteSVM;
type Block = { slot: number; blockTime: number; blockhash: string; parentSlot: number; previousBlockhash: string; blockHeight: number; transactions: any[] };
let blocks: Block[] = [];
try {
  if (fs.existsSync(SVM_FILE) && fs.existsSync(BLOCKS_FILE)) {
    svm = LiteSVM.loadFromFile(SVM_FILE);
    blocks = JSON.parse(fs.readFileSync(BLOCKS_FILE, "utf8"));
  } else svm = new LiteSVM();
} catch (e) {
  console.error("local chain: could not load saved state, starting fresh:", (e as Error).message);
  svm = new LiteSVM();
  blocks = [];
}
let slot = blocks.length ? blocks[blocks.length - 1].slot : 1;
const bySig = new Map<string, { block: Block; tx: any }>();
for (const b of blocks) for (const t of b.transactions) bySig.set(t.transaction.signatures[0], { block: b, tx: t });

let saveTimer: NodeJS.Timeout | null = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    svm.saveToFile(SVM_FILE);
    fs.writeFileSync(BLOCKS_FILE, JSON.stringify(blocks));
  }, 300);
}

function tokenBalances(keys: string[]) {
  const out: any[] = [];
  keys.forEach((k, accountIndex) => {
    const acc = svm.getAccount(address(k));
    if (!acc.exists || !TOKEN_PROGRAMS.has(acc.programAddress) || acc.data.length < 72 || acc.data.length === 82) return;
    const data = acc.data;
    const mint = b58.decode(data.slice(0, 32));
    const owner = b58.decode(data.slice(32, 64));
    const amount = new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);
    const mintAcc = svm.getAccount(address(mint));
    const decimals = mintAcc.exists ? mintAcc.data[44] : 0;
    const ui = Number(amount) / 10 ** decimals;
    out.push({ accountIndex, mint, owner, programId: acc.programAddress, uiTokenAmount: { amount: amount.toString(), decimals, uiAmount: ui, uiAmountString: String(ui) } });
  });
  return out;
}

function nextBlock(): Block {
  const parent = blocks[blocks.length - 1];
  slot += 1;
  const b: Block = {
    slot,
    blockTime: Math.floor(Date.now() / 1000),
    blockhash: svm.latestBlockhash(),
    parentSlot: parent?.slot ?? slot - 1,
    previousBlockhash: parent?.blockhash ?? svm.latestBlockhash(),
    blockHeight: slot,
    transactions: [],
  };
  blocks.push(b);
  return b;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function sendTransaction(wire: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = msg.staticAccounts.map(String);
  const pre = tokenBalances(keys);
  const preBalances = keys.map((k) => Number(svm.getBalance(address(k)) ?? 0));
  const res: any = svm.sendTransaction(tx);
  if (typeof res.err === "function") {
    const meta = res.meta();
    throw new RpcError(-32002, `Transaction simulation failed: ${JSON.stringify(res.err())}`, { err: res.err(), logs: meta.logs() });
  }
  const signature = getSignatureFromTransaction(tx);
  const h = msg.header;
  const nSign = h.numSignerAccounts;
  const accountKeys = keys.map((pubkey, i) => ({
    pubkey,
    signer: i < nSign,
    writable: i < nSign ? i < nSign - h.numReadonlySignerAccounts : i < keys.length - h.numReadonlyNonSignerAccounts,
    source: "transaction",
  }));
  const block = nextBlock();
  const entry = {
    transaction: {
      signatures: Object.values(tx.signatures).map((s) => (s ? b58.decode(s as Uint8Array) : null)),
      message: {
        accountKeys,
        recentBlockhash: (msg as any).lifetimeToken,
        instructions: (msg as any).instructions.map((ix: any) => ({ programIdIndex: ix.programAddressIndex, accounts: ix.accountIndices ?? [], data: b58.decode(ix.data ?? new Uint8Array()) })),
      },
    },
    meta: {
      err: null,
      status: { Ok: null },
      fee: 5000,
      preBalances,
      postBalances: keys.map((k) => Number(svm.getBalance(address(k)) ?? 0)),
      preTokenBalances: pre,
      postTokenBalances: tokenBalances(keys),
      logMessages: res.logs(),
      computeUnitsConsumed: Number(res.computeUnitsConsumed()),
      loadedAddresses: { writable: [], readonly: [] },
    },
    version: 0,
  };
  block.transactions.push(entry);
  bySig.set(signature, { block, tx: entry });
  persist();
  return signature;
}

const ctx = () => ({ slot, apiVersion: "litesvm-shim" });

function handle(method: string, params: any[] = []): unknown {
  switch (method) {
    case "getHealth":
      return "ok";
    case "getVersion":
      return { "solana-core": "litesvm-shim", "feature-set": 0 };
    case "getGenesisHash":
      return "StakeC1ashLocaLGenesis11111111111111111111111";
    case "getSlot":
    case "getBlockHeight":
      return slot;
    case "getLatestBlockhash":
      return { context: ctx(), value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: slot + 150 } };
    case "getMinimumBalanceForRentExemption":
      return Number(svm.minimumBalanceForRentExemption(BigInt(params[0] ?? 0)));
    case "getBalance":
      return { context: ctx(), value: Number(svm.getBalance(address(params[0])) ?? 0) };
    case "getAccountInfo": {
      const acc = svm.getAccount(address(params[0]));
      if (!acc.exists) return { context: ctx(), value: null };
      return {
        context: ctx(),
        value: { data: [Buffer.from(acc.data).toString("base64"), "base64"], executable: acc.executable, lamports: Number(acc.lamports), owner: acc.programAddress, rentEpoch: 0, space: acc.data.length },
      };
    }
    case "requestAirdrop": {
      const r: any = svm.airdrop(address(params[0]) as Address, lamports(BigInt(params[1] ?? 1_000_000_000)));
      persist();
      return r && typeof r.signature === "function" ? b58.decode(r.signature()) : "airdrop";
    }
    case "sendTransaction":
      return sendTransaction(params[0]);
    case "getSignatureStatuses":
      return {
        context: ctx(),
        value: (params[0] ?? []).map((s: string) => {
          const f = bySig.get(s);
          return f ? { slot: f.block.slot, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: "finalized" } : null;
        }),
      };
    case "getTransaction": {
      const f = bySig.get(params[0]);
      return f ? { slot: f.block.slot, blockTime: f.block.blockTime, ...f.tx } : null;
    }
    case "getBlock": {
      const b = blocks.find((x) => x.slot === Number(params[0]));
      if (!b) throw new RpcError(-32007, `Slot ${params[0]} was skipped, or missing due to ledger jump to recent snapshot`);
      return b;
    }
    case "getBlocks": {
      const start = Number(params[0]);
      const end = params[1] !== undefined && typeof params[1] === "number" ? params[1] : slot;
      return blocks.filter((b) => b.slot >= start && b.slot <= end).map((b) => b.slot);
    }
    case "getSignaturesForAddress": {
      const who = params[0];
      const opts = params[1] ?? {};
      const out: any[] = [];
      for (let i = blocks.length - 1; i >= 0 && out.length < (opts.limit ?? 1000); i--) {
        for (const t of blocks[i].transactions) {
          const sig = t.transaction.signatures[0];
          if (opts.until && sig === opts.until) return out;
          if (t.transaction.message.accountKeys.some((k: any) => k.pubkey === who)) out.push({ signature: sig, slot: blocks[i].slot, err: null, memo: null, blockTime: blocks[i].blockTime, confirmationStatus: "finalized" });
        }
      }
      return out;
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.post("/", (req, res) => {
  const run = (call: any) => {
    try {
      return { jsonrpc: "2.0", id: call.id ?? null, result: handle(call.method, call.params) };
    } catch (e) {
      const err = e instanceof RpcError ? { code: e.code, message: e.message, data: e.data } : { code: -32603, message: (e as Error).message };
      return { jsonrpc: "2.0", id: call.id ?? null, error: err };
    }
  };
  res.json(Array.isArray(req.body) ? req.body.map(run) : run(req.body));
});
app.listen(env.localChainPort, "127.0.0.1", () => console.log(`local Solana (LiteSVM) on http://127.0.0.1:${env.localChainPort}  slot ${slot}`));
