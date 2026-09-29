import type { Prisma } from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  ASSURANCE_LEVELS,
  ATTESTATION_METHODS,
  ATTESTATION_RESULTS,
  ATTESTATION_STATUSES,
  CLAIM_TYPES,
  ITEM_CONDITIONS,
  VERIFICATION_REQUEST_STATUSES,
  VERIFIER_ENTITY_TYPES,
  VERIFIER_STATUSES,
  verifierPublicName,
} from "@worthybound/shared";
import { z } from "zod";
import { requirementsOf, requirementsSchema } from "../templates/view.js";

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => date?.toISOString() ?? null;
const byCreation = { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] };

const attestationSelect = {
  id: true,
  claimType: true,
  result: true,
  method: true,
  assuranceLevel: true,
  conditionGrade: true,
  status: true,
  issuedAt: true,
  expiresAt: true,
  supersedesId: true,
  signedPayloadHash: true,
  createdAt: true,
} satisfies Prisma.AttestationSelect;

export const requestInclude = {
  asset: {
    select: {
      id: true,
      wbId: true,
      ownerId: true,
      category: true,
      brand: true,
      model: true,
      status: true,
      publicDescription: true,
      condition: true,
      serialNumber: true,
      attributes: true,
    },
  },
  templateVersion: { include: { template: true } },
  assignedVerifier: {
    select: { id: true, userId: true, businessName: true, entityType: true, status: true },
  },
  attestations: { ...byCreation, select: attestationSelect },
  statusEvents: byCreation,
} satisfies Prisma.VerificationRequestInclude;

export type RequestRecord = Prisma.VerificationRequestGetPayload<{
  include: typeof requestInclude;
}>;

const templateSummarySchema = requirementsSchema.extend({
  templateId: z.uuid(),
  templateVersionId: z.uuid(),
  code: z.string(),
  name: z.string(),
  version: z.int(),
});

const attestationSummarySchema = z.object({
  id: z.uuid(),
  claimType: z.enum(CLAIM_TYPES),
  result: z.enum(ATTESTATION_RESULTS),
  method: z.enum(ATTESTATION_METHODS),
  assuranceLevel: z.enum(ASSURANCE_LEVELS),
  conditionGrade: z.enum(ITEM_CONDITIONS).nullable(),
  status: z.enum(ATTESTATION_STATUSES),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  supersedesId: z.uuid().nullable(),
  signedPayloadHash: z.string(),
});

const historySchema = z.array(
  z.object({
    fromStatus: z.enum(VERIFICATION_REQUEST_STATUSES).nullable(),
    toStatus: z.enum(VERIFICATION_REQUEST_STATUSES),
    reason: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
);

const requestFields = {
  id: z.uuid(),
  status: z.enum(VERIFICATION_REQUEST_STATUSES),
  template: templateSummarySchema,
  closedReason: z.string().nullable(),
  assignedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
};

/**
 * The owner's view. The verifier is named by the public naming rule (organisations only), and
 * attestation notes, signed messages and wallets are not shown.
 */
export const ownerRequestSchema = z.object({
  ...requestFields,
  wbId: z.string(),
  verifier: z
    .object({
      id: z.uuid(),
      publicName: z.string().nullable(),
      entityType: z.enum(VERIFIER_ENTITY_TYPES),
      status: z.enum(VERIFIER_STATUSES),
    })
    .nullable(),
  attestations: z.array(attestationSummarySchema),
  history: historySchema,
});

/**
 * A verifier's view. The open queue shows what the item is, never who owns it; the serial number
 * and attributes are shown only to the verifier the request is assigned to.
 */
export const verifierRequestSchema = z.object({
  ...requestFields,
  assignedToYou: z.boolean(),
  asset: z.object({
    wbId: z.string(),
    category: z.enum(ASSET_CATEGORIES),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(ASSET_STATUSES),
    publicDescription: z.string().nullable(),
    ownerStatedCondition: z.enum(ITEM_CONDITIONS).nullable(),
    serialNumber: z.string().nullable(),
    attributes: z.record(z.string(), z.unknown()).nullable(),
  }),
  attestations: z.array(attestationSummarySchema),
});

const templateSummary = (r: RequestRecord) => {
  const requirements = requirementsOf(r.templateVersion);
  return {
    templateId: r.templateVersion.template.id,
    templateVersionId: r.templateVersion.id,
    code: r.templateVersion.template.code,
    name: r.templateVersion.template.name,
    version: r.templateVersion.version,
    requiredClaims: [...requirements.requiredClaims],
    requiredEvidence: [...requirements.requiredEvidence],
    allowedMethods: [...requirements.allowedMethods],
    minVerifiers: requirements.minVerifiers,
  };
};

const toAttestationSummary = (a: RequestRecord["attestations"][number]) => ({
  id: a.id,
  claimType: a.claimType,
  result: a.result,
  method: a.method,
  assuranceLevel: a.assuranceLevel,
  conditionGrade: a.conditionGrade,
  status: a.status,
  issuedAt: iso(a.issuedAt),
  expiresAt: isoOrNull(a.expiresAt),
  supersedesId: a.supersedesId,
  signedPayloadHash: a.signedPayloadHash,
});

const common = (r: RequestRecord) => ({
  id: r.id,
  status: r.status,
  template: templateSummary(r),
  closedReason: r.closedReason,
  assignedAt: isoOrNull(r.assignedAt),
  completedAt: isoOrNull(r.completedAt),
  expiresAt: iso(r.expiresAt),
  createdAt: iso(r.createdAt),
});

export function toOwnerRequest(r: RequestRecord): z.infer<typeof ownerRequestSchema> {
  const v = r.assignedVerifier;
  return {
    ...common(r),
    wbId: r.asset.wbId,
    verifier: v
      ? {
          id: v.id,
          publicName: verifierPublicName(v),
          entityType: v.entityType,
          status: v.status,
        }
      : null,
    attestations: r.attestations.map(toAttestationSummary),
    history: r.statusEvents.map((e) => ({
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      reason: e.reason,
      createdAt: iso(e.createdAt),
    })),
  };
}

export function toVerifierRequest(
  r: RequestRecord,
  verifierId: string,
): z.infer<typeof verifierRequestSchema> {
  const assigned = r.assignedVerifier?.id === verifierId;
  return {
    ...common(r),
    assignedToYou: assigned,
    asset: {
      wbId: r.asset.wbId,
      category: r.asset.category,
      brand: r.asset.brand,
      model: r.asset.model,
      status: r.asset.status,
      publicDescription: r.asset.publicDescription,
      ownerStatedCondition: r.asset.condition,
      serialNumber: assigned ? r.asset.serialNumber : null,
      attributes: assigned ? (r.asset.attributes as Record<string, unknown>) : null,
    },
    attestations: assigned ? r.attestations.map(toAttestationSummary) : [],
  };
}

export type AttestationRecord = Prisma.AttestationGetPayload<{
  include: { evidence: true; asset: { select: { wbId: true } } };
}>;

/** The issuing verifier's view of their attestation, including notes and the signed text. */
export const verifierAttestationSchema = attestationSummarySchema.extend({
  wbId: z.string(),
  verificationRequestId: z.uuid(),
  templateVersionId: z.uuid(),
  notes: z.string().nullable(),
  nonce: z.string(),
  signedMessage: z.string(),
  signature: z.string(),
  evidence: z.array(z.object({ evidenceId: z.uuid(), sha256: z.string() })),
  createdAt: z.iso.datetime(),
});

export const toVerifierAttestation = (
  a: AttestationRecord,
): z.infer<typeof verifierAttestationSchema> => ({
  ...toAttestationSummary(a),
  wbId: a.asset.wbId,
  verificationRequestId: a.verificationRequestId,
  templateVersionId: a.templateVersionId,
  notes: a.notes,
  nonce: a.nonce,
  signedMessage: a.signedMessage,
  signature: a.signature,
  evidence: a.evidence.map((e) => ({ evidenceId: e.evidenceId, sha256: e.sha256 })),
  createdAt: iso(a.createdAt),
});
