import type {
  AssetCategory,
  AssetStatus,
  AssuranceLevel,
  AttestationMethod,
  AttestationResult,
  AttestationStatus,
  ClaimType,
  EvidenceType,
  IdentityStatus,
  ItemCondition,
  ReviewStatus,
  TemplateVersionStatus,
  VerificationRequestStatus,
  VerifierStatus,
} from "./enums.js";

/** Requirements stored on a verification template version. */
export interface TemplateRequirements {
  requiredClaims: readonly ClaimType[];
  requiredEvidence: readonly { type: EvidenceType; minCount: number }[];
  allowedMethods: readonly AttestationMethod[];
  /** Distinct approved verifiers that must confirm each required claim. */
  minVerifiers: number;
}

/** Asset statuses in which new attestations may be recorded. */
export const ATTESTABLE_ASSET_STATUSES: readonly AssetStatus[] = [
  "TOKENIZED",
  "ACTIVE",
  "VERIFIED",
  "REVERIFICATION_REQUIRED",
];

export const ATTESTATION_AUTHORITY_VIOLATIONS = [
  "VERIFIER_NOT_APPROVED",
  "VERIFIER_IDENTITY_NOT_VERIFIED",
  "NO_CATEGORY_PERMISSION",
  "OWN_ASSET",
  "ASSET_NOT_ATTESTABLE",
  "TEMPLATE_NOT_PUBLISHED",
  "TEMPLATE_CATEGORY_MISMATCH",
  "CLAIM_NOT_IN_TEMPLATE",
  "METHOD_NOT_ALLOWED",
] as const;
export type AttestationAuthorityViolation = (typeof ATTESTATION_AUTHORITY_VIOLATIONS)[number];

export interface AttestationAuthorityContext {
  verifier: {
    userId: string;
    status: VerifierStatus;
    /** KYC status of the verifier's user; must still be VERIFIED (ADR 0004). */
    identityStatus: IdentityStatus;
    /** Categories with an APPROVED permission. */
    approvedCategories: readonly AssetCategory[];
  };
  asset: { ownerId: string; category: AssetCategory; status: AssetStatus };
  template: {
    status: TemplateVersionStatus;
    category: AssetCategory;
    requirements: Pick<TemplateRequirements, "requiredClaims" | "allowedMethods">;
  };
  claimType: ClaimType;
  method: AttestationMethod;
}

/**
 * Every reason the verifier may not record this attestation; empty if allowed. Includes the
 * rules the database enforces (migration `*_integrity`) so the API can explain a rejection
 * before writing.
 */
export function attestationAuthorityViolations(
  ctx: AttestationAuthorityContext,
): AttestationAuthorityViolation[] {
  const violations: AttestationAuthorityViolation[] = [];
  if (ctx.verifier.status !== "APPROVED") violations.push("VERIFIER_NOT_APPROVED");
  if (ctx.verifier.identityStatus !== "VERIFIED") violations.push("VERIFIER_IDENTITY_NOT_VERIFIED");
  if (!ctx.verifier.approvedCategories.includes(ctx.asset.category)) {
    violations.push("NO_CATEGORY_PERMISSION");
  }
  if (ctx.verifier.userId === ctx.asset.ownerId) violations.push("OWN_ASSET");
  if (!ATTESTABLE_ASSET_STATUSES.includes(ctx.asset.status))
    violations.push("ASSET_NOT_ATTESTABLE");
  if (ctx.template.status !== "PUBLISHED") violations.push("TEMPLATE_NOT_PUBLISHED");
  if (ctx.template.category !== ctx.asset.category) violations.push("TEMPLATE_CATEGORY_MISMATCH");
  if (!ctx.template.requirements.requiredClaims.includes(ctx.claimType)) {
    violations.push("CLAIM_NOT_IN_TEMPLATE");
  }
  if (!ctx.template.requirements.allowedMethods.includes(ctx.method)) {
    violations.push("METHOD_NOT_ALLOWED");
  }
  return violations;
}

// ─── Verification requests ────────────────────────────────────────────────────

/** A request that is not taken up or completed within this time expires. */
export const VERIFICATION_REQUEST_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Requests that are still in progress; at most one per asset and template version. */
export const OPEN_REQUEST_STATUSES: readonly VerificationRequestStatus[] = ["OPEN", "ASSIGNED"];

/** Asset statuses in which open requests are cancelled: the asset cannot be verified any more. */
export const REQUEST_CANCELLING_ASSET_STATUSES: readonly AssetStatus[] = [
  "REPORTED_LOST",
  "REPORTED_STOLEN",
  "REVOKED",
];

export type RequestAssignmentViolation = Extract<
  AttestationAuthorityViolation,
  | "VERIFIER_NOT_APPROVED"
  | "VERIFIER_IDENTITY_NOT_VERIFIED"
  | "NO_CATEGORY_PERMISSION"
  | "OWN_ASSET"
  | "ASSET_NOT_ATTESTABLE"
>;

/**
 * Every reason the verifier may not take this request; empty if allowed. The database enforces
 * the same rules when a request is assigned.
 */
export function requestAssignmentViolations(
  ctx: Pick<AttestationAuthorityContext, "verifier" | "asset">,
): RequestAssignmentViolation[] {
  const violations: RequestAssignmentViolation[] = [];
  if (ctx.verifier.status !== "APPROVED") violations.push("VERIFIER_NOT_APPROVED");
  if (ctx.verifier.identityStatus !== "VERIFIED") violations.push("VERIFIER_IDENTITY_NOT_VERIFIED");
  if (!ctx.verifier.approvedCategories.includes(ctx.asset.category)) {
    violations.push("NO_CATEGORY_PERMISSION");
  }
  if (ctx.verifier.userId === ctx.asset.ownerId) violations.push("OWN_ASSET");
  if (!ATTESTABLE_ASSET_STATUSES.includes(ctx.asset.status))
    violations.push("ASSET_NOT_ATTESTABLE");
  return violations;
}

/**
 * Evidence the assigned verifier may add. Receipts, ownership and manufacturer documents describe
 * the owner's history and come from the owner; the verifier reviews them instead.
 */
export const VERIFIER_EVIDENCE_TYPES = [
  "PHOTO",
  "VIDEO",
  "INSPECTION_REPORT",
  "CONDITION_REPORT",
  "APPRAISAL_DOCUMENT",
  "CERTIFICATE",
  "SERIAL_NUMBER",
  "OTHER",
] as const satisfies readonly EvidenceType[];
export type VerifierEvidenceType = (typeof VERIFIER_EVIDENCE_TYPES)[number];

// ─── Signed attestations ──────────────────────────────────────────────────────

export const ATTESTATION_MESSAGE_VERSION = "wb-attestation-v1";

export const ATTESTATION_STATEMENT =
  "I attest to the claim below. Signing does not trigger a blockchain transaction or cost any fees.";

/** Default validity of attestations under a template version, in months. */
export const DEFAULT_TEMPLATE_VALIDITY_MONTHS = 60;
export const MAX_TEMPLATE_VALIDITY_MONTHS = 120;

/**
 * The latest expiry an attestation issued at `issuedAt` may have under a template valid for
 * `validityMonths`: the same UTC day and time that many months later, or the last day of that
 * month if it is shorter (as PostgreSQL adds months, which the database uses to check it).
 */
export function attestationExpiryLimit(issuedAt: Date, validityMonths: number): Date {
  const months = issuedAt.getUTCMonth() + validityMonths;
  const year = issuedAt.getUTCFullYear() + Math.floor(months / 12);
  const month = months % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const limit = new Date(issuedAt);
  limit.setUTCFullYear(year, month, Math.min(issuedAt.getUTCDate(), lastDay));
  return limit;
}

/** How far `issuedAt` may be from the server's clock when the attestation is submitted. */
export const ATTESTATION_CLOCK_TOLERANCE_MS = 10 * 60 * 1000;

/** Everything a verifier's signature covers. */
export interface AttestationMessageFields {
  /** WorthyBound domain (`AUTH_DOMAIN`), so a signature cannot be replayed on another site. */
  domain: string;
  /** e.g. `solana:devnet`. */
  chainId: string;
  /** The verifier's wallet address, which signs the message. */
  verifierAddress: string;
  wbId: string;
  category: AssetCategory;
  templateVersionId: string;
  verificationRequestId: string;
  claimType: ClaimType;
  result: AttestationResult;
  conditionGrade: ItemCondition | null;
  method: AttestationMethod;
  assuranceLevel: AssuranceLevel;
  issuedAt: Date;
  expiresAt: Date | null;
  supersedesId: string | null;
  /** SHA-256 (hex) of the notes, which stay private; null without notes. */
  notesSha256: string | null;
  /** Evidence the attestation relies on, with each file's hash at signing time. */
  evidence: readonly { evidenceId: string; sha256: string }[];
  /** 16-32 random bytes as hex, single-use per verifier. */
  nonce: string;
}

/**
 * The exact text the verifier's wallet signs (`wb-attestation-v1`), one field per line so wallets
 * show it readably. Evidence is sorted by ID, so the same attestation always gives the same text.
 * Every value is an enum, ID, timestamp or hash; a line break in any value is refused.
 */
export function attestationMessage(fields: AttestationMessageFields): string {
  const none = (value: string | null) => value ?? "none";
  const evidence = [...fields.evidence].sort((a, b) =>
    a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0,
  );
  const lines = [
    `WorthyBound attestation (${ATTESTATION_MESSAGE_VERSION})`,
    ATTESTATION_STATEMENT,
    "",
    `Domain: ${fields.domain}`,
    `Chain ID: ${fields.chainId}`,
    `Verifier: ${fields.verifierAddress}`,
    `Asset: ${fields.wbId}`,
    `Category: ${fields.category}`,
    `Template version: ${fields.templateVersionId}`,
    `Verification request: ${fields.verificationRequestId}`,
    `Claim: ${fields.claimType}`,
    `Result: ${fields.result}`,
    `Condition grade: ${none(fields.conditionGrade)}`,
    `Method: ${fields.method}`,
    `Assurance: ${fields.assuranceLevel}`,
    `Issued at: ${fields.issuedAt.toISOString()}`,
    `Expires at: ${none(fields.expiresAt?.toISOString() ?? null)}`,
    `Supersedes: ${none(fields.supersedesId)}`,
    `Notes SHA-256: ${none(fields.notesSha256)}`,
    `Evidence count: ${evidence.length}`,
    ...evidence.map((e) => `Evidence: ${e.evidenceId} ${e.sha256}`),
    `Nonce: ${fields.nonce}`,
  ];
  if (lines.some((line) => /[\r\n]/.test(line))) {
    throw new Error("attestation message fields must not contain line breaks");
  }
  return lines.join("\n");
}

/** SHA-256 (hex) of UTF-8 text, e.g. attestation notes. */
export async function sha256Text(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Template evaluation ──────────────────────────────────────────────────────

export interface AttestationFact {
  claimType: ClaimType;
  result: AttestationResult;
  status: AttestationStatus;
  method: AttestationMethod;
  verifierId: string;
  verifierStatus: VerifierStatus;
  expiresAt: Date | null;
}

export interface EvidenceFact {
  type: EvidenceType;
  reviewStatus: ReviewStatus;
}

export interface TemplateEvaluation {
  satisfied: boolean;
  /** Required claims without enough distinct confirming verifiers. */
  missingClaims: ClaimType[];
  /** Required claims with a current contradicting attestation. */
  contradictedClaims: ClaimType[];
  missingEvidence: { type: EvidenceType; missing: number }[];
  /** Total missing evidence items; the Trust Score input `missingRequiredEvidence`. */
  missingEvidenceCount: number;
}

/**
 * Evaluates a template against an asset's attestations and evidence at `at`.
 * An attestation counts if it is ACTIVE, unexpired, from an APPROVED verifier and uses an allowed
 * method. Evidence counts unless it was rejected in review. A current contradiction of a required
 * claim blocks the template until it is resolved.
 */
export function evaluateTemplate(
  requirements: TemplateRequirements,
  facts: {
    attestations: readonly AttestationFact[];
    evidence: readonly EvidenceFact[];
    at: Date;
  },
): TemplateEvaluation {
  const current = facts.attestations.filter(
    (a) =>
      a.status === "ACTIVE" &&
      a.verifierStatus === "APPROVED" &&
      requirements.allowedMethods.includes(a.method) &&
      (a.expiresAt === null || a.expiresAt.getTime() > facts.at.getTime()),
  );

  const missingClaims: ClaimType[] = [];
  const contradictedClaims: ClaimType[] = [];
  for (const claim of new Set(requirements.requiredClaims)) {
    const forClaim = current.filter((a) => a.claimType === claim);
    const confirmers = new Set(
      forClaim.filter((a) => a.result === "CONFIRMED").map((a) => a.verifierId),
    );
    if (confirmers.size < requirements.minVerifiers) missingClaims.push(claim);
    if (forClaim.some((a) => a.result === "CONTRADICTED")) contradictedClaims.push(claim);
  }

  const missingEvidence: { type: EvidenceType; missing: number }[] = [];
  for (const { type, minCount } of requirements.requiredEvidence) {
    const present = facts.evidence.filter(
      (e) => e.type === type && e.reviewStatus !== "REJECTED",
    ).length;
    if (present < minCount) missingEvidence.push({ type, missing: minCount - present });
  }
  const missingEvidenceCount = missingEvidence.reduce((sum, e) => sum + e.missing, 0);

  return {
    satisfied:
      missingClaims.length === 0 && contradictedClaims.length === 0 && missingEvidenceCount === 0,
    missingClaims,
    contradictedClaims,
    missingEvidence,
    missingEvidenceCount,
  };
}
