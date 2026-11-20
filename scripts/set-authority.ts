// Hands the StakeClash program's game authority to another key: the authority of whoever runs the
// game server (their `npm run setup-solana` prints it). Run by the current authority.
//   NETWORK=devnet npx tsx scripts/set-authority.ts <new authority address>
import { address } from "@solana/kit";
import { setAuthorityIx } from "../server/chain/program";
import { confirm, loadAuthority, send } from "../server/chain/solana";

const target = process.argv[2];
if (!target) throw new Error("Usage: npx tsx scripts/set-authority.ts <new authority address>");
const auth = await loadAuthority();
if (!auth) throw new Error("No authority key here. Run this on the machine that deployed and initialized the program.");
const sig = await send([await setAuthorityIx(auth.address, address(target))]);
await confirm(sig);
console.log(`Game authority is now ${target} (tx ${sig}). That machine's game server can now drive the program.`);
