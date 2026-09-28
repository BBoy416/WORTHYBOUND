import type {
  AssetCategory,
  CategoryPermissionStatus,
  Role,
  VerifierEntityType,
  VerifierStatus,
} from "./enums.js";

/** Roles that administrators grant and revoke through the API. ADMIN is granted only by the CLI. */
export const API_MANAGED_ROLES = ["VERIFIER_REVIEWER"] as const satisfies readonly Role[];
export type ApiManagedRole = (typeof API_MANAGED_ROLES)[number];

/** Verifier statuses that must be explained to the applicant. */
export const VERIFIER_STATUSES_REQUIRING_REASON: readonly VerifierStatus[] = [
  "REJECTED",
  "SUSPENDED",
  "REVOKED",
];

export const PERMISSION_STATUSES_REQUIRING_REASON: readonly CategoryPermissionStatus[] = [
  "SUSPENDED",
  "REVOKED",
];

/** A rejected applicant may apply again this long after the rejection. */
export const REAPPLY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export function reapplyAvailableAt(rejectedAt: Date): Date {
  return new Date(rejectedAt.getTime() + REAPPLY_COOLDOWN_MS);
}

/**
 * The lifecycle actor a signed-in user acts as when reviewing verifiers, or null if they may not
 * review. ADMIN takes precedence, since some changes (revocation) are admin-only.
 */
export function reviewActor(roles: readonly Role[]): "ADMIN" | "REVIEWER" | null {
  if (roles.includes("ADMIN")) return "ADMIN";
  if (roles.includes("VERIFIER_REVIEWER")) return "REVIEWER";
  return null;
}

/** Individuals are not named publicly; organisations are. */
export function verifierPublicName(verifier: {
  entityType: VerifierEntityType;
  businessName: string | null;
}): string | null {
  return verifier.entityType === "INDIVIDUAL" ? null : verifier.businessName;
}

/**
 * Records the public verifier profile is built from. Objects may carry more fields (e.g. the
 * user, bio or KYC status); only the fields named here are ever read.
 */
export interface PublicVerifierSource {
  id: string;
  entityType: VerifierEntityType;
  businessName: string | null;
  website: string | null;
  status: VerifierStatus;
  approvedAt: Date | null;
  categoryPermissions: readonly { category: AssetCategory; status: CategoryPermissionStatus }[];
}

export interface PublicVerifier {
  id: string;
  entityType: VerifierEntityType;
  publicName: string | null;
  website: string | null;
  status: VerifierStatus;
  approvedAt: string;
  /** Categories with an APPROVED permission. */
  categories: AssetCategory[];
}

/**
 * Builds the public profile from an explicit allow-list of fields, or returns null if the
 * verifier was never approved (applicants and rejected applicants have no profile). Suspended
 * and revoked verifiers stay visible so attestation history can be judged. Individuals show
 * neither their name nor their website.
 */
export function toPublicVerifier(source: PublicVerifierSource): PublicVerifier | null {
  if (!source.approvedAt) return null;
  const individual = source.entityType === "INDIVIDUAL";
  return {
    id: source.id,
    entityType: source.entityType,
    publicName: verifierPublicName(source),
    website: individual ? null : source.website,
    status: source.status,
    approvedAt: source.approvedAt.toISOString(),
    categories: source.categoryPermissions
      .filter((p) => p.status === "APPROVED")
      .map((p) => p.category)
      .sort(),
  };
}
