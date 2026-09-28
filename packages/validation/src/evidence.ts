import { EVIDENCE_TYPES, EVIDENCE_VISIBILITIES } from "@worthybound/shared";
import { z } from "zod";
import { dateTimeSchema, sha256Schema, text } from "./common.js";

const MiB = 1024 * 1024;

/** Accepted evidence file types and their maximum size in bytes. */
export const EVIDENCE_MAX_BYTES = {
  "image/jpeg": 25 * MiB,
  "image/png": 25 * MiB,
  "image/webp": 25 * MiB,
  "image/heic": 25 * MiB,
  "application/pdf": 25 * MiB,
  "video/mp4": 500 * MiB,
  "video/quicktime": 500 * MiB,
} as const;
export type EvidenceMimeType = keyof typeof EVIDENCE_MAX_BYTES;

const MIME_TYPES = Object.keys(EVIDENCE_MAX_BYTES) as [EvidenceMimeType, ...EvidenceMimeType[]];

/** A plain file name: no paths, no control characters. */
const fileNameSchema = text(255).refine(
  // eslint-disable-next-line no-control-regex
  (name) => !/[/\\\u0000-\u001f\u007f]/.test(name) && name !== "." && name !== "..",
  "invalid file name",
);

/**
 * Metadata sent with an evidence upload. The storage key, uploader, source and review status
 * are set by the backend; the server must re-hash the stored file and compare it with `sha256`.
 */
export const evidenceUploadSchema = z
  .strictObject({
    type: z.enum(EVIDENCE_TYPES),
    sha256: sha256Schema,
    mimeType: z.enum(MIME_TYPES),
    sizeBytes: z.int().positive(),
    visibility: z.enum(EVIDENCE_VISIBILITIES).default("PRIVATE"),
    originalFilename: fileNameSchema.optional(),
    description: text(1000).optional(),
    capturedAt: dateTimeSchema.optional(),
  })
  .refine((input) => input.sizeBytes <= EVIDENCE_MAX_BYTES[input.mimeType], {
    message: "file is too large for its type",
    path: ["sizeBytes"],
  });
export type EvidenceUploadInput = z.infer<typeof evidenceUploadSchema>;
