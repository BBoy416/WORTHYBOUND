import type { VerificationTemplate, VerificationTemplateVersion } from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  ATTESTATION_METHODS,
  CLAIM_TYPES,
  EVIDENCE_TYPES,
  TEMPLATE_VERSION_STATUSES,
  type TemplateRequirements,
} from "@worthybound/shared";
import { z } from "zod";

const isoOrNull = (date: Date | null) => date?.toISOString() ?? null;

export const requirementsSchema = z.object({
  requiredClaims: z.array(z.enum(CLAIM_TYPES)),
  requiredEvidence: z.array(z.object({ type: z.enum(EVIDENCE_TYPES), minCount: z.int() })),
  allowedMethods: z.array(z.enum(ATTESTATION_METHODS)),
  minVerifiers: z.int(),
});

/** Requirements as stored; the database checks their shape before a version is published. */
export const requirementsOf = (
  version: Pick<
    VerificationTemplateVersion,
    "requiredClaims" | "requiredEvidence" | "allowedMethods" | "minVerifiers"
  >,
): TemplateRequirements => ({
  requiredClaims: version.requiredClaims as TemplateRequirements["requiredClaims"],
  requiredEvidence: version.requiredEvidence as unknown as TemplateRequirements["requiredEvidence"],
  allowedMethods: version.allowedMethods as TemplateRequirements["allowedMethods"],
  minVerifiers: version.minVerifiers,
});

export const adminTemplateVersionSchema = requirementsSchema.extend({
  id: z.uuid(),
  version: z.int(),
  validityMonths: z.int(),
  status: z.enum(TEMPLATE_VERSION_STATUSES),
  createdById: z.string().nullable(),
  publishedById: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const adminTemplateSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  category: z.enum(ASSET_CATEGORIES),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  versions: z.array(adminTemplateVersionSchema),
});

/** A published template version, as shown to owners choosing what to request. */
export const publishedTemplateSchema = requirementsSchema.extend({
  templateId: z.uuid(),
  templateVersionId: z.uuid(),
  code: z.string(),
  category: z.enum(ASSET_CATEGORIES),
  name: z.string(),
  description: z.string().nullable(),
  version: z.int(),
  validityMonths: z.int(),
  publishedAt: z.iso.datetime(),
});

const requirementsView = (v: VerificationTemplateVersion) => {
  const r = requirementsOf(v);
  return {
    requiredClaims: [...r.requiredClaims],
    requiredEvidence: [...r.requiredEvidence],
    allowedMethods: [...r.allowedMethods],
    minVerifiers: r.minVerifiers,
  };
};

export const toAdminTemplateVersion = (v: VerificationTemplateVersion) => ({
  id: v.id,
  version: v.version,
  validityMonths: v.validityMonths,
  status: v.status,
  ...requirementsView(v),
  createdById: v.createdById,
  publishedById: v.publishedById,
  publishedAt: isoOrNull(v.publishedAt),
  createdAt: v.createdAt.toISOString(),
});

export const toAdminTemplate = (
  t: VerificationTemplate & { versions: VerificationTemplateVersion[] },
) => ({
  id: t.id,
  code: t.code,
  category: t.category,
  name: t.name,
  description: t.description,
  createdAt: t.createdAt.toISOString(),
  versions: t.versions.map(toAdminTemplateVersion),
});

export const toPublishedTemplate = (
  v: VerificationTemplateVersion & { template: VerificationTemplate },
) => ({
  templateId: v.template.id,
  templateVersionId: v.id,
  code: v.template.code,
  category: v.template.category,
  name: v.template.name,
  description: v.template.description,
  version: v.version,
  validityMonths: v.validityMonths,
  ...requirementsView(v),
  publishedAt: (v.publishedAt as Date).toISOString(),
});
