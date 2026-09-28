import {
  API_MANAGED_ROLES,
  ASSET_CATEGORIES,
  ASSURANCE_LEVELS,
  ATTESTATION_METHODS,
  ATTESTATION_RESULTS,
  CATEGORY_PERMISSION_STATUSES,
  CLAIM_TYPES,
  EVIDENCE_TYPES,
  ITEM_CONDITIONS,
  PERMISSION_STATUSES_REQUIRING_REASON,
  VERIFIER_ENTITY_TYPES,
  VERIFIER_STATUSES,
  VERIFIER_STATUSES_REQUIRING_REASON,
} from "@worthybound/shared";
import { z } from "zod";
import {
  dateTimeSchema,
  httpsUrlSchema,
  sha256Schema,
  solanaAddressSchema,
  solanaSignatureSchema,
  text,
  uniqueArray,
  uuidSchema,
  wbIdSchema,
} from "./common.js";

export const verifierApplicationSchema = z
  .strictObject({
    entityType: z.enum(VERIFIER_ENTITY_TYPES),
    businessName: text(200).optional(),
    website: httpsUrlSchema.optional(),
    bio: text(2000).optional(),
    /** Permission is requested and granted per category. */
    categories: uniqueArray(z.enum(ASSET_CATEGORIES)).min(1),
  })
  .refine((input) => input.entityType === "INDIVIDUAL" || input.businessName !== undefined, {
    message: "businessName is required for organizations",
    path: ["businessName"],
  });
export type VerifierApplicationInput = z.infer<typeof verifierApplicationSchema>;

/** Body of `POST /verifier/me/categories`: further categories requested by an approved verifier. */
export const verifierCategoryRequestSchema = z.strictObject({
  categories: uniqueArray(z.enum(ASSET_CATEGORIES)).min(1),
});
export type VerifierCategoryRequestInput = z.infer<typeof verifierCategoryRequestSchema>;

/** Body of `POST /review/verifiers/:verifierId/status`. */
export const verifierStatusChangeSchema = z
  .strictObject({ status: z.enum(VERIFIER_STATUSES), reason: text(500).optional() })
  .refine((input) => !VERIFIER_STATUSES_REQUIRING_REASON.includes(input.status) || !!input.reason, {
    message: "a reason is required for this status",
    path: ["reason"],
  });
export type VerifierStatusChangeInput = z.infer<typeof verifierStatusChangeSchema>;

/** Body of `POST /review/verifiers/:verifierId/categories/:category`. */
export const categoryPermissionChangeSchema = z
  .strictObject({ status: z.enum(CATEGORY_PERMISSION_STATUSES), reason: text(500).optional() })
  .refine(
    (input) => !PERMISSION_STATUSES_REQUIRING_REASON.includes(input.status) || !!input.reason,
    { message: "a reason is required for this status", path: ["reason"] },
  );
export type CategoryPermissionChangeInput = z.infer<typeof categoryPermissionChangeSchema>;

export const verifierParamsSchema = z.strictObject({ verifierId: uuidSchema });

export const verifierCategoryParamsSchema = z.strictObject({
  verifierId: uuidSchema,
  category: z.enum(ASSET_CATEGORIES),
});

/** Review queue, oldest first. `cursor` is the last verifier ID of the previous page. */
export const verifierListQuerySchema = z.strictObject({
  status: z.enum(VERIFIER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: uuidSchema.optional(),
});
export type VerifierListQuery = z.infer<typeof verifierListQuerySchema>;

/** Body of `POST /admin/roles`. ADMIN itself is granted only with the CLI (ADR 0008). */
export const roleGrantSchema = z.strictObject({
  walletAddress: solanaAddressSchema,
  role: z.enum(API_MANAGED_ROLES),
});
export type RoleGrantInput = z.infer<typeof roleGrantSchema>;

export const roleListQuerySchema = z.strictObject({ role: z.enum(API_MANAGED_ROLES) });

export const roleAssignmentParamsSchema = z.strictObject({ assignmentId: uuidSchema });

export const MAX_VERIFIERS_PER_CLAIM = 5;

/** Requirements of a verification template version (stored as JSON on the version). */
export const templateRequirementsSchema = z.strictObject({
  requiredClaims: uniqueArray(z.enum(CLAIM_TYPES)).min(1),
  requiredEvidence: z
    .array(z.strictObject({ type: z.enum(EVIDENCE_TYPES), minCount: z.int().min(1).max(20) }))
    .refine(
      (items) => new Set(items.map((i) => i.type)).size === items.length,
      "each evidence type may appear once",
    ),
  allowedMethods: uniqueArray(z.enum(ATTESTATION_METHODS)).min(1),
  minVerifiers: z.int().min(1).max(MAX_VERIFIERS_PER_CLAIM),
});
export type TemplateRequirementsInput = z.infer<typeof templateRequirementsSchema>;

export const verificationRequestSchema = z.strictObject({
  assetId: wbIdSchema,
  templateVersionId: uuidSchema,
});
export type VerificationRequestInput = z.infer<typeof verificationRequestSchema>;

/**
 * A signed claim submitted by a verifier. The verifier is taken from the session; status,
 * chain address and Trust Score effects are set by the backend. Signature verification happens
 * in the service (Phase 8); this only checks the format.
 */
export const attestationSubmissionSchema = z
  .strictObject({
    assetId: wbIdSchema,
    verificationRequestId: uuidSchema.optional(),
    templateVersionId: uuidSchema,
    claimType: z.enum(CLAIM_TYPES),
    result: z.enum(ATTESTATION_RESULTS),
    method: z.enum(ATTESTATION_METHODS),
    assuranceLevel: z.enum(ASSURANCE_LEVELS),
    /** Only for CONDITION claims; required when the claim is CONFIRMED. */
    conditionGrade: z.enum(ITEM_CONDITIONS).optional(),
    notes: text(2000).optional(),
    issuedAt: dateTimeSchema,
    expiresAt: dateTimeSchema.optional(),
    evidence: z
      .array(z.strictObject({ evidenceId: uuidSchema, sha256: sha256Schema }))
      .max(50)
      .refine(
        (items) => new Set(items.map((i) => i.evidenceId)).size === items.length,
        "duplicate evidence",
      ),
    nonce: z.string().regex(/^[0-9a-f]{32,64}$/, "expected 16-32 random bytes as hex"),
    signature: solanaSignatureSchema,
    supersedesId: uuidSchema.optional(),
  })
  .refine((input) => !input.expiresAt || input.expiresAt > input.issuedAt, {
    message: "expiresAt must be after issuedAt",
    path: ["expiresAt"],
  })
  .refine((input) => input.conditionGrade === undefined || input.claimType === "CONDITION", {
    message: "conditionGrade is only allowed on CONDITION claims",
    path: ["conditionGrade"],
  })
  .refine(
    (input) =>
      input.claimType !== "CONDITION" ||
      input.result !== "CONFIRMED" ||
      input.conditionGrade !== undefined,
    { message: "a confirmed CONDITION claim requires conditionGrade", path: ["conditionGrade"] },
  );
export type AttestationSubmissionInput = z.infer<typeof attestationSubmissionSchema>;
