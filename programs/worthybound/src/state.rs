use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ASSET_SEED: &[u8] = b"asset";
pub const CORE_ASSET_SEED: &[u8] = b"core";

pub const WB_ID_LEN: usize = 11;
pub const MAX_URI_LEN: usize = 200;
pub const MAX_ENGINE_VERSION_LEN: usize = 16;
pub const MAX_WEIGHTS_VERSION_LEN: usize = 24;
pub const MAX_TRUST_SCORE: u8 = 100;

/// Program settings. Its PDA is the update authority, permanent freeze delegate and permanent
/// transfer delegate of every WorthyBound Core asset.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Program upgrade authority at initialization; changes the oracle and pauses the program.
    pub admin: Pubkey,
    /// Backend key that registers assets and mirrors their status and Trust Score (ADR 0016).
    pub oracle: Pubkey,
    pub paused: bool,
    pub asset_count: u64,
    pub bump: u8,
}

/// Public on-chain record of a WorthyBound asset. Holds no private data: no serial number,
/// evidence, owner identity or attestation notes.
#[account]
#[derive(InitSpace)]
pub struct AssetRecord {
    #[max_len(WB_ID_LEN)]
    pub wb_id: String,
    /// Metaplex Core asset, frozen from creation.
    pub core_asset: Pubkey,
    pub owner: Pubkey,
    pub status: AssetStatus,
    /// Backend time (Unix ms) of the status change mirrored last; older updates are rejected.
    pub status_changed_at: i64,
    pub trust_score: u8,
    pub verification_level: VerificationLevel,
    #[max_len(MAX_ENGINE_VERSION_LEN)]
    pub engine_version: String,
    #[max_len(MAX_WEIGHTS_VERSION_LEN)]
    pub weights_version: String,
    /// SHA-256 of the Trust Score inputs, as stored in the backend snapshot.
    pub inputs_hash: [u8; 32],
    /// Backend time (Unix ms) of the Trust Score snapshot committed last; 0 before the first.
    pub trust_snapshot_at: i64,
    pub registered_at: i64,
    pub transfer_count: u32,
    pub bump: u8,
    pub core_asset_bump: u8,
}

/// Mirrors `AssetStatus` in `packages/shared/src/enums.ts`, in the same order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AssetStatus {
    Draft,
    Tokenized,
    Active,
    Verified,
    TransferPending,
    ReverificationRequired,
    Disputed,
    ReportedLost,
    ReportedStolen,
    Revoked,
}

impl AssetStatus {
    /// Statuses a transfer may complete into (ADR 0006 lifecycle, from TRANSFER_PENDING).
    pub fn is_after_transfer(self) -> bool {
        matches!(
            self,
            AssetStatus::Active | AssetStatus::Verified | AssetStatus::ReverificationRequired
        )
    }
}

/// Mirrors `VerificationLevel` in `packages/shared/src/enums.ts`, in the same order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VerificationLevel {
    Unverified,
    SelfDocumented,
    Inspected,
    Authenticated,
    MultiVerified,
}

/// Same format as `WB_ID_PATTERN` in `packages/shared/src/ids.ts`: `WB-` and 8 upper-case hex digits.
pub fn is_wb_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == WB_ID_LEN
        && bytes.starts_with(b"WB-")
        && bytes[3..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(b))
}
