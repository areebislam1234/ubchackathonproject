# StakeClash on-chain program

Two Rust crates:

| Crate | What it is |
|---|---|
| `battle/` (`stakeclash-battle`) | Battle engine 2, ported line for line from `shared/battle2.js`. Integer-only, no allocation beyond one box, `no_std`. |
| `stakeclash/` | The Anchor program: Gold and Might SPL mints, custodial player accounts, stakes, player profiles, on-chain battles and events. |

## What the program does

- **Config PDA** (`["config"]`) is the mint authority of **Gold** and **Might** (decimals 0). It also owns every custodial player token account (`["gold", wallet]`, `["might", wallet]`), so the program can burn a purchase without a wallet pop-up.
- **Player profile** (`["player", wallet]`) holds:
  - unit levels and drills
  - unlocked abilities (a bit mask) and the loadout
  - saved formation and order
  - wins and losses by battle kind
  - Keep level
  - realized yield converted into Might
- **Stakes** (`["stake", id]`) lock Gold or Might in a vault (`["vault", mint]`) until a bounty or duel settles. They pay out in parts (a duel's steel half, then its foresight half), and part of a stake can be burned.
- **`resolve_battle`** runs the battle engine on-chain:
  - The seed is the newest SlotHashes entry XOR the battle counter, so nobody can pick it.
  - Player sides are bound to their profiles: levels come from the chain, and abilities must be unlocked.
  - Records are updated, and the whole battle is emitted in `BattleResolved`.
- **Events** (all versioned with `v`):

| Event | When it's emitted |
|---|---|
| `PlayerRegistered` | a warlord is registered |
| `GoldSettled` | net Gold income and spending, every ~30 s |
| `MightMinted` / `MightBurned` | Might created or destroyed |
| `UnitUpgraded` | a unit level or drill points |
| `AbilityUnlocked`, `LoadoutSet`, `FormationSet` | ability purchases and battle setup |
| `Escrowed` / `Released` / `RewardPaid` | a stake is locked, released or paid out |
| `YieldConverted` | realized yield becomes Might |
| `BattleResolved` | a battle is resolved on-chain |

- **Signers:** the player's wallet, or the game authority, signs the player's own choices (loadout, formation). The game authority signs game-decided actions (battles, rewards, yield conversion, Gold settlement).

## Checks you can run now (Windows is fine)

```
npx tsx scripts/battle-vectors.ts            # 1,000 battles from the JS engine → programs/battle/tests/vectors.json
cargo test -p stakeclash-battle --release    # the Rust engine must match every one exactly
npx tsx scripts/onchain-check.ts             # event/instruction encoding, log parsing, Streams filter
```

On Windows, set `CARGO_TARGET_DIR` to a folder outside OneDrive, for example `%LOCALAPPDATA%\stakeclash-target`.

Smart App Control may block the build scripts of some Solana crates. The program crate builds in WSL; the battle crate builds anywhere.

## Build and deploy (WSL, devnet)

1. In an admin PowerShell, run `wsl --install`, restart, and create the Ubuntu user.
2. In Ubuntu, install the toolchain:
   ```
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
   cargo install --git https://github.com/coral-xyz/anchor avm --force && avm install 0.31.1 && avm use 0.31.1
   ```
3. Create the program's address, once (written to `.data/devnet/`, never committed):
   ```
   npx tsx scripts/program-keypair.ts
   ```
   - Put the printed address in `programs/stakeclash/src/lib.rs` (`declare_id!`) and in `Anchor.toml`.
   - Also set `STAKECLASH_PROGRAM_ID` in `.env` if it differs from the one in the code.
4. Fund the authority with about 5 devnet SOL (faucet.solana.com). The program account needs about 3 SOL of rent.
5. Build and deploy through the QuickNode devnet endpoint:
   ```
   anchor build
   solana program deploy target/deploy/stakeclash.so --program-id .data/devnet/stakeclash-program.json --url "$SOLANA_RPC_URL" --keypair .data/devnet/authority.json
   NETWORK=devnet npx tsx scripts/init-program.ts
   ```
6. **Streams:** regenerate the filter (`npm run print-filter`) and paste it into the QuickNode Stream. It now also forwards the program's transaction logs.
7. Restart the game server. It finds the config account, switches from local to on-chain mode, and starts sending its queue.

## Before mainnet

- Run `anchor test` on a local validator, covering every instruction and token path.
- Measure compute for `resolve_battle` at full armies and request a matching compute-unit limit.
- Get an audit.
- Move the authority to a hardware wallet (`set_authority`).
