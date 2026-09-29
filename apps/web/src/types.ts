import type {
  AssetCategory,
  AssetStatus,
  AssuranceLevel,
  AttestationMethod,
  AttestationResult,
  AttestationStatus,
  ClaimType,
  EvidenceType,
  EvidenceVisibility,
  ItemCondition,
  ProofSource,
  ReviewStatus,
  TokenizationStatus,
  VerificationLevel,
  VerificationRequestStatus,
} from "@worthybound/shared";

/** Response shapes of the API (apps/api `view.ts` schemas). */
export interface Me {
  user: { id: string; walletAddress: string; displayName: string | null; identityStatus: string };
  roles: string[];
  session: { expiresAt: string };
}

export interface OwnerAsset {
  wbId: string;
  category: AssetCategory;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  description: string | null;
  publicDescription: string | null;
  attributes: Record<string, string | number | boolean>;
  condition: ItemCondition | null;
  status: AssetStatus;
  tokenizationStatus: TokenizationStatus;
  chainAssetAddress: string | null;
  chainRecordAddress: string | null;
  verificationLevel: VerificationLevel;
  trustScore: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  passportUrl: string | null;
  missingForPublish: string[];
}

export interface Points {
  code: string;
  points: number;
  count?: number;
}

export interface OwnerTrust {
  score: number;
  verificationLevel: VerificationLevel;
  factors: Points[];
  deductions: Points[];
  capsApplied: { code: string; limit: number }[];
  excludedProofs: { proofId: string; reason: string }[];
  engineVersion: string;
  weightsVersion: string;
  computedAt: string;
  disclaimer: string;
}

export interface OwnerEvidence {
  id: string;
  type: EvidenceType;
  source: ProofSource;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  visibility: EvidenceVisibility;
  reviewStatus: ReviewStatus;
  reviewReason: string | null;
  originalFilename: string | null;
  description: string | null;
  createdAt: string;
  publicPath: string | null;
}

export interface TemplateSummary {
  templateId: string;
  templateVersionId: string;
  code: string;
  name: string;
  version: number;
  validityMonths: number;
  requiredClaims: ClaimType[];
  requiredEvidence: { type: EvidenceType; minCount: number }[];
  allowedMethods: AttestationMethod[];
  minVerifiers: number;
}

export interface PublishedTemplate extends TemplateSummary {
  category: AssetCategory;
  description: string | null;
}

export interface AttestationSummary {
  id: string;
  claimType: ClaimType;
  result: AttestationResult;
  method: AttestationMethod;
  assuranceLevel: AssuranceLevel;
  conditionGrade: ItemCondition | null;
  status: AttestationStatus;
  issuedAt: string;
  expiresAt: string | null;
}

interface RequestFields {
  id: string;
  status: VerificationRequestStatus;
  template: TemplateSummary;
  closedReason: string | null;
  assignedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  createdAt: string;
  attestations: AttestationSummary[];
}

export interface OwnerRequest extends RequestFields {
  wbId: string;
  verifier: { id: string; publicName: string | null } | null;
}

export interface VerifierRequest extends RequestFields {
  assignedToYou: boolean;
  asset: {
    wbId: string;
    category: AssetCategory;
    brand: string | null;
    model: string | null;
    status: AssetStatus;
    publicDescription: string | null;
    ownerStatedCondition: ItemCondition | null;
    serialNumber: string | null;
    attributes: Record<string, unknown> | null;
  };
}
