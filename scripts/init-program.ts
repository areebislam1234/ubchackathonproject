// One-time setup after `anchor deploy`: creates the program's config and the Gold and Might mints,
// with this server's authority key as the game authority. Safe to re-run: it stops if the config
// already exists. The mint keypairs are saved in .data/<network>/ (never committed).
//   NETWORK=devnet npx tsx scripts/init-program.ts
import fs from "node:fs";
import path from "node:path";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { networkDataDir } from "../server/config";
import { configPda, initializeIx, PROGRAM_ID } from "../server/chain/program";
import { confirm, loadAuthority, rpc, send } from "../server/chain/solana";

async function mintKey(name: string): Promise<KeyPairSigner> {
  const file = path.join(networkDataDir, `${name}-mint.json`);
  if (fs.existsSync(file)) return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  const k = await generateKeyPairSigner(true);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", k.keyPair.privateKey));
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", k.keyPair.publicKey));
  fs.mkdirSync(networkDataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...seed, ...pub]));
  return k;
}

const auth = await loadAuthority();
if (!auth) throw new Error("No authority key. Run `npm run setup-solana` first.");
const cfg = await configPda();
const existing = await rpc.getAccountInfo(cfg, { encoding: "base64" }).send();
if (existing.value) {
  console.log(`Already initialized: config ${cfg} (program ${PROGRAM_ID}).`);
  process.exit(0);
}
const program = await rpc.getAccountInfo(PROGRAM_ID, { encoding: "base64" }).send();
if (!program.value?.executable) throw new Error(`Program ${PROGRAM_ID} isn't deployed on this cluster yet. Run \`anchor deploy\` first.`);
const gold = await mintKey("gold");
const might = await mintKey("might");
const ix = await initializeIx(auth.address, gold.address, might.address);
// the new mint accounts must sign their own creation
(ix.accounts as any)[2] = { ...ix.accounts![2], signer: gold };
(ix.accounts as any)[3] = { ...ix.accounts![3], signer: might };
const sig = await send([ix]);
await confirm(sig);
console.log(`Initialized StakeClash on ${PROGRAM_ID}\n  config ${cfg}\n  Gold mint ${gold.address}\n  Might mint ${might.address}\n  authority ${auth.address}\n  tx ${sig}`);
console.log("Restart the game server: it detects the program and switches to on-chain mode.");
