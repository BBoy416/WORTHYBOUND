import type { DisputeStatus, Prisma } from "@worthybound/database";
import {
  ASSET_STATUSES,
  ATTESTATION_RESULTS,
  ATTESTATION_STATUSES,
  CLAIM_TYPES,
  DISPUTE_STATUSES,
  EVIDENCE_TYPES,
  EVIDENCE_VISIBILITIES,
  verifierPublicName,
} from "@worthybound/shared";
import { z } from "zod";

const isoOrNull = (date: Date | null) => date?.toISOString() ?? null;

export const OPEN_DISPUTE_STATUSES: readonly DisputeStatus[] = ["OPEN", "UNDER_REVIEW"];

/** Evidence an upheld dispute found misleading is left out of passports and comparisons. */
export const notUpheld = {
  disputes: { none: { status: "UPHELD" } },
} satisfies Prisma.EvidenceWhereInput;

export const disputeInclude = {
  asset: { select: { wbId: true, brand: true, model: true } },
} satisfies Prisma.DisputeInclude;

export const adminDisputeInclude = {
  asset: { select: { wbId: true, brand: true, model: true, status: true } },
  openedBy: { select: { walletAddress: true } },
  attestation: {
    select: {
      claimType: true,
      result: true,
      status: true,
      verifier: { select: { id: true, businessName: true, entityType: true, status: true } },
    },
  },
  evidence: { select: { type: true, visibility: true, mimeType: true } },
} satisfies Prisma.DisputeInclude;

type DisputeRecord = Prisma.DisputeGetPayload<{ include: typeof disputeInclude }>;
type AdminDisputeRecord = Prisma.DisputeGetPayload<{ include: typeof adminDisputeInclude }>;

const targetSchema = z.object({
  kind: z.enum(["ASSET", "ATTESTATION", "EVIDENCE"]),
  id: z.uuid().nullable(),
});

/** What the person who opened a dispute sees. */
export const disputeSchema = z.object({
  id: z.uuid(),
  status: z.enum(DISPUTE_STATUSES),
  asset: z.object({ wbId: z.string(), brand: z.string().nullable(), model: z.string().nullable() }),
  target: targetSchema,
  reason: z.string(),
  details: z.string().nullable(),
  resolution: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

export const adminDisputeSchema = disputeSchema.extend({
  asset: z.object({
    wbId: z.string(),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(ASSET_STATUSES),
  }),
  openedByWalletAddress: z.string(),
  attestation: z
    .object({
      claimType: z.enum(CLAIM_TYPES),
      result: z.enum(ATTESTATION_RESULTS),
      status: z.enum(ATTESTATION_STATUSES),
      verifier: z.object({ id: z.uuid(), publicName: z.string().nullable() }),
    })
    .nullable(),
  evidence: z
    .object({
      type: z.enum(EVIDENCE_TYPES),
      visibility: z.enum(EVIDENCE_VISIBILITIES),
      mimeType: z.string(),
    })
    .nullable(),
  holdsAsset: z.boolean(),
  assetStatusBefore: z.enum(ASSET_STATUSES).nullable(),
});

const target = (d: { attestationId: string | null; evidenceId: string | null }) =>
  d.attestationId
    ? { kind: "ATTESTATION" as const, id: d.attestationId }
    : d.evidenceId
      ? { kind: "EVIDENCE" as const, id: d.evidenceId }
      : { kind: "ASSET" as const, id: null };

export function toDispute(d: DisputeRecord): z.infer<typeof disputeSchema> {
  return {
    id: d.id,
    status: d.status,
    asset: { wbId: d.asset.wbId, brand: d.asset.brand, model: d.asset.model },
    target: target(d),
    reason: d.reason,
    details: d.details,
    resolution: d.resolution,
    createdAt: d.createdAt.toISOString(),
    reviewedAt: isoOrNull(d.reviewedAt),
    resolvedAt: isoOrNull(d.resolvedAt),
  };
}

export function toAdminDispute(d: AdminDisputeRecord): z.infer<typeof adminDisputeSchema> {
  return {
    ...toDispute(d),
    asset: d.asset,
    openedByWalletAddress: d.openedBy.walletAddress,
    attestation: d.attestation && {
      claimType: d.attestation.claimType,
      result: d.attestation.result,
      status: d.attestation.status,
      verifier: {
        id: d.attestation.verifier.id,
        publicName: verifierPublicName(d.attestation.verifier),
      },
    },
    evidence: d.evidence && {
      type: d.evidence.type,
      visibility: d.evidence.visibility,
      mimeType: d.evidence.mimeType,
    },
    holdsAsset: d.holdsAsset,
    assetStatusBefore: d.assetStatusBefore,
  };
}
