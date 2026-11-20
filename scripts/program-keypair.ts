// Creates the StakeClash program's keypair (its address on Solana) once, in .data/<network>/,
// and prints the address. That folder is never committed. Run before the first `anchor deploy`;
// put the printed address in programs/stakeclash/src/lib.rs (declare_id!) and Anchor.toml.
//   npx tsx scripts/program-keypair.ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getBase58Decoder } from "@solana/kit";

const network = process.env.NETWORK ?? "devnet";
const file = path.join(import.meta.dirname, "..", ".data", network, "stakeclash-program.json");
if (!fs.existsSync(file)) {
  const k = crypto.generateKeyPairSync("ed25519");
  const seed = Buffer.from(k.privateKey.export({ format: "jwk" }).d!, "base64url");
  const pub = Buffer.from(k.publicKey.export({ format: "jwk" }).x!, "base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...seed, ...pub]));
  console.log(`created ${path.relative(process.cwd(), file)}`);
}
const bytes = Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))).slice(32);
console.log(getBase58Decoder().decode(bytes));
