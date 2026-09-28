import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

/** Bytes from the start of the file used to detect its type. */
const DETECTION_BYTES = 64 * 1024;

export interface Inspection {
  sha256: string;
  sizeBytes: number;
  /** File type detected from the contents, or null if unknown. */
  detectedMimeType: string | null;
  /** The whole file, when requested. */
  bytes: Buffer | null;
}

/**
 * Hashes a stored file and detects its type from its first bytes, reading it once. The whole
 * file is kept in memory only when `keepBytes` is set (photos that need a public copy).
 */
export async function inspectFile(stream: Readable, keepBytes: boolean): Promise<Inspection> {
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  const all: Buffer[] = [];
  let headLength = 0;
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    sizeBytes += buffer.length;
    if (headLength < DETECTION_BYTES) {
      head.push(buffer);
      headLength += buffer.length;
    }
    if (keepBytes) all.push(buffer);
  }
  const detected = await fileTypeFromBuffer(Buffer.concat(head).subarray(0, DETECTION_BYTES));
  return {
    sha256: hash.digest("hex"),
    sizeBytes,
    detectedMimeType: detected?.mime ?? null,
    bytes: keepBytes ? Buffer.concat(all) : null,
  };
}

const OUTPUT_FORMAT = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

/**
 * Re-encodes a photo for public display: applies the camera orientation, then writes a new
 * image without EXIF, GPS, XMP, IPTC, comments or colour profiles. Re-encoding also removes
 * anything hidden after the image data.
 */
export async function publicPhotoCopy(
  bytes: Buffer,
  mimeType: keyof typeof OUTPUT_FORMAT,
): Promise<Buffer> {
  return sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 })
    .rotate()
    .toFormat(OUTPUT_FORMAT[mimeType])
    .toBuffer();
}
