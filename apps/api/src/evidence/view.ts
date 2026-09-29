import type { Evidence } from "@worthybound/database";
import {
  EVIDENCE_MIME_TYPES,
  EVIDENCE_TYPES,
  EVIDENCE_VISIBILITIES,
  PROOF_SOURCES,
  publicEvidencePath,
  REVIEW_STATUSES,
} from "@worthybound/shared";
import { z } from "zod";

/**
 * The owner's (and the assigned verifier's) view of an evidence item. Storage keys, duplicate
 * flags and reviewer identities are never returned.
 */
export const ownerEvidenceSchema = z.object({
  id: z.uuid(),
  type: z.enum(EVIDENCE_TYPES),
  /** OWNER, or VERIFIER for evidence added by the verifier assigned to a request. */
  source: z.enum(PROOF_SOURCES),
  mimeType: z.enum(EVIDENCE_MIME_TYPES),
  sizeBytes: z.int(),
  sha256: z.string(),
  visibility: z.enum(EVIDENCE_VISIBILITIES),
  reviewStatus: z.enum(REVIEW_STATUSES),
  /** Why the evidence was rejected. */
  reviewReason: z.string().nullable(),
  originalFilename: z.string().nullable(),
  description: z.string().nullable(),
  capturedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** Where the public copy is served, while the photo is public. */
  publicPath: z.string().nullable(),
});
export type OwnerEvidence = z.infer<typeof ownerEvidenceSchema>;

export function toOwnerEvidence(evidence: Evidence, wbId: string): OwnerEvidence {
  return {
    id: evidence.id,
    type: evidence.type,
    source: evidence.source,
    mimeType: evidence.mimeType as OwnerEvidence["mimeType"],
    sizeBytes: evidence.sizeBytes,
    sha256: evidence.sha256,
    visibility: evidence.visibility,
    reviewStatus: evidence.reviewStatus,
    reviewReason: evidence.reviewReason,
    originalFilename: evidence.originalFilename,
    description: evidence.description,
    capturedAt: evidence.capturedAt?.toISOString() ?? null,
    createdAt: evidence.createdAt.toISOString(),
    publicPath: evidence.visibility === "PUBLIC" ? publicEvidencePath(wbId, evidence.id) : null,
  };
}
