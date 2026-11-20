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

## Checks

```
npx tsx scripts/onchain-check.ts   # event and instruction encoding, log parsing, Streams filter (no cluster needed)
```

## Build and deploy

Building needs macOS or Linux: the Solana compiler doesn't run on Windows. Step-by-step instructions for whoever builds and deploys are in [TEAMMATE.md](TEAMMATE.md).

## Before mainnet

- Run `anchor test` on a local validator, covering every instruction and token path.
- Measure compute for `resolve_battle` at full armies and request a matching compute-unit limit.
- Get an audit.
- Move the authority to a hardware wallet (`set_authority`).
