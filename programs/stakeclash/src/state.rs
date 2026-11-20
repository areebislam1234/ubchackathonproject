use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const PLAYER_SEED: &[u8] = b"player";
pub const GOLD_SEED: &[u8] = b"gold";
pub const MIGHT_SEED: &[u8] = b"might";
pub const VAULT_SEED: &[u8] = b"vault";
pub const STAKE_SEED: &[u8] = b"stake";

/// Event schema version, bumped whenever an event's fields change (the indexer reads it).
pub const EVENT_VERSION: u8 = 1;

/// Game-wide settings. The config PDA is the mint authority of Gold and Might and the owner of every
/// custodial token account, so the program can charge players without wallet pop-ups.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// The game server's key: signs game-decided actions (battles, rewards, yield conversion).
    pub authority: Pubkey,
    pub gold_mint: Pubkey,
    pub might_mint: Pubkey,
    /// Counts resolved battles; also mixed into each battle seed.
    pub battle_seq: u64,
    pub players: u64,
    pub bump: u8,
}

/// Battle kinds, for per-kind counters and the BattleResolved event.
pub const KIND_BOUNTY: u8 = 0;
pub const KIND_BOSS: u8 = 1;
pub const KIND_DUEL: u8 = 2;
pub const KIND_OTHER: u8 = 3;
pub const KINDS: usize = 4;

/// One formation slot: a stack of `n` units of type `unit`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, Debug, PartialEq, Eq)]
pub struct FormationSlot {
    pub unit: u8,
    pub n: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, Debug)]
pub struct Record {
    pub wins: u32,
    pub losses: u32,
}

/// A warlord's on-chain profile (PDA: ["player", wallet]).
#[account]
#[derive(InitSpace)]
pub struct PlayerProfile {
    /// The player's wallet (or in-game key). It may sign its own choices: loadout and formation.
    pub wallet: Pubkey,
    /// Unit levels 1..=5, by unit index (shared/rules.js UNIT_KEYS order).
    pub levels: [u8; 6],
    /// Drill points per unit (boss rewards), 0..=30.
    pub drills: [u8; 6],
    /// Bit i = ability i unlocked (shared/rules.js ABILITY_KEYS order).
    pub abilities: u16,
    /// Brought into battle, in order; 255 = empty.
    pub loadout: [u8; 2],
    /// Saved formation, front row first; n = 0 is an empty slot.
    pub formation: [FormationSlot; 9],
    pub order: u8,
    pub keep: u8,
    /// Wins and losses by battle kind (bounty, boss, duel, other), as attacker or defender.
    pub record: [Record; KINDS],
    /// Total realized investment yield converted into Might, micro-USDC.
    pub realized_yield: u64,
    pub registered_at: i64,
    pub bump: u8,
}

/// A stake held in the vault until a bounty or duel settles (PDA: ["stake", id]).
#[account]
#[derive(InitSpace)]
pub struct Stake {
    pub id: u64,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    /// What the stake is for: "duel:D-12", "bounty:B-0404".
    #[max_len(32)]
    pub memo: String,
    pub released: bool,
    pub created_at: i64,
    pub bump: u8,
}

/// Might prices of the ten abilities, mirroring ABILITIES in shared/rules.js.
pub const ABILITY_COST: [u64; 10] = [600, 600, 900, 600, 600, 600, 900, 600, 900, 600];
/// The class each ability belongs to (0 guardian, 1 raider, 2 ranger, 3 artillery, 4 support).
pub const ABILITY_CLASS: [u8; 10] = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];
pub const MAX_LEVEL: u8 = 5;
pub const MAX_DRILLS: u8 = 30;
