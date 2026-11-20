use anchor_lang::prelude::*;

#[error_code]
pub enum GameError {
    #[msg("Only the game authority can do that.")]
    NotAuthority,
    #[msg("Only the player or the game authority can do that.")]
    NotPlayerOrAuthority,
    #[msg("Unknown unit.")]
    BadUnit,
    #[msg("That unit is already at the maximum level.")]
    MaxLevel,
    #[msg("Drills for that unit are maxed.")]
    MaxDrills,
    #[msg("Unknown ability.")]
    BadAbility,
    #[msg("That ability is already unlocked.")]
    AlreadyUnlocked,
    #[msg("Only unlocked abilities can be brought into battle.")]
    NotUnlocked,
    #[msg("A formation needs at least one unit and a valid order.")]
    BadFormation,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("This stake was already released.")]
    AlreadyReleased,
    #[msg("Payouts and burn exceed the stake.")]
    Overpaid,
    #[msg("Memo or context too long.")]
    TooLong,
    #[msg("The SlotHashes sysvar could not be read.")]
    BadSlotHashes,
    #[msg("A profile account does not belong to that side.")]
    WrongProfile,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
