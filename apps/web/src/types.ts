import type {
  AssetCategory,
  AssetStatus,
  AssuranceLevel,
  AttestationMethod,
  AttestationResult,
  AttestationStatus,
  AutomatedCheckResult,
  CaptureSessionStatus,
  CaptureShot,
  CategoryPermissionStatus,
  ChainTransactionStatus,
  CheckProblem,
  ClaimType,
  EvidenceType,
  EvidenceVisibility,
  IdentityStatus,
  ItemCondition,
  ItemMatchResult,
  ProofSource,
  PurchaseCheckStatus,
  ReviewStatus,
  Role,
  TemplateVersionStatus,
  TokenizationStatus,
  TransferStatus,
  VerificationLevel,
  VerificationRequestStatus,
  VerifierReportRecommendation,
  VerifierEntityType,
  VerifierStatus,
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

export interface OwnerAssetListItem extends OwnerAsset {
  /** Private preview of one of the asset's photos (the first public one if any). */
  thumbnailPath: string | null;
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
  /** The shot this photo is, when taken in a guided capture session. */
  captureShot: CaptureShot | null;
  publicPath: string | null;
  /** The AI check of an owner upload; null if it was not checked. */
  automatedCheck: {
    status: AutomatedCheckResult | "PENDING" | "UNAVAILABLE";
    problems: CheckProblem[];
    checkedAt: string | null;
  } | null;
}

/** A guided capture session (`/assets/:wbId/capture-sessions`). */
export interface CaptureSession {
  id: string;
  /** Written on paper and photographed next to the item. */
  code: string;
  status: CaptureSessionStatus;
  shots: {
    shot: CaptureShot;
    instruction: string;
    evidenceId: string | null;
    receivedAt: string | null;
  }[];
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
}

/** A buyer's check before buying (`/purchase-checks/:id`); never names the seller. */
export interface PurchaseCheck {
  id: string;
  status: PurchaseCheckStatus;
  asset: {
    wbId: string;
    category: AssetCategory;
    brand: string | null;
    model: string | null;
    status: AssetStatus;
    verificationLevel: VerificationLevel;
    transferBlocked: boolean;
  };
  owner: {
    confirmed: boolean;
    confirmedAt: string | null;
    /** For the seller to sign, while valid and not yet signed. */
    code: string | null;
    codeExpiresAt: string | null;
    message: string | null;
  };
  item: {
    shots: { shot: CaptureShot; instruction: string; receivedAt: string | null }[];
    comparing: boolean;
    result: ItemMatchResult | null;
    reason: string | null;
    checkedAt: string | null;
    recordedPhotos: { path: string }[];
  };
  expiresAt: string;
  createdAt: string;
}

/** `GET /assets/:wbId/automated-checks`. */
export interface AutomatedChecksConsent {
  available: boolean;
  enabled: boolean;
  enabledAt: string | null;
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

export interface AdminTemplateVersion {
  id: string;
  version: number;
  validityMonths: number;
  status: TemplateVersionStatus;
  requiredClaims: ClaimType[];
  requiredEvidence: { type: EvidenceType; minCount: number }[];
  allowedMethods: AttestationMethod[];
  minVerifiers: number;
  createdById: string | null;
  publishedById: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface AdminTemplate {
  id: string;
  code: string;
  category: AssetCategory;
  name: string;
  description: string | null;
  createdAt: string;
  versions: AdminTemplateVersion[];
}

export interface RoleAssignment {
  id: string;
  walletAddress: string;
  role: Role;
  grantedById: string | null;
  grantedAt: string;
  revokedAt: string | null;
}

interface VerifierProfile {
  id: string;
  status: VerifierStatus;
  entityType: VerifierEntityType;
  businessName: string | null;
  website: string | null;
  bio: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  identityStatus: IdentityStatus;
}

interface StatusChange<S> {
  fromStatus: S | null;
  toStatus: S;
  reason: string | null;
  createdAt: string;
}

/** The applicant's own view (`GET /verifier/me`). */
export interface ApplicantVerifier extends VerifierProfile {
  identityRequired: boolean;
  canApplyAgainAt: string | null;
  categories: {
    category: AssetCategory;
    status: CategoryPermissionStatus;
    reason: string | null;
    approvedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }[];
  history: StatusChange<VerifierStatus>[];
}

export interface VerifierSummary {
  id: string;
  status: VerifierStatus;
  entityType: VerifierEntityType;
  businessName: string | null;
  walletAddress: string;
  identityStatus: IdentityStatus;
  categories: { category: AssetCategory; status: CategoryPermissionStatus }[];
  createdAt: string;
  updatedAt: string;
}

/** Reviewer view (`GET /review/verifiers/:verifierId`). */
export interface ReviewVerifier extends VerifierProfile {
  walletAddress: string;
  identityProvider: string | null;
  identityVerifiedAt: string | null;
  approvedById: string | null;
  categories: {
    id: string;
    category: AssetCategory;
    status: CategoryPermissionStatus;
    reason: string | null;
    approvedById: string | null;
    approvedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    history: (StatusChange<CategoryPermissionStatus> & { actorId: string | null })[];
  }[];
  history: (StatusChange<VerifierStatus> & { actorId: string | null })[];
}

/** Administrator view of an AI check, with the detection details (`GET /admin/automated-checks`). */
export interface AdminCheck {
  id: string;
  evidenceId: string;
  result: AutomatedCheckResult;
  problems: CheckProblem[];
  summary: string;
  confidence: number | null;
  engine: string;
  model: string;
  checkVersion: string;
  sha256: string;
  createdAt: string;
  wbId: string;
  evidence: { type: EvidenceType; mimeType: string; reviewStatus: ReviewStatus };
}

/** Reviewer view (`GET /review/verifiers/:verifierId/ai-reports`); advisory only. */
export interface VerifierReports {
  available: boolean;
  pending: boolean;
  lastError: string | null;
  items: {
    id: string;
    recommendation: VerifierReportRecommendation;
    summary: string;
    strengths: string[];
    concerns: string[];
    questions: string[];
    sources: string[];
    engine: string;
    model: string;
    reportVersion: string;
    createdAt: string;
  }[];
}

export interface Transfer {
  id: string;
  /** Paid by the buyer to the seller in the transfer transaction; "0" for none. */
  priceLamports: string;
  /** The caller's side of the transfer. */
  role: "SENDER" | "RECIPIENT";
  status: TransferStatus;
  closedReason: string | null;
  asset: { wbId: string; category: AssetCategory; brand: string | null; model: string | null };
  fromWalletAddress: string;
  toWalletAddress: string;
  /** Unsigned transaction (base64) to sign with the wallet, while accepted. */
  transaction: string | null;
  signedBySeller: boolean;
  signedByBuyer: boolean;
  awaitingYourSignature: boolean;
  chain: { status: ChainTransactionStatus; signature: string | null } | null;
  expiresAt: string;
  acceptedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}
