import type { Prisma } from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  CATEGORY_PERMISSION_STATUSES,
  IDENTITY_STATUSES,
  reapplyAvailableAt,
  VERIFIER_ENTITY_TYPES,
  VERIFIER_STATUSES,
} from "@worthybound/shared";
import { z } from "zod";

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => date?.toISOString() ?? null;
const byCreation = { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] };

export const verifierInclude = {
  user: {
    select: {
      walletAddress: true,
      identityStatus: true,
      identityProvider: true,
      identityVerifiedAt: true,
    },
  },
  statusEvents: byCreation,
  categoryPermissions: { ...byCreation, include: { events: byCreation } },
} satisfies Prisma.VerifierInclude;

export type VerifierRecord = Prisma.VerifierGetPayload<{ include: typeof verifierInclude }>;

export const verifierSummaryInclude = {
  user: { select: { walletAddress: true, identityStatus: true } },
  categoryPermissions: { where: { status: { not: "REVOKED" } }, ...byCreation },
} satisfies Prisma.VerifierInclude;

export type VerifierSummaryRecord = Prisma.VerifierGetPayload<{
  include: typeof verifierSummaryInclude;
}>;

const verifierStatus = z.enum(VERIFIER_STATUSES);
const permissionStatus = z.enum(CATEGORY_PERMISSION_STATUSES);

const profileFields = {
  id: z.string(),
  status: verifierStatus,
  entityType: z.enum(VERIFIER_ENTITY_TYPES),
  businessName: z.string().nullable(),
  website: z.string().nullable(),
  bio: z.string().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  identityStatus: z.enum(IDENTITY_STATUSES),
};

/** The applicant's own view. Reviewer identities are not shown. */
export const applicantVerifierSchema = z.object({
  ...profileFields,
  /** Approval requires a verified identity (ADR 0004). */
  identityRequired: z.boolean(),
  /** When a rejected applicant may apply again. */
  canApplyAgainAt: z.iso.datetime().nullable(),
  categories: z.array(
    z.object({
      category: z.enum(ASSET_CATEGORIES),
      status: permissionStatus,
      reason: z.string().nullable(),
      approvedAt: z.iso.datetime().nullable(),
      revokedAt: z.iso.datetime().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  history: z.array(
    z.object({
      fromStatus: verifierStatus.nullable(),
      toStatus: verifierStatus,
      reason: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type ApplicantVerifier = z.infer<typeof applicantVerifierSchema>;

/** Reviewer view. The KYC provider reference is never returned. */
export const reviewVerifierSchema = z.object({
  ...profileFields,
  walletAddress: z.string(),
  identityProvider: z.string().nullable(),
  identityVerifiedAt: z.iso.datetime().nullable(),
  approvedById: z.string().nullable(),
  categories: z.array(
    z.object({
      id: z.string(),
      category: z.enum(ASSET_CATEGORIES),
      status: permissionStatus,
      reason: z.string().nullable(),
      approvedById: z.string().nullable(),
      approvedAt: z.iso.datetime().nullable(),
      revokedAt: z.iso.datetime().nullable(),
      createdAt: z.iso.datetime(),
      history: z.array(
        z.object({
          fromStatus: permissionStatus.nullable(),
          toStatus: permissionStatus,
          reason: z.string().nullable(),
          actorId: z.string().nullable(),
          createdAt: z.iso.datetime(),
        }),
      ),
    }),
  ),
  history: z.array(
    z.object({
      fromStatus: verifierStatus.nullable(),
      toStatus: verifierStatus,
      reason: z.string().nullable(),
      actorId: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type ReviewVerifier = z.infer<typeof reviewVerifierSchema>;

export const verifierSummarySchema = z.object({
  id: z.string(),
  status: verifierStatus,
  entityType: z.enum(VERIFIER_ENTITY_TYPES),
  businessName: z.string().nullable(),
  walletAddress: z.string(),
  identityStatus: z.enum(IDENTITY_STATUSES),
  /** Categories that are pending, approved or suspended. */
  categories: z.array(z.object({ category: z.enum(ASSET_CATEGORIES), status: permissionStatus })),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const publicVerifierSchema = z.object({
  id: z.string(),
  entityType: z.enum(VERIFIER_ENTITY_TYPES),
  publicName: z.string().nullable(),
  website: z.string().nullable(),
  status: verifierStatus,
  approvedAt: z.iso.datetime(),
  categories: z.array(z.enum(ASSET_CATEGORIES)),
});

const profile = (v: VerifierRecord) => ({
  id: v.id,
  status: v.status,
  entityType: v.entityType,
  businessName: v.businessName,
  website: v.website,
  bio: v.bio,
  approvedAt: isoOrNull(v.approvedAt),
  createdAt: iso(v.createdAt),
  updatedAt: iso(v.updatedAt),
  identityStatus: v.user.identityStatus,
});

/** Date of the rejection that put the verifier in its current REJECTED status. */
export function lastRejectedAt(v: Pick<VerifierRecord, "status" | "statusEvents">): Date | null {
  if (v.status !== "REJECTED") return null;
  return v.statusEvents.findLast((e) => e.toStatus === "REJECTED")?.createdAt ?? null;
}

export function toApplicantVerifier(v: VerifierRecord): ApplicantVerifier {
  const rejectedAt = lastRejectedAt(v);
  return {
    ...profile(v),
    identityRequired: v.user.identityStatus !== "VERIFIED",
    canApplyAgainAt: rejectedAt ? iso(reapplyAvailableAt(rejectedAt)) : null,
    categories: v.categoryPermissions.map((p) => ({
      category: p.category,
      status: p.status,
      reason: p.reason,
      approvedAt: isoOrNull(p.approvedAt),
      revokedAt: isoOrNull(p.revokedAt),
      createdAt: iso(p.createdAt),
    })),
    history: v.statusEvents.map((e) => ({
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      reason: e.reason,
      createdAt: iso(e.createdAt),
    })),
  };
}

export function toReviewVerifier(v: VerifierRecord): ReviewVerifier {
  return {
    ...profile(v),
    walletAddress: v.user.walletAddress,
    identityProvider: v.user.identityProvider,
    identityVerifiedAt: isoOrNull(v.user.identityVerifiedAt),
    approvedById: v.approvedById,
    categories: v.categoryPermissions.map((p) => ({
      id: p.id,
      category: p.category,
      status: p.status,
      reason: p.reason,
      approvedById: p.approvedById,
      approvedAt: isoOrNull(p.approvedAt),
      revokedAt: isoOrNull(p.revokedAt),
      createdAt: iso(p.createdAt),
      history: p.events.map((e) => ({
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        reason: e.reason,
        actorId: e.actorId,
        createdAt: iso(e.createdAt),
      })),
    })),
    history: v.statusEvents.map((e) => ({
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      reason: e.reason,
      actorId: e.actorId,
      createdAt: iso(e.createdAt),
    })),
  };
}

export function toVerifierSummary(v: VerifierSummaryRecord) {
  return {
    id: v.id,
    status: v.status,
    entityType: v.entityType,
    businessName: v.businessName,
    walletAddress: v.user.walletAddress,
    identityStatus: v.user.identityStatus,
    categories: v.categoryPermissions.map((p) => ({ category: p.category, status: p.status })),
    createdAt: iso(v.createdAt),
    updatedAt: iso(v.updatedAt),
  };
}
