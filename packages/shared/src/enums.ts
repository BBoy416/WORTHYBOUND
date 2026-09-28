// Domain enumerations. Each list mirrors the Prisma enum of the same name
// (packages/database/prisma/schema.prisma); a database test fails if they diverge.

export const IDENTITY_STATUSES = [
  "UNVERIFIED",
  "PENDING",
  "VERIFIED",
  "REJECTED",
  "EXPIRED",
] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export const ROLES = ["USER", "VERIFIER", "VERIFIER_REVIEWER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const ASSET_CATEGORIES = [
  "LUXURY_WATCH",
  "FINE_ART",
  "JEWELRY",
  "COLLECTIBLE_CAR",
  "COLLECTIBLE",
  "EQUIPMENT",
  "OTHER",
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_STATUSES = [
  "DRAFT",
  "TOKENIZED",
  "ACTIVE",
  "VERIFIED",
  "TRANSFER_PENDING",
  "REVERIFICATION_REQUIRED",
  "DISPUTED",
  "REPORTED_LOST",
  "REPORTED_STOLEN",
  "REVOKED",
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Overall physical condition, best first. Does not affect the Trust Score. */
export const ITEM_CONDITIONS = [
  "NEW",
  "EXCELLENT",
  "VERY_GOOD",
  "GOOD",
  "FAIR",
  "POOR",
  "FOR_PARTS",
] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

export const TOKENIZATION_STATUSES = ["NOT_TOKENIZED", "PENDING", "TOKENIZED", "FAILED"] as const;
export type TokenizationStatus = (typeof TOKENIZATION_STATUSES)[number];

export const VERIFICATION_LEVELS = [
  "UNVERIFIED",
  "SELF_DOCUMENTED",
  "INSPECTED",
  "AUTHENTICATED",
  "MULTI_VERIFIED",
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const OWNERSHIP_REASONS = [
  "REGISTRATION",
  "TRANSFER",
  "RECOVERY",
  "ADMIN_CORRECTION",
] as const;
export type OwnershipReason = (typeof OWNERSHIP_REASONS)[number];

export const TRANSFER_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/**
 * Who stands behind a proof.
 * OWNER: self-submitted. THIRD_PARTY: independent document from a known issuer
 * (e.g. dealer, auction house). VERIFIER: approved WorthyBound verifier.
 * MANUFACTURER: the brand or maker itself.
 */
export const PROOF_SOURCES = ["OWNER", "THIRD_PARTY", "VERIFIER", "MANUFACTURER"] as const;
export type ProofSource = (typeof PROOF_SOURCES)[number];

export const EVIDENCE_TYPES = [
  "PHOTO",
  "RECEIPT",
  "CERTIFICATE",
  "PROVENANCE_DOCUMENT",
  "SERIAL_NUMBER",
  "INSPECTION_REPORT",
  "APPRAISAL_DOCUMENT",
  "CONDITION_REPORT",
  "SERVICE_RECORD",
  "OWNERSHIP_DOCUMENT",
  "MANUFACTURER_DOCUMENT",
  "VIDEO",
  "OTHER",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_VISIBILITIES = ["PRIVATE", "PUBLIC"] as const;
export type EvidenceVisibility = (typeof EVIDENCE_VISIBILITIES)[number];

export const EVIDENCE_UPLOAD_STATUSES = ["PENDING", "COMPLETED", "FAILED"] as const;
export type EvidenceUploadStatus = (typeof EVIDENCE_UPLOAD_STATUSES)[number];

export const REVIEW_STATUSES = ["PENDING", "ACCEPTED", "REJECTED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const VERIFIER_STATUSES = [
  "APPLIED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "REVOKED",
] as const;
export type VerifierStatus = (typeof VERIFIER_STATUSES)[number];

export const VERIFIER_ENTITY_TYPES = [
  "INDIVIDUAL",
  "BUSINESS",
  "LABORATORY",
  "MANUFACTURER",
] as const;
export type VerifierEntityType = (typeof VERIFIER_ENTITY_TYPES)[number];

export const CATEGORY_PERMISSION_STATUSES = [
  "PENDING",
  "APPROVED",
  "SUSPENDED",
  "REVOKED",
] as const;
export type CategoryPermissionStatus = (typeof CATEGORY_PERMISSION_STATUSES)[number];

export const TEMPLATE_VERSION_STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export type TemplateVersionStatus = (typeof TEMPLATE_VERSION_STATUSES)[number];

export const VERIFICATION_REQUEST_STATUSES = [
  "OPEN",
  "ASSIGNED",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type VerificationRequestStatus = (typeof VERIFICATION_REQUEST_STATUSES)[number];

/** What a verifier attests to. Verification is claim-based; there is no generic "verified" flag. */
export const CLAIM_TYPES = [
  "SERIAL_NUMBER",
  "POSSESSION",
  "CONDITION",
  "INSPECTION",
  "AUTHENTICATION",
  "APPRAISAL",
  "PROVENANCE",
  "CERTIFICATE",
  "PHYSICAL_EXISTENCE",
  "IDENTITY_OF_PRESENTER",
  "DOCUMENTATION",
  "OWNERSHIP_CLAIM",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const ATTESTATION_RESULTS = ["CONFIRMED", "CONTRADICTED", "INCONCLUSIVE"] as const;
export type AttestationResult = (typeof ATTESTATION_RESULTS)[number];

export const ATTESTATION_METHODS = [
  "IN_PERSON",
  "REMOTE",
  "LABORATORY",
  "DOCUMENT_REVIEW",
] as const;
export type AttestationMethod = (typeof ATTESTATION_METHODS)[number];

export const ASSURANCE_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export const ATTESTATION_STATUSES = [
  "ACTIVE",
  "EXPIRED",
  "SUPERSEDED",
  "DISPUTED",
  "REVOKED",
] as const;
export type AttestationStatus = (typeof ATTESTATION_STATUSES)[number];

export const DISPUTE_STATUSES = [
  "OPEN",
  "UNDER_REVIEW",
  "UPHELD",
  "REJECTED",
  "WITHDRAWN",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const PROVENANCE_EVENT_TYPES = [
  "REGISTERED",
  "TOKENIZED",
  "EVIDENCE_ADDED",
  "EVIDENCE_VISIBILITY_CHANGED",
  "EVIDENCE_COMMITTED",
  "ATTESTATION_ADDED",
  "ATTESTATION_REVOKED",
  "TRANSFER_REQUESTED",
  "TRANSFER_COMPLETED",
  "STATUS_CHANGED",
  "CONDITION_UPDATED",
  "DETAILS_UPDATED",
  "REVERIFICATION_REQUIRED",
  "REPORTED_LOST",
  "REPORTED_STOLEN",
  "RECOVERED",
  "DISPUTE_OPENED",
  "DISPUTE_RESOLVED",
] as const;
export type ProvenanceEventType = (typeof PROVENANCE_EVENT_TYPES)[number];

export const SOLANA_CLUSTERS = ["LOCALNET", "DEVNET"] as const;
export type SolanaCluster = (typeof SOLANA_CLUSTERS)[number];

export const CHAIN_TRANSACTION_KINDS = [
  "REGISTER_ASSET",
  "MINT_ASSET",
  "COMMIT_EVIDENCE",
  "APPROVE_VERIFIER",
  "UPDATE_VERIFIER",
  "SUBMIT_ATTESTATION",
  "REVOKE_ATTESTATION",
  "COMMIT_TRUST_SCORE",
  "TRANSFER_ASSET",
  "UPDATE_ASSET_STATUS",
] as const;
export type ChainTransactionKind = (typeof CHAIN_TRANSACTION_KINDS)[number];

export const CHAIN_ENTITY_TYPES = [
  "ASSET",
  "VERIFIER",
  "ATTESTATION",
  "EVIDENCE_COMMITMENT",
  "TRUST_SCORE_SNAPSHOT",
  "TRANSFER_REQUEST",
] as const;
export type ChainEntityType = (typeof CHAIN_ENTITY_TYPES)[number];

export const CHAIN_TRANSACTION_STATUSES = [
  "PENDING",
  "SUBMITTED",
  "CONFIRMED",
  "FINALIZED",
  "FAILED",
] as const;
export type ChainTransactionStatus = (typeof CHAIN_TRANSACTION_STATUSES)[number];

/** Every enumeration keyed by its Prisma enum name. */
export const DOMAIN_ENUMS = {
  IdentityStatus: IDENTITY_STATUSES,
  Role: ROLES,
  AssetCategory: ASSET_CATEGORIES,
  AssetStatus: ASSET_STATUSES,
  ItemCondition: ITEM_CONDITIONS,
  TokenizationStatus: TOKENIZATION_STATUSES,
  VerificationLevel: VERIFICATION_LEVELS,
  OwnershipReason: OWNERSHIP_REASONS,
  TransferStatus: TRANSFER_STATUSES,
  ProofSource: PROOF_SOURCES,
  EvidenceType: EVIDENCE_TYPES,
  EvidenceVisibility: EVIDENCE_VISIBILITIES,
  EvidenceUploadStatus: EVIDENCE_UPLOAD_STATUSES,
  ReviewStatus: REVIEW_STATUSES,
  VerifierStatus: VERIFIER_STATUSES,
  VerifierEntityType: VERIFIER_ENTITY_TYPES,
  CategoryPermissionStatus: CATEGORY_PERMISSION_STATUSES,
  TemplateVersionStatus: TEMPLATE_VERSION_STATUSES,
  VerificationRequestStatus: VERIFICATION_REQUEST_STATUSES,
  ClaimType: CLAIM_TYPES,
  AttestationResult: ATTESTATION_RESULTS,
  AttestationMethod: ATTESTATION_METHODS,
  AssuranceLevel: ASSURANCE_LEVELS,
  AttestationStatus: ATTESTATION_STATUSES,
  DisputeStatus: DISPUTE_STATUSES,
  ProvenanceEventType: PROVENANCE_EVENT_TYPES,
  SolanaCluster: SOLANA_CLUSTERS,
  ChainTransactionKind: CHAIN_TRANSACTION_KINDS,
  ChainEntityType: CHAIN_ENTITY_TYPES,
  ChainTransactionStatus: CHAIN_TRANSACTION_STATUSES,
} as const;
