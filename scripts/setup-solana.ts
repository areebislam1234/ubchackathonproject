// Creates the game authority keypair (if needed), funds it, and creates one Token-2022 mint
// (with on-chain metadata) per badge. Safe to re-run: it only creates what's missing.
//   NETWORK=local  npm run setup-solana   (done for you by npm run dev)
//   NETWORK=devnet npm run setup-solana
import { BADGE_IDS } from "../shared/rules.js";
import { IS_LOCAL, NETWORK, solanaRpcUrl } from "../server/config";
import { airdrop, balanceSol, ensureBadgeMints, loadAuthority } from "../server/chain/solana";
import { depositTarget, ensureLocalUsdc, treasuryBalance } from "../server/chain/usdc";

async function main() {
  const auth = await loadAuthority({ create: true });
  if (!auth) throw new Error("could not create authority");
  console.log(`network    ${NETWORK}  (${solanaRpcUrl})`);
  console.log(`authority  ${auth.address}`);
  let sol = await balanceSol(auth.address);
  if (sol < 0.3) {
    try {
      process.stdout.write(`airdropping SOL… `);
      await airdrop(auth.address, IS_LOCAL ? 10 : 1);
      await new Promise((r) => setTimeout(r, IS_LOCAL ? 100 : 4000));
      sol = await balanceSol(auth.address);
      console.log(`balance ${sol} SOL`);
    } catch (e) {
      console.log("failed");
      console.log(`\nFund ${auth.address} with ~1 devnet SOL at https://faucet.solana.com, then run this again.`);
      if (sol < 0.05) process.exit(1);
    }
  } else console.log(`balance    ${sol} SOL`);
  console.log(`badge mints (${BADGE_IDS.length})`);
  const mints = await ensureBadgeMints();
  for (const id of BADGE_IDS) console.log(`  ${id.padEnd(13)} ${mints[id]}`);
  if (IS_LOCAL) await ensureLocalUsdc();
  const dep = await depositTarget();
  if (dep) console.log(`USDC        mint ${dep.mint}
            deposits → ${dep.account} (owner ${dep.owner}), game balance ${await treasuryBalance()} USDC`);
  if (!IS_LOCAL) console.log(`            Withdrawals draw on the game's USDC: send it some test USDC from https://faucet.circle.com (Solana devnet).`);
  if (!IS_LOCAL) console.log(`\nNext: npm run print-filter, then create the QuickNode Stream (see README).`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
