use anchor_lang::prelude::*;

#[error_code]
pub enum WbError {
    #[msg("Only the program upgrade authority can initialize the program")]
    NotUpgradeAuthority,
    #[msg("Signer is not the program admin")]
    NotAdmin,
    #[msg("Signer is not the WorthyBound oracle")]
    NotOracle,
    #[msg("The program is paused")]
    Paused,
    #[msg("Expected an asset ID like WB-7F93A281")]
    InvalidWbId,
    #[msg("Metadata URI is empty or too long")]
    InvalidUri,
    #[msg("Version label is empty or too long")]
    InvalidVersion,
    #[msg("Trust Score must be between 0 and 100")]
    InvalidTrustScore,
    #[msg("Assets can only be registered as ACTIVE, VERIFIED or REVERIFICATION_REQUIRED")]
    InvalidInitialStatus,
    #[msg("This status cannot be set directly")]
    InvalidStatus,
    #[msg("A newer update has already been recorded")]
    StaleUpdate,
    #[msg("A revoked asset cannot change")]
    AssetRevoked,
    #[msg("The asset is not pending transfer")]
    NotTransferPending,
    #[msg("A transfer must complete as ACTIVE, VERIFIED or REVERIFICATION_REQUIRED")]
    InvalidStatusAfterTransfer,
    #[msg("The seller is not the current owner")]
    NotOwner,
    #[msg("The buyer is already the owner")]
    SameOwner,
    #[msg("The Core asset does not match the record")]
    CoreAssetMismatch,
}
