import {
  ASSET_STATUSES,
  CLAIM_TYPES,
  PROOF_SOURCES,
  type AssetStatus,
  type ProofSource,
  type VerificationLevel,
} from "@worthybound/shared";

export { ASSET_STATUSES, PROOF_SOURCES };
export type { AssetStatus, ProofSource, VerificationLevel };

/** What a proof demonstrates: owner-submitted photos and receipts, plus every claim type. */
export const PROOF_TYPES = ["PHOTO", "RECEIPT", ...CLAIM_TYPES] as const;
export type ProofType = (typeof PROOF_TYPES)[number];

export type ProofStatus = "ACTIVE" | "REVOKED" | "SUPERSEDED" | "REJECTED";

/** Status of the party behind the proof (relevant for verifiers). */
export type SourceStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface Proof {
  id: string;
  type: ProofType;
  source: ProofSource;
  /** Identifier of the issuing party (uploader, verifier or manufacturer). Drives independence. */
  sourceId: string;
  /** ISO-8601 timestamp. */
  issuedAt: string;
  /** ISO-8601 timestamp. Proofs at or past expiry do not count. */
  expiresAt?: string;
  status: ProofStatus;
  /** Outcome of a claim. CONTRADICTED is a negative finding (e.g. "serial does not match"). */
  result?: "CONFIRMED" | "CONTRADICTED";
  sourceStatus?: SourceStatus;
}

export interface TrustInputs {
  assetId: string;
  category: string;
  status: AssetStatus;
  owner: {
    walletVerified: boolean;
    identityVerified: boolean;
  };
  /** ISO-8601 start of the current owner's custody. POSSESSION/CONDITION claims before this do not count. */
  currentCustodySince: string;
  custodyContinuous: boolean;
  proofs: readonly Proof[];
  openDisputes: number;
  /** Number of template-required evidence items that are missing. */
  missingRequiredEvidence?: number;
  /** ISO-8601 evaluation time. Injected so results are reproducible. */
  evaluatedAt: string;
}

export interface FreshnessRule {
  /** Days after which the proof counts half. null = no decay. */
  halfLifeDays: number | null;
  /** Lower bound for the freshness factor. */
  minFactor: number;
}

export interface TrustWeights {
  version: string;
  typePoints: Record<ProofType, number>;
  sourceMultiplier: Record<ProofSource, number>;
  /** Maximum total points each source class can contribute. */
  sourceCeiling: Record<ProofSource, number>;
  freshness: Record<ProofType, FreshnessRule>;
  /** Multiplier applied to the nth repeat (0-based) of the same type from the same party: decay^n. */
  repeatDecay: number;
  /** Weight multiplier for proofs from a suspended party. */
  suspendedSourceMultiplier: number;
  identity: {
    walletVerified: number;
    identityVerified: number;
  };
  custodyContinuity: number;
  independence: {
    /** Points per additional independent verifier/manufacturer beyond the first. */
    pointsPerAdditionalSource: number;
    maxPoints: number;
  };
  caps: {
    /** No counted verifier or manufacturer proof. */
    selfDocumented: number;
    /** Same as selfDocumented, when the owner is identity-verified (KYC). */
    selfDocumentedIdentityVerified: number;
    /** No counted INSPECTION or AUTHENTICATION from a verifier/manufacturer. */
    withoutInspection: number;
    /** No counted AUTHENTICATION plus PROVENANCE. */
    withoutAuthenticationAndProvenance: number;
    /** High-risk categories without at least two independent verifiers/manufacturers. */
    highRiskWithoutMultipleVerifiers: number;
  };
  highRiskCategories: readonly string[];
  statusCaps: Partial<Record<AssetStatus, number>>;
  deductions: {
    openDispute: { points: number; max: number };
    contradictedClaim: { points: number; max: number };
    revokedProof: { points: number; max: number };
    suspendedSource: { points: number; max: number };
    missingRequiredEvidence: { points: number; max: number };
    brokenCustody: number;
    staleVerification: number;
  };
}

export interface TrustFactor {
  code: string;
  points: number;
  proofId?: string;
  detail?: Record<string, number | string>;
}

export interface TrustDeduction {
  code: string;
  points: number;
  count?: number;
  proofIds?: string[];
}

export interface ExcludedProof {
  proofId: string;
  reason:
    | "REVOKED"
    | "SUPERSEDED"
    | "REJECTED"
    | "EXPIRED"
    | "CONTRADICTED"
    | "SOURCE_REVOKED"
    | "PREDATES_CURRENT_CUSTODY"
    | "ISSUED_AFTER_EVALUATION";
}

export interface AppliedCap {
  code: string;
  limit: number;
}

export interface TrustResult {
  score: number;
  verificationLevel: VerificationLevel;
  factors: TrustFactor[];
  deductions: TrustDeduction[];
  capsApplied: AppliedCap[];
  excludedProofs: ExcludedProof[];
  engineVersion: string;
  weightsVersion: string;
  inputsHash: string;
  computedAt: string;
}
