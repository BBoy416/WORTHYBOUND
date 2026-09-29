//! WorthyBound asset registry (ADR 0002, ADR 0016). Devnet only.
//!
//! Every registered asset is a Metaplex Core asset owned by the owner's wallet and frozen from
//! creation. The config PDA holds its update authority and its permanent freeze and transfer
//! delegates, so the owner cannot move, thaw or burn it; `transfer_asset` is the only way it
//! changes hands. The backend oracle mirrors the asset's status and Trust Score to a public
//! record; private data never goes on-chain.

use anchor_lang::prelude::*;
use mpl_core::instructions::{CreateV2CpiBuilder, TransferV1CpiBuilder, UpdatePluginV1CpiBuilder};
use mpl_core::types::{
    PermanentFreezeDelegate, PermanentTransferDelegate, Plugin, PluginAuthority,
    PluginAuthorityPair,
};

pub mod error;
pub mod state;

use error::WbError;
use state::*;

declare_id!("5stfBCcoD9mpW3514ycoKZBQ4Xzav3KpbZHTC9AUGMem");

#[program]
pub mod worthybound {
    use super::*;

    /// Creates the config. Only the program's upgrade authority can call it, once.
    pub fn initialize(ctx: Context<Initialize>, oracle: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.oracle = oracle;
        config.paused = false;
        config.asset_count = 0;
        config.bump = ctx.bumps.config;
        emit!(ConfigChanged { admin: config.admin, oracle, paused: false });
        Ok(())
    }

    pub fn set_oracle(ctx: Context<AdminOnly>, oracle: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.oracle = oracle;
        emit!(ConfigChanged { admin: config.admin, oracle, paused: config.paused });
        Ok(())
    }

    /// Stops registrations, status and score updates and transfers until unpaused.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.paused = paused;
        emit!(ConfigChanged { admin: config.admin, oracle: config.oracle, paused });
        Ok(())
    }

    /// Creates the asset record and mints its Core asset, frozen, to the owner's wallet.
    pub fn register_asset(
        ctx: Context<RegisterAsset>,
        wb_id: String,
        uri: String,
        status: AssetStatus,
        status_seq: u64,
    ) -> Result<()> {
        require!(is_wb_id(&wb_id), WbError::InvalidWbId);
        require!(!uri.is_empty() && uri.len() <= MAX_URI_LEN, WbError::InvalidUri);
        require!(status.is_after_transfer(), WbError::InvalidInitialStatus);

        let config_bump = ctx.accounts.config.bump;
        let core_bump = ctx.bumps.core_asset;
        let config_seeds: &[&[u8]] = &[CONFIG_SEED, &[config_bump]];
        let core_seeds: &[&[u8]] = &[CORE_ASSET_SEED, wb_id.as_bytes(), &[core_bump]];
        let config_info = ctx.accounts.config.to_account_info();

        CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
            .asset(&ctx.accounts.core_asset.to_account_info())
            .payer(&ctx.accounts.oracle.to_account_info())
            .owner(Some(&ctx.accounts.owner.to_account_info()))
            .update_authority(Some(&config_info))
            .system_program(&ctx.accounts.system_program.to_account_info())
            .name(format!("WorthyBound {wb_id}"))
            .uri(uri)
            .plugins(vec![
                PluginAuthorityPair {
                    plugin: Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate {
                        frozen: true,
                    }),
                    authority: Some(PluginAuthority::Address { address: config_info.key() }),
                },
                PluginAuthorityPair {
                    plugin: Plugin::PermanentTransferDelegate(PermanentTransferDelegate {}),
                    authority: Some(PluginAuthority::Address { address: config_info.key() }),
                },
            ])
            .invoke_signed(&[core_seeds, config_seeds])?;

        let now = Clock::get()?.unix_timestamp;
        let record = &mut ctx.accounts.asset_record;
        record.wb_id = wb_id.clone();
        record.core_asset = ctx.accounts.core_asset.key();
        record.owner = ctx.accounts.owner.key();
        record.status = status;
        record.status_seq = status_seq;
        record.trust_score = 0;
        record.verification_level = VerificationLevel::Unverified;
        record.engine_version = String::new();
        record.weights_version = String::new();
        record.inputs_hash = [0; 32];
        record.trust_seq = 0;
        record.registered_at = now;
        record.transfer_count = 0;
        record.bump = ctx.bumps.asset_record;
        record.core_asset_bump = core_bump;

        let config = &mut ctx.accounts.config;
        config.asset_count = config.asset_count.checked_add(1).unwrap();

        emit!(AssetRegistered {
            wb_id,
            core_asset: record.core_asset,
            owner: record.owner,
            status,
        });
        Ok(())
    }

    /// Mirrors a status change recorded by the backend. Ownership changes only through
    /// `transfer_asset`, and REVOKED is final.
    pub fn update_status(
        ctx: Context<OracleUpdate>,
        status: AssetStatus,
        status_seq: u64,
    ) -> Result<()> {
        let record = &mut ctx.accounts.asset_record;
        require!(record.status != AssetStatus::Revoked, WbError::AssetRevoked);
        require!(
            !matches!(status, AssetStatus::Draft | AssetStatus::Tokenized),
            WbError::InvalidStatus
        );
        require!(status_seq > record.status_seq, WbError::StaleUpdate);
        let previous = record.status;
        record.status = status;
        record.status_seq = status_seq;
        emit!(StatusUpdated { wb_id: record.wb_id.clone(), previous, status, status_seq });
        Ok(())
    }

    /// Records a Trust Score snapshot computed by the backend (ADR 0015).
    pub fn commit_trust_score(
        ctx: Context<OracleUpdate>,
        score: u8,
        level: VerificationLevel,
        engine_version: String,
        weights_version: String,
        inputs_hash: [u8; 32],
        trust_seq: u64,
    ) -> Result<()> {
        require!(score <= MAX_TRUST_SCORE, WbError::InvalidTrustScore);
        require!(
            !engine_version.is_empty() && engine_version.len() <= MAX_ENGINE_VERSION_LEN,
            WbError::InvalidVersion
        );
        require!(
            !weights_version.is_empty() && weights_version.len() <= MAX_WEIGHTS_VERSION_LEN,
            WbError::InvalidVersion
        );
        let record = &mut ctx.accounts.asset_record;
        require!(record.status != AssetStatus::Revoked, WbError::AssetRevoked);
        require!(trust_seq > record.trust_seq, WbError::StaleUpdate);
        record.trust_score = score;
        record.verification_level = level;
        record.engine_version = engine_version.clone();
        record.weights_version = weights_version.clone();
        record.inputs_hash = inputs_hash;
        record.trust_seq = trust_seq;
        emit!(TrustScoreCommitted {
            wb_id: record.wb_id.clone(),
            score,
            level,
            engine_version,
            weights_version,
            inputs_hash,
            trust_seq,
        });
        Ok(())
    }

    /// Completes a transfer (ADR 0002): seller, buyer and oracle sign; the oracle confirms the
    /// backend checks (buyer KYC, acceptance). Thaws, transfers and re-freezes the Core asset in
    /// this one instruction.
    pub fn transfer_asset(
        ctx: Context<TransferAsset>,
        status_after: AssetStatus,
        status_seq: u64,
    ) -> Result<()> {
        let record = &ctx.accounts.asset_record;
        require!(record.status == AssetStatus::TransferPending, WbError::NotTransferPending);
        require!(status_after.is_after_transfer(), WbError::InvalidStatusAfterTransfer);
        require!(status_seq > record.status_seq, WbError::StaleUpdate);
        require_keys_eq!(record.owner, ctx.accounts.seller.key(), WbError::NotOwner);
        require_keys_neq!(ctx.accounts.seller.key(), ctx.accounts.buyer.key(), WbError::SameOwner);
        {
            let data = ctx.accounts.core_asset.try_borrow_data()?;
            let core = mpl_core::accounts::BaseAssetV1::from_bytes(&data)
                .map_err(|_| error!(WbError::CoreAssetMismatch))?;
            require_keys_eq!(core.owner, ctx.accounts.seller.key(), WbError::NotOwner);
        }

        let config_seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        let core_program = ctx.accounts.mpl_core_program.to_account_info();
        let core_asset = ctx.accounts.core_asset.to_account_info();
        let config_info = ctx.accounts.config.to_account_info();
        let payer = ctx.accounts.oracle.to_account_info();
        let system_program = ctx.accounts.system_program.to_account_info();

        set_frozen(&core_program, &core_asset, &config_info, &payer, &system_program, false, config_seeds)?;
        TransferV1CpiBuilder::new(&core_program)
            .asset(&core_asset)
            .payer(&payer)
            .authority(Some(&config_info))
            .new_owner(&ctx.accounts.buyer.to_account_info())
            .system_program(Some(&system_program))
            .invoke_signed(&[config_seeds])?;
        set_frozen(&core_program, &core_asset, &config_info, &payer, &system_program, true, config_seeds)?;

        let record = &mut ctx.accounts.asset_record;
        let seller = record.owner;
        record.owner = ctx.accounts.buyer.key();
        record.status = status_after;
        record.status_seq = status_seq;
        record.transfer_count = record.transfer_count.checked_add(1).unwrap();
        emit!(AssetTransferred {
            wb_id: record.wb_id.clone(),
            seller,
            buyer: record.owner,
            status: status_after,
            status_seq,
        });
        Ok(())
    }
}

fn set_frozen<'a>(
    core_program: &AccountInfo<'a>,
    core_asset: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    frozen: bool,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    UpdatePluginV1CpiBuilder::new(core_program)
        .asset(core_asset)
        .payer(payer)
        .authority(Some(authority))
        .system_program(system_program)
        .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen }))
        .invoke_signed(&[signer_seeds])?;
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ WbError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::Worthybound>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ WbError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ WbError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(wb_id: String)]
pub struct RegisterAsset<'info> {
    /// Signs and pays for the record and the Core asset.
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle @ WbError::NotOracle,
        constraint = !config.paused @ WbError::Paused,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = oracle,
        space = 8 + AssetRecord::INIT_SPACE,
        seeds = [ASSET_SEED, wb_id.as_bytes()],
        bump,
    )]
    pub asset_record: Account<'info, AssetRecord>,
    /// CHECK: created by Metaplex Core at this PDA; the program signs for it.
    #[account(mut, seeds = [CORE_ASSET_SEED, wb_id.as_bytes()], bump)]
    pub core_asset: UncheckedAccount<'info>,
    /// CHECK: the owner's wallet; receives the Core asset and does not sign.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OracleUpdate<'info> {
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle @ WbError::NotOracle,
        constraint = !config.paused @ WbError::Paused,
    )]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ASSET_SEED, asset_record.wb_id.as_bytes()], bump = asset_record.bump)]
    pub asset_record: Account<'info, AssetRecord>,
}

#[derive(Accounts)]
pub struct TransferAsset<'info> {
    /// Signs for the backend checks and pays the fees.
    #[account(mut)]
    pub oracle: Signer<'info>,
    pub seller: Signer<'info>,
    pub buyer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle @ WbError::NotOracle,
        constraint = !config.paused @ WbError::Paused,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [ASSET_SEED, asset_record.wb_id.as_bytes()],
        bump = asset_record.bump,
        has_one = core_asset @ WbError::CoreAssetMismatch,
    )]
    pub asset_record: Account<'info, AssetRecord>,
    /// CHECK: must be the record's Core asset (has_one) and owned by Metaplex Core.
    #[account(mut, owner = mpl_core::ID @ WbError::CoreAssetMismatch)]
    pub core_asset: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct ConfigChanged {
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub paused: bool,
}

#[event]
pub struct AssetRegistered {
    pub wb_id: String,
    pub core_asset: Pubkey,
    pub owner: Pubkey,
    pub status: AssetStatus,
}

#[event]
pub struct StatusUpdated {
    pub wb_id: String,
    pub previous: AssetStatus,
    pub status: AssetStatus,
    pub status_seq: u64,
}

#[event]
pub struct TrustScoreCommitted {
    pub wb_id: String,
    pub score: u8,
    pub level: VerificationLevel,
    pub engine_version: String,
    pub weights_version: String,
    pub inputs_hash: [u8; 32],
    pub trust_seq: u64,
}

#[event]
pub struct AssetTransferred {
    pub wb_id: String,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub status: AssetStatus,
    pub status_seq: u64,
}
