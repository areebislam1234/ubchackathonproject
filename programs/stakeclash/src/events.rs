//! Events the program emits (Anchor `emit!`, base64 in "Program data:" log lines). The QuickNode
//! indexer decodes these; every event carries `v` (schema version) so old ones stay readable.
use anchor_lang::prelude::*;

#[event]
pub struct PlayerRegistered {
    pub v: u8,
    pub wallet: Pubkey,
    pub profile: Pubkey,
    pub at: i64,
}

/// Net Gold change for one player since the last settlement (income minus spending, batched).
#[event]
pub struct GoldSettled {
    pub v: u8,
    pub wallet: Pubkey,
    pub delta: i64,
    pub balance: u64,
    /// What the settlement covers, e.g. "income+training" or a batch id.
    pub reason: String,
}

#[event]
pub struct MightMinted {
    pub v: u8,
    pub wallet: Pubkey,
    pub amount: u64,
    /// 0 yield conversion, 1 duel winnings, 2 migration, 3 other
    pub reason: u8,
}

#[event]
pub struct MightBurned {
    pub v: u8,
    pub wallet: Pubkey,
    pub amount: u64,
    /// 0 ability unlock, 1 duel burn, 2 other
    pub reason: u8,
}

#[event]
pub struct UnitUpgraded {
    pub v: u8,
    pub wallet: Pubkey,
    pub unit: u8,
    pub level: u8,
    pub drills: u8,
    pub gold_spent: u64,
}

#[event]
pub struct AbilityUnlocked {
    pub v: u8,
    pub wallet: Pubkey,
    pub ability: u8,
    pub might_spent: u64,
}

#[event]
pub struct LoadoutSet {
    pub v: u8,
    pub wallet: Pubkey,
    pub loadout: [u8; 2],
}

#[event]
pub struct FormationSet {
    pub v: u8,
    pub wallet: Pubkey,
    pub formation: [crate::state::FormationSlot; 9],
    pub order: u8,
}

#[event]
pub struct Escrowed {
    pub v: u8,
    pub stake: u64,
    pub wallet: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub memo: String,
}

#[event]
pub struct Released {
    pub v: u8,
    pub stake: u64,
    pub amount: u64,
    pub burned: u64,
}

#[event]
pub struct RewardPaid {
    pub v: u8,
    pub wallet: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub memo: String,
}

#[event]
pub struct YieldConverted {
    pub v: u8,
    pub wallet: Pubkey,
    /// realized yield converted, micro-USDC
    pub usdc: u64,
    pub might: u64,
    pub realized_total: u64,
}

/// A battle resolved on-chain, with everything needed to replay and explain it.
#[event]
pub struct BattleResolved {
    pub v: u8,
    pub seq: u64,
    pub kind: u8,
    /// e.g. "B-0404", "boss:elder-treant", "duel:D-12"
    pub context: String,
    pub attacker: Pubkey,
    /// Pubkey::default() for camp guardians and bosses
    pub defender: Pubkey,
    pub seed: u32,
    pub attacker_side: crate::BattleSide,
    pub defender_side: crate::BattleSide,
    pub attacker_won: bool,
    pub ticks: u32,
    pub destruction_pm: u32,
    pub survival_pm: u32,
    pub score: u32,
    pub lost: [u32; 6],
}
