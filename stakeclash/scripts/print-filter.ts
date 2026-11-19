// Writes streams/quicknode-solana-filter.<network>.js with this deployment's authority and badge
// mints filled in, ready to paste into the QuickNode Stream filter editor.
import fs from "node:fs";
import path from "node:path";
import { NETWORK, ROOT } from "../server/config";
import { buildFilter } from "../server/chain/filter";
import { badgeMints, loadAuthority } from "../server/chain/solana";

const auth = await loadAuthority({ create: false });
if (!auth) {
  console.error("No authority yet. Run `npm run setup-solana` first.");
  process.exit(1);
}
const src = buildFilter(auth.address, Object.values(badgeMints()));
const file = path.join(ROOT, "streams", `quicknode-solana-filter.${NETWORK}.js`);
fs.writeFileSync(file, src);
console.log(src);
console.log(`\nWrote ${path.relative(ROOT, file)}. Paste it into your Stream (Solana · Devnet · Block dataset).`);
