import {
  AUTOMATED_CHECK_RESULTS,
  canBePublic,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  EVIDENCE_TYPES,
  EVIDENCE_VISIBILITIES,
  VERIFIER_EVIDENCE_TYPES,
} from "@worthybound/shared";
import { z } from "zod";
import { dateTimeSchema, sha256Schema, text, uuidSchema, wbIdSchema } from "./common.js";

export { EVIDENCE_MAX_BYTES, type EvidenceMimeType } from "@worthybound/shared";

/** A plain file name: no paths, no control characters. */
const fileNameSchema = text(255).refine(
  // eslint-disable-next-line no-control-regex
  (name) => !/[/\\\u0000-\u001f\u007f]/.test(name) && name !== "." && name !== "..",
  "invalid file name",
);

/**
 * Metadata sent when requesting an evidence upload. The storage key, uploader, source and review
 * status are set by the backend; the server hashes the stored file and compares it with `sha256`.
 */
export const evidenceUploadSchema = z
  .strictObject({
    type: z.enum(EVIDENCE_TYPES),
    sha256: sha256Schema,
    mimeType: z.enum(EVIDENCE_MIME_TYPES),
    sizeBytes: z.int().positive(),
    visibility: z.enum(EVIDENCE_VISIBILITIES).default("PRIVATE"),
    originalFilename: fileNameSchema.optional(),
    description: text(1000).optional(),
    capturedAt: dateTimeSchema.optional(),
  })
  .refine((input) => input.sizeBytes <= EVIDENCE_MAX_BYTES[input.mimeType], {
    message: "file is too large for its type",
    path: ["sizeBytes"],
  })
  .refine((input) => input.visibility === "PRIVATE" || canBePublic(input.type, input.mimeType), {
    message: "only JPEG, PNG or WebP photos can be public",
    path: ["visibility"],
  });
export type EvidenceUploadInput = z.infer<typeof evidenceUploadSchema>;

/**
 * Metadata sent by the verifier assigned to a verification request. Verifier evidence is always
 * private; the owner decides whether a photo is published.
 */
export const verifierEvidenceUploadSchema = z
  .strictObject({
    type: z.enum(VERIFIER_EVIDENCE_TYPES),
    sha256: sha256Schema,
    mimeType: z.enum(EVIDENCE_MIME_TYPES),
    sizeBytes: z.int().positive(),
    originalFilename: fileNameSchema.optional(),
    description: text(1000).optional(),
    capturedAt: dateTimeSchema.optional(),
  })
  .refine((input) => input.sizeBytes <= EVIDENCE_MAX_BYTES[input.mimeType], {
    message: "file is too large for its type",
    path: ["sizeBytes"],
  });
export type VerifierEvidenceUploadInput = z.infer<typeof verifierEvidenceUploadSchema>;

export const evidenceVisibilitySchema = z.strictObject({
  visibility: z.enum(EVIDENCE_VISIBILITIES),
});
export type EvidenceVisibilityRequest = z.infer<typeof evidenceVisibilitySchema>;

/** The owner's consent to AI checks of their uploads for one asset (ADR 0013). */
export const automatedChecksConsentSchema = z.strictObject({
  enabled: z.boolean(),
});
export type AutomatedChecksConsentRequest = z.infer<typeof automatedChecksConsentSchema>;

/** Automated checks across assets, newest first. `cursor` is the last check ID of the previous page. */
export const automatedCheckListQuerySchema = z.strictObject({
  result: z.enum(AUTOMATED_CHECK_RESULTS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: uuidSchema.optional(),
});
export type AutomatedCheckListQuery = z.infer<typeof automatedCheckListQuerySchema>;

export const evidenceParamsSchema = z.strictObject({
  wbId: wbIdSchema,
  evidenceId: uuidSchema,
});

export const evidenceUploadParamsSchema = z.strictObject({ uploadId: uuidSchema });
