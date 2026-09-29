import type {
  AssetStatus as DomainAssetStatus,
  VerificationLevel as DomainVerificationLevel,
} from "@worthybound/shared";
import { AssetStatus, VerificationLevel } from "./generated/index.js";

const ASSET_STATUS: Record<DomainAssetStatus, AssetStatus> = {
  DRAFT: AssetStatus.Draft,
  TOKENIZED: AssetStatus.Tokenized,
  ACTIVE: AssetStatus.Active,
  VERIFIED: AssetStatus.Verified,
  TRANSFER_PENDING: AssetStatus.TransferPending,
  REVERIFICATION_REQUIRED: AssetStatus.ReverificationRequired,
  DISPUTED: AssetStatus.Disputed,
  REPORTED_LOST: AssetStatus.ReportedLost,
  REPORTED_STOLEN: AssetStatus.ReportedStolen,
  REVOKED: AssetStatus.Revoked,
};

const VERIFICATION_LEVEL: Record<DomainVerificationLevel, VerificationLevel> = {
  UNVERIFIED: VerificationLevel.Unverified,
  SELF_DOCUMENTED: VerificationLevel.SelfDocumented,
  INSPECTED: VerificationLevel.Inspected,
  AUTHENTICATED: VerificationLevel.Authenticated,
  MULTI_VERIFIED: VerificationLevel.MultiVerified,
};

export function toChainAssetStatus(status: DomainAssetStatus): AssetStatus {
  return ASSET_STATUS[status];
}

export function toChainVerificationLevel(level: DomainVerificationLevel): VerificationLevel {
  return VERIFICATION_LEVEL[level];
}
