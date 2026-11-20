// Stands in for QuickNode Streams when there's no Stream to receive from:
//   local:  reads every new block from the local chain (Block dataset shape)
//   devnet: (USE_LOCAL_STREAM=1) polls signatures for the authority and badge mints
// then runs the real filter (streams/quicknode-solana-filter.template.js) and POSTs the result to
// /webhooks/quicknode, signed exactly like QuickNode signs its webhooks.
import fs from "node:fs";
import path from "node:path";
import { signStreamPayload } from "../shared/hmac";
import { IS_LOCAL, env, gameUrl, networkDataDir, solanaRpcUrl } from "../server/config";
import { NETWORK_EVERY, buildFilter, runFilter } from "../server/chain/filter";
import { badgeMints, loadAuthority } from "../server/chain/solana";

const STATE = path.join(networkDataDir, "relay.json");
const state: { lastSlot: number; lastSigs: Record<string, string>; lastSample?: number } = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { lastSlot: 0, lastSigs: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));

let id = 0;
async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(solanaRpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j: any = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result;
}

async function deliver(result: unknown) {
  const body = JSON.stringify(result);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.quicknodeWebhookSecret) Object.assign(headers, signStreamPayload(env.quicknodeWebhookSecret, body));
  const res = await fetch(`${gameUrl}/webhooks/quicknode`, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

let filterSrc = "";
let filterKey = "";
async function filter() {
  const auth = await loadAuthority({ create: false });
  if (!auth) return null;
  const mints = Object.values(badgeMints());
  const key = auth.address + mints.join();
  if (key !== filterKey) {
    filterSrc = buildFilter(auth.address, mints);
    filterKey = key;
  }
  return { auth: auth.address, mints };
}

async function pollLocal() {
  const slot: number = await rpc("getSlot");
  for (let s = state.lastSlot + 1; s <= slot; s++) {
    let block: any;
    try {
      block = await rpc("getBlock", [s, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, transactionDetails: "full" }]);
    } catch (e: any) {
      if (e.code === -32007) {
        state.lastSlot = s;
        continue;
      }
      throw e;
    }
    const out = runFilter(filterSrc, { data: [block], metadata: { dataset: "block", network: "solana-local", batch_start_range: s, batch_end_range: s } });
    if (out) await deliver(out);
    state.lastSlot = s;
    save();
  }
}

async function pollDevnet(watch: string[]) {
  for (const who of watch) {
    const until = state.lastSigs[who];
    const sigs: any[] = await rpc("getSignaturesForAddress", [who, { limit: 50, ...(until ? { until } : {}), commitment: "confirmed" }]);
    if (!sigs.length) continue;
    for (const s of [...sigs].reverse()) {
      if (s.err) continue;
      const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (!tx) continue;
      // a one-transaction stand-in for the block: marked partial so the filter never samples it
      const block = { slot: tx.slot, blockTime: tx.blockTime, partial: true, transactions: [{ transaction: tx.transaction, meta: tx.meta }] };
      const out = runFilter(filterSrc, { data: [block], metadata: { dataset: "block", network: "solana-devnet", batch_start_range: tx.slot, batch_end_range: tx.slot } });
      if (out) await deliver(out);
    }
    state.lastSigs[who] = sigs[0].signature;
    save();
  }
}

/** Devnet: like a Block-dataset Stream, run one full block every NETWORK_EVERY slots through the filter. */
async function sampleDevnetBlock() {
  if (NETWORK_EVERY <= 0) return;
  const slot: number = await rpc("getSlot", [{ commitment: "confirmed" }]);
  let s = slot - (slot % NETWORK_EVERY);
  if (state.lastSample && s <= state.lastSample) return;
  for (let tries = 0; tries < 3; tries++, s -= NETWORK_EVERY) {
    try {
      const block = await rpc("getBlock", [s, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, transactionDetails: "full", rewards: false, commitment: "confirmed" }]);
      const out = runFilter(filterSrc, { data: [{ ...block, slot: s }], metadata: { dataset: "block", network: "solana-devnet", batch_start_range: s, batch_end_range: s } });
      if (out) await deliver(out);
      state.lastSample = s;
      save();
      return;
    } catch (e: any) {
      if (e.code !== -32007 && e.code !== -32009 && e.code !== -32004) throw e; // skipped or unavailable slot
    }
  }
}

async function loop() {
  try {
    const f = await filter();
    if (f) {
      if (IS_LOCAL) await pollLocal();
      else {
        await pollDevnet([f.auth, ...f.mints]);
        await sampleDevnetBlock();
      }
    }
  } catch (e) {
    console.error("stream relay:", (e as Error).message);
  }
  setTimeout(loop, IS_LOCAL ? 700 : 5000);
}
console.log(`stream relay → ${gameUrl}/webhooks/quicknode (${IS_LOCAL ? "local blocks" : "devnet signatures"})`);
loop();
