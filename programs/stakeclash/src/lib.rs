//! StakeClash on-chain program.
//!
//! Everything that moves value or decides a result runs here:
//! - Gold and Might are SPL tokens. This program's config PDA is their mint authority and owns every
//!   custodial player token account, so purchases are burned without wallet pop-ups.
//! - Battles are resolved on-chain by the same engine the game uses (`stakeclash-battle`, a line for
//!   line port of shared/battle2.js), seeded from the SlotHashes sysvar.
//! - Stakes for bounties and duels sit in a program vault until they settle.
//! - Every action emits a versioned event, which the QuickNode indexer turns into the Economic
//!   Board, public player stats and relic intelligence.
//!
//! Signers: the player's wallet (or in-game key) for its own choices (loadout, formation); the game
//! authority for game-decided actions (battle results, rewards, yield conversion, Gold settlement).
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod errors;
pub mod events;
pub mod state;

use errors::GameError;
use events::*;
use stakeclash_battle as battle;
use state::*;

declare_id!("3bXC59d9UQihNDpY17QFbQTf9WavttgpdtfGfMRuGLAs");

/// One side of a battle as the game server submits it. For a player side, the program replaces
/// `levels` with the on-chain profile's and checks every ability is unlocked.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct BattleSide {
    pub slots: [FormationSlot; 9],
    pub order: u8,
    /// up to two abilities in order, 255 = none
    pub abilities: [u8; 2],
    pub levels: [u8; 6],
    /// damage bonus per unit in basis points; index 6 applies to all (relics, drills)
    pub boosts: [i32; 7],
    /// HP bonus per unit in basis points; index 6 applies to all (drills)
    pub vigor: [i32; 7],
    pub towers: u8,
    pub champion: Option<ChampionArg>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct ChampionArg {
    pub hp: u32,
    pub atk: u32,
    pub splash: bool,
}

impl BattleSide {
    fn engine(&self) -> battle::SideInput {
        let mut s = battle::SideInput::default();
        for (i, x) in self.slots.iter().enumerate() {
            s.slots[i] = (x.unit, x.n);
        }
        s.order = self.order;
        s.abilities = self.abilities;
        s.levels = self.levels;
        s.boosts = self.boosts;
        s.vigor = self.vigor;
        s.towers = self.towers;
        s.champion = self.champion.map(|c| battle::Champion { hp: c.hp, atk: c.atk, splash: c.splash });
        s
    }
    /// Bind a player side to its profile: real unit levels, and only unlocked abilities.
    fn bind(&mut self, p: &PlayerProfile) -> Result<()> {
        self.levels = p.levels;
        for &a in self.abilities.iter() {
            if a != 255 {
                require!(a < battle::ABILITY_COUNT, GameError::BadAbility);
                require!(p.abilities & (1 << a) != 0, GameError::NotUnlocked);
            }
        }
        Ok(())
    }
}

#[program]
pub mod stakeclash {
    use super::*;

    /// Create the config and the Gold and Might mints (decimals 0, mint authority = config PDA).
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.gold_mint = ctx.accounts.gold_mint.key();
        c.might_mint = ctx.accounts.might_mint.key();
        c.battle_seq = 0;
        c.players = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Hand the game authority to a new key (for example a hardware wallet before mainnet).
    pub fn set_authority(ctx: Context<AdminOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }

    /// A new warlord: profile PDA plus custodial Gold and Might accounts.
    pub fn register_player(ctx: Context<RegisterPlayer>, wallet: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.profile;
        p.wallet = wallet;
        p.levels = [1; 6];
        p.drills = [0; 6];
        p.abilities = 0;
        p.loadout = [255, 255];
        p.formation = [FormationSlot::default(); 9];
        p.order = battle::HOLD;
        p.keep = 1;
        p.record = [Record::default(); KINDS];
        p.realized_yield = 0;
        p.registered_at = now;
        p.bump = ctx.bumps.profile;
        ctx.accounts.config.players += 1;
        emit!(PlayerRegistered { v: EVENT_VERSION, wallet, profile: p.key(), at: now });
        Ok(())
    }

    /// Settle a player's net Gold since the last settlement: income is minted, spending burned.
    /// The server batches many small actions into one settlement every ~30 seconds.
    pub fn settle_gold(ctx: Context<PlayerTokens>, delta: i64, reason: String) -> Result<()> {
        require!(reason.len() <= 48, GameError::TooLong);
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        if delta > 0 {
            token::mint_to(cpi_mint(&ctx.accounts.token_program, &ctx.accounts.gold_mint, &ctx.accounts.gold, &ctx.accounts.config, &[seeds]), delta as u64)?;
        } else if delta < 0 {
            token::burn(cpi_burn(&ctx.accounts.token_program, &ctx.accounts.gold_mint, &ctx.accounts.gold, &ctx.accounts.config, &[seeds]), delta.unsigned_abs())?;
        }
        ctx.accounts.gold.reload()?;
        emit!(GoldSettled { v: EVENT_VERSION, wallet: ctx.accounts.profile.wallet, delta, balance: ctx.accounts.gold.amount, reason });
        Ok(())
    }

    /// Realized investment yield (micro-USDC, computed by the game from Gemini fills) becomes Might.
    pub fn convert_yield(ctx: Context<PlayerTokens>, usdc: u64, might: u64) -> Result<()> {
        require!(might > 0, GameError::ZeroAmount);
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        token::mint_to(cpi_mint(&ctx.accounts.token_program, &ctx.accounts.might_mint, &ctx.accounts.might, &ctx.accounts.config, &[seeds]), might)?;
        let p = &mut ctx.accounts.profile;
        p.realized_yield = p.realized_yield.checked_add(usdc).ok_or(GameError::Overflow)?;
        emit!(MightMinted { v: EVENT_VERSION, wallet: p.wallet, amount: might, reason: 0 });
        emit!(YieldConverted { v: EVENT_VERSION, wallet: p.wallet, usdc, might, realized_total: p.realized_yield });
        Ok(())
    }

    /// Mint Might for other reasons (1 duel winnings, 2 migration of existing balances, 3 other).
    pub fn mint_might(ctx: Context<PlayerTokens>, amount: u64, reason: u8) -> Result<()> {
        require!(amount > 0, GameError::ZeroAmount);
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        token::mint_to(cpi_mint(&ctx.accounts.token_program, &ctx.accounts.might_mint, &ctx.accounts.might, &ctx.accounts.config, &[seeds]), amount)?;
        emit!(MightMinted { v: EVENT_VERSION, wallet: ctx.accounts.profile.wallet, amount, reason });
        Ok(())
    }

    /// Burn Might for other reasons (2 = correction when Might left the game outside an action).
    pub fn burn_might(ctx: Context<PlayerTokens>, amount: u64, reason: u8) -> Result<()> {
        require!(amount > 0, GameError::ZeroAmount);
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        token::burn(cpi_burn(&ctx.accounts.token_program, &ctx.accounts.might_mint, &ctx.accounts.might, &ctx.accounts.config, &[seeds]), amount)?;
        emit!(MightBurned { v: EVENT_VERSION, wallet: ctx.accounts.profile.wallet, amount, reason });
        Ok(())
    }

    /// Level up a unit type, burning its Gold price.
    pub fn upgrade_unit(ctx: Context<PlayerTokens>, unit: u8, gold_cost: u64) -> Result<()> {
        require!((unit as usize) < battle::UNIT_COUNT, GameError::BadUnit);
        let lvl = ctx.accounts.profile.levels[unit as usize];
        require!(lvl < MAX_LEVEL, GameError::MaxLevel);
        if gold_cost > 0 {
            let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
            token::burn(cpi_burn(&ctx.accounts.token_program, &ctx.accounts.gold_mint, &ctx.accounts.gold, &ctx.accounts.config, &[seeds]), gold_cost)?;
        }
        let p = &mut ctx.accounts.profile;
        p.levels[unit as usize] = lvl + 1;
        emit!(UnitUpgraded { v: EVENT_VERSION, wallet: p.wallet, unit, level: lvl + 1, drills: p.drills[unit as usize], gold_spent: gold_cost });
        Ok(())
    }

    /// Assign drill points (boss rewards) to a unit type.
    pub fn assign_drills(ctx: Context<PlayerAuthority>, unit: u8, points: u8) -> Result<()> {
        require!((unit as usize) < battle::UNIT_COUNT, GameError::BadUnit);
        let p = &mut ctx.accounts.profile;
        let now = p.drills[unit as usize].checked_add(points).ok_or(GameError::Overflow)?;
        require!(now <= MAX_DRILLS, GameError::MaxDrills);
        p.drills[unit as usize] = now;
        emit!(UnitUpgraded { v: EVENT_VERSION, wallet: p.wallet, unit, level: p.levels[unit as usize], drills: now, gold_spent: 0 });
        Ok(())
    }

    /// Unlock a class ability, burning its Might price (ABILITY_COST).
    pub fn unlock_ability(ctx: Context<PlayerTokens>, ability: u8) -> Result<()> {
        require!(ability < battle::ABILITY_COUNT, GameError::BadAbility);
        require!(ctx.accounts.profile.abilities & (1 << ability) == 0, GameError::AlreadyUnlocked);
        let cost = ABILITY_COST[ability as usize];
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        token::burn(cpi_burn(&ctx.accounts.token_program, &ctx.accounts.might_mint, &ctx.accounts.might, &ctx.accounts.config, &[seeds]), cost)?;
        let p = &mut ctx.accounts.profile;
        p.abilities |= 1 << ability;
        let free = p.loadout.iter().position(|&x| x == 255);
        if let Some(i) = free {
            p.loadout[i] = ability;
        }
        emit!(MightBurned { v: EVENT_VERSION, wallet: p.wallet, amount: cost, reason: 0 });
        emit!(AbilityUnlocked { v: EVENT_VERSION, wallet: p.wallet, ability, might_spent: cost });
        Ok(())
    }

    /// Choose which unlocked abilities to bring (player-signed or authority-signed).
    pub fn set_loadout(ctx: Context<PlayerChoice>, loadout: [u8; 2]) -> Result<()> {
        ctx.accounts.check_signer()?;
        let p = &mut ctx.accounts.profile;
        for &a in loadout.iter() {
            if a != 255 {
                require!(a < battle::ABILITY_COUNT && p.abilities & (1 << a) != 0, GameError::NotUnlocked);
            }
        }
        require!(loadout[0] == 255 || loadout[0] != loadout[1], GameError::BadAbility);
        p.loadout = loadout;
        emit!(LoadoutSet { v: EVENT_VERSION, wallet: p.wallet, loadout });
        Ok(())
    }

    /// Save the formation and order (player-signed or authority-signed).
    pub fn set_formation(ctx: Context<PlayerChoice>, formation: [FormationSlot; 9], order: u8) -> Result<()> {
        ctx.accounts.check_signer()?;
        require!(order <= battle::FLANK, GameError::BadFormation);
        require!(formation.iter().any(|s| s.n > 0), GameError::BadFormation);
        require!(formation.iter().all(|s| s.n == 0 || (s.unit as usize) < battle::UNIT_COUNT), GameError::BadUnit);
        let p = &mut ctx.accounts.profile;
        p.formation = formation;
        p.order = order;
        emit!(FormationSet { v: EVENT_VERSION, wallet: p.wallet, formation, order });
        Ok(())
    }

    /// Lock part of a player's Gold or Might in the vault (bounty entry, duel stake).
    pub fn escrow_stake(ctx: Context<EscrowStake>, id: u64, amount: u64, memo: String) -> Result<()> {
        require!(amount > 0, GameError::ZeroAmount);
        require!(memo.len() <= 32, GameError::TooLong);
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer { from: ctx.accounts.from.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.config.to_account_info() },
                &[seeds],
            ),
            amount,
        )?;
        let s = &mut ctx.accounts.stake;
        s.id = id;
        s.owner = ctx.accounts.profile.wallet;
        s.mint = ctx.accounts.mint.key();
        s.amount = amount;
        s.memo = memo.clone();
        s.released = false;
        s.created_at = Clock::get()?.unix_timestamp;
        s.bump = ctx.bumps.stake;
        emit!(Escrowed { v: EVENT_VERSION, stake: id, wallet: s.owner, mint: s.mint, amount, memo });
        Ok(())
    }

    /// Pay out part of a stake to a player's custodial account and burn part of it. A duel pot is
    /// paid in two steps (steel now, foresight when Gemini settles); the stake closes at zero.
    pub fn release_stake(ctx: Context<ReleaseStake>, pay: u64, burn: u64, memo: String) -> Result<()> {
        require!(memo.len() <= 32, GameError::TooLong);
        let s = &mut ctx.accounts.stake;
        require!(!s.released, GameError::AlreadyReleased);
        let total = pay.checked_add(burn).ok_or(GameError::Overflow)?;
        require!(total <= s.amount, GameError::Overpaid);
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        if pay > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.to.to_account_info(), authority: ctx.accounts.config.to_account_info() },
                    &[seeds],
                ),
                pay,
            )?;
            emit!(RewardPaid { v: EVENT_VERSION, wallet: ctx.accounts.to_profile.wallet, mint: s.mint, amount: pay, memo });
        }
        if burn > 0 {
            token::burn(cpi_burn(&ctx.accounts.token_program, &ctx.accounts.mint, &ctx.accounts.vault, &ctx.accounts.config, &[seeds]), burn)?;
            if s.mint == ctx.accounts.config.might_mint {
                emit!(MightBurned { v: EVENT_VERSION, wallet: s.owner, amount: burn, reason: 1 });
            }
        }
        s.amount -= total;
        if s.amount == 0 {
            s.released = true;
        }
        emit!(Released { v: EVENT_VERSION, stake: s.id, amount: pay, burned: burn });
        Ok(())
    }

    /// Resolve a battle on-chain. The seed comes from the most recent SlotHashes entry mixed with the
    /// battle counter, so neither the server nor the player can pick it. Player sides are bound to
    /// their profiles (levels from the chain, abilities must be unlocked) and their records updated.
    pub fn resolve_battle(ctx: Context<ResolveBattle>, kind: u8, context: String, attacker: BattleSide, defender: BattleSide) -> Result<()> {
        // (Anchor instruction arguments can't be declared `mut`, so rebind them)
        let mut attacker = attacker;
        let mut defender = defender;
        require!(context.len() <= 40, GameError::TooLong);
        require!(attacker.slots.iter().any(|s| s.n > 0), GameError::BadFormation);
        if let Some(p) = ctx.accounts.attacker_profile.as_ref() {
            attacker.bind(p)?;
        }
        if let Some(p) = ctx.accounts.defender_profile.as_ref() {
            defender.bind(p)?;
        }
        let cfg = &mut ctx.accounts.config;
        cfg.battle_seq += 1;
        let seq = cfg.battle_seq;
        let seed = battle_seed(&ctx.accounts.slot_hashes, seq)?;
        let r = battle::simulate(&attacker.engine(), &defender.engine(), seed);
        let k = core::cmp::min(kind as usize, KINDS - 1);
        let mut atk_key = Pubkey::default();
        let mut def_key = Pubkey::default();
        if let Some(p) = ctx.accounts.attacker_profile.as_mut() {
            atk_key = p.wallet;
            if r.attacker_won { p.record[k].wins += 1 } else { p.record[k].losses += 1 }
        }
        if let Some(p) = ctx.accounts.defender_profile.as_mut() {
            def_key = p.wallet;
            if r.attacker_won { p.record[k].losses += 1 } else { p.record[k].wins += 1 }
        }
        emit!(BattleResolved {
            v: EVENT_VERSION,
            seq,
            kind,
            context,
            attacker: atk_key,
            defender: def_key,
            seed,
            attacker_side: attacker,
            defender_side: defender,
            attacker_won: r.attacker_won,
            ticks: r.ticks,
            destruction_pm: r.destruction_pm,
            survival_pm: r.survival_pm,
            score: r.score,
            lost: r.lost,
        });
        Ok(())
    }
}

/// Seed = first 4 bytes of the newest slot hash, xor the battle counter.
fn battle_seed(slot_hashes: &AccountInfo, seq: u64) -> Result<u32> {
    let data = slot_hashes.try_borrow_data()?;
    // layout: u64 entry count, then (u64 slot, [u8; 32] hash) newest first
    require!(data.len() >= 8 + 8 + 32, GameError::BadSlotHashes);
    let h = &data[16..20];
    let x = u32::from_le_bytes([h[0], h[1], h[2], h[3]]);
    Ok(x ^ (seq as u32) ^ ((seq >> 32) as u32))
}

fn cpi_mint<'a, 'b, 'c, 'info>(
    program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    config: &Account<'info, Config>,
    signer: &'a [&'b [&'c [u8]]],
) -> CpiContext<'a, 'b, 'c, 'info, MintTo<'info>> {
    CpiContext::new_with_signer(program.to_account_info(), MintTo { mint: mint.to_account_info(), to: to.to_account_info(), authority: config.to_account_info() }, signer)
}

fn cpi_burn<'a, 'b, 'c, 'info>(
    program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    from: &Account<'info, TokenAccount>,
    config: &Account<'info, Config>,
    signer: &'a [&'b [&'c [u8]]],
) -> CpiContext<'a, 'b, 'c, 'info, Burn<'info>> {
    CpiContext::new_with_signer(program.to_account_info(), Burn { mint: mint.to_account_info(), from: from.to_account_info(), authority: config.to_account_info() }, signer)
}

// ── Accounts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, mint::decimals = 0, mint::authority = config)]
    pub gold_mint: Account<'info, Mint>,
    #[account(init, payer = authority, mint::decimals = 0, mint::authority = config)]
    pub might_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ GameError::NotAuthority)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RegisterPlayer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ GameError::NotAuthority, has_one = gold_mint, has_one = might_mint)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + PlayerProfile::INIT_SPACE, seeds = [PLAYER_SEED, wallet.as_ref()], bump)]
    pub profile: Account<'info, PlayerProfile>,
    pub gold_mint: Account<'info, Mint>,
    pub might_mint: Account<'info, Mint>,
    #[account(init, payer = authority, seeds = [GOLD_SEED, wallet.as_ref()], bump, token::mint = gold_mint, token::authority = config)]
    pub gold: Account<'info, TokenAccount>,
    #[account(init, payer = authority, seeds = [MIGHT_SEED, wallet.as_ref()], bump, token::mint = might_mint, token::authority = config)]
    pub might: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Authority-signed actions on a player's profile and custodial token accounts.
#[derive(Accounts)]
pub struct PlayerTokens<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ GameError::NotAuthority, has_one = gold_mint, has_one = might_mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [PLAYER_SEED, profile.wallet.as_ref()], bump = profile.bump)]
    pub profile: Account<'info, PlayerProfile>,
    #[account(mut)]
    pub gold_mint: Account<'info, Mint>,
    #[account(mut)]
    pub might_mint: Account<'info, Mint>,
    #[account(mut, seeds = [GOLD_SEED, profile.wallet.as_ref()], bump)]
    pub gold: Account<'info, TokenAccount>,
    #[account(mut, seeds = [MIGHT_SEED, profile.wallet.as_ref()], bump)]
    pub might: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PlayerAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ GameError::NotAuthority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [PLAYER_SEED, profile.wallet.as_ref()], bump = profile.bump)]
    pub profile: Account<'info, PlayerProfile>,
}

/// The player's own choices: signed by the player's wallet or by the game authority.
#[derive(Accounts)]
pub struct PlayerChoice<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [PLAYER_SEED, profile.wallet.as_ref()], bump = profile.bump)]
    pub profile: Account<'info, PlayerProfile>,
}
impl PlayerChoice<'_> {
    fn check_signer(&self) -> Result<()> {
        let k = self.signer.key();
        require!(k == self.profile.wallet || k == self.config.authority, GameError::NotPlayerOrAuthority);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct EscrowStake<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ GameError::NotAuthority)]
    pub config: Account<'info, Config>,
    #[account(seeds = [PLAYER_SEED, profile.wallet.as_ref()], bump = profile.bump)]
    pub profile: Account<'info, PlayerProfile>,
    #[account(constraint = mint.key() == config.gold_mint || mint.key() == config.might_mint)]
    pub mint: Account<'info, Mint>,
    /// the player's custodial account for this mint
    #[account(mut, token::mint = mint, token::authority = config,
        constraint = from.key() == Pubkey::find_program_address(&[if mint.key() == config.gold_mint { GOLD_SEED } else { MIGHT_SEED }, profile.wallet.as_ref()], &crate::ID).0 @ GameError::WrongProfile)]
    pub from: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = authority, seeds = [VAULT_SEED, mint.key().as_ref()], bump, token::mint = mint, token::authority = config)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init, payer = authority, space = 8 + Stake::INIT_SPACE, seeds = [STAKE_SEED, id.to_le_bytes().as_ref()], bump)]
    pub stake: Account<'info, Stake>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ReleaseStake<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ GameError::NotAuthority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [STAKE_SEED, stake.id.to_le_bytes().as_ref()], bump = stake.bump)]
    pub stake: Account<'info, Stake>,
    #[account(mut, address = stake.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    /// the winner's profile and custodial account for this mint
    #[account(seeds = [PLAYER_SEED, to_profile.wallet.as_ref()], bump = to_profile.bump)]
    pub to_profile: Account<'info, PlayerProfile>,
    #[account(mut, token::mint = mint, token::authority = config,
        constraint = to.key() == Pubkey::find_program_address(&[if mint.key() == config.gold_mint { GOLD_SEED } else { MIGHT_SEED }, to_profile.wallet.as_ref()], &crate::ID).0 @ GameError::WrongProfile)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveBattle<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ GameError::NotAuthority)]
    pub config: Account<'info, Config>,
    /// CHECK: the SlotHashes sysvar, checked by address
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
    #[account(mut, seeds = [PLAYER_SEED, attacker_profile.wallet.as_ref()], bump = attacker_profile.bump)]
    pub attacker_profile: Option<Account<'info, PlayerProfile>>,
    #[account(mut, seeds = [PLAYER_SEED, defender_profile.wallet.as_ref()], bump = defender_profile.bump)]
    pub defender_profile: Option<Account<'info, PlayerProfile>>,
}
