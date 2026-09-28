import type {
  AssetCategory,
  AssetStatus,
  AttestationMethod,
  AttestationResult,
  AttestationStatus,
  ClaimType,
  EvidenceType,
  IdentityStatus,
  ReviewStatus,
  TemplateVersionStatus,
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
