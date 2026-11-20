# Building and deploying the StakeClash program (Mac or Linux)

The Solana compiler doesn't run on Windows, so the contract is built and deployed from a Mac or Linux machine. Everything below targets **devnet**. Expect about 30 minutes the first time, mostly installs.

## 1. Install the tools (once)

```
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh        # Rust
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"           # Solana CLI (Agave)
cargo install --git https://github.com/coral-xyz/anchor avm --force     # Anchor version manager
avm install 0.31.1 && avm use 0.31.1                                    # Anchor
```

You also need Node 20 or newer, and `npm install` in the repo.

## 2. Get the code and set it up

```
git fetch && git checkout chain-battles
npm install
cp .env.example .env        # if you don't have one; set NETWORK=devnet and SOLANA_RPC_URL to the QuickNode devnet endpoint
npm run setup-solana        # creates the game authority key in .data/devnet/ and prints its address
npm run program-keypair     # creates the program's address in .data/devnet/ and prints it
```

- Put the printed program address in `programs/stakeclash/src/lib.rs` (`declare_id!("…")`) and in `Anchor.toml` (both `[programs.*]` lines), then commit that change. The game server reads the address from `declare_id!`, so that's the only code change.
- Keep `.data/` private: it holds the keys and is never committed.

## 3. Build

```
anchor build
```

- **Don't** run `anchor keys sync`: the address comes from step 2.
- This is the first real build of the program, so it may report a few compile errors. Send the full error output back and the code gets fixed.
- The output is `target/deploy/stakeclash.so`.

## 4. Deploy (devnet)

1. Fund the authority from step 2 with about 5 devnet SOL at faucet.solana.com (the program's rent is about 3 SOL).
2. Deploy, then initialize the program (this creates the Gold and Might tokens):
   ```
   solana program deploy target/deploy/stakeclash.so \
     --program-id .data/devnet/stakeclash-program.json \
     --keypair .data/devnet/authority.json \
     --url <your QuickNode devnet URL, the same as SOLANA_RPC_URL in .env>
   npm run init-program
   ```
3. Point QuickNode at the program: run `npm run print-filter` and paste the output into the QuickNode Stream's filter.

## 5. Who runs the game server?

The program only accepts game actions signed by its **authority**, the key from step 2.

- **If you run the game server on this machine**, you're done. Start it (`npm run dev` with `NETWORK=devnet`) and it switches to on-chain mode by itself.
- **If a teammate runs the server**, hand the authority to them:
  1. They run `npm run setup-solana` on their machine and send you the authority address it prints.
  2. You run `npm run set-authority <their address>`.
  3. They pull your `declare_id!` commit (or set `STAKECLASH_PROGRAM_ID` in their `.env`), run `npm run print-filter` for their Stream, and restart their server.

**To check it worked:** open `/api/chain/program` on the server. It should say `"mode": "chain"`. Battles then show "Decided on Solana" with an explorer link, and the Ledger (L) board shows on-chain numbers.

## Updating the program later

Change the code, run `anchor build`, then run the same `solana program deploy …` command again. The address stays the same as long as you keep `.data/devnet/stakeclash-program.json` and the authority key.
