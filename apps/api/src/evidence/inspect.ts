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

export const PREVIEW_MAX_SIZE = 480;

/** A small WebP of an image for previews: oriented and without metadata, like public copies. */
export async function previewImage(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 })
    .rotate()
    .resize(PREVIEW_MAX_SIZE, PREVIEW_MAX_SIZE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

export const CHECK_IMAGE_MAX_SIZE = 2048;

/** A JPEG of an image for the AI check: oriented and without metadata (no GPS leaves the vault). */
export async function checkImage(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 })
    .rotate()
    .resize(CHECK_IMAGE_MAX_SIZE, CHECK_IMAGE_MAX_SIZE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Images whose brightest and darkest fingerprint cells differ less than this are too plain. */
const MIN_FINGERPRINT_CONTRAST = 12;

/**
 * A 64-bit difference hash (dHash) of an image: each bit says whether a cell of a 9×8 greyscale
 * thumbnail is brighter than its right neighbour. Resizing and re-encoding change few bits, so a
 * small Hamming distance means a near-identical photo (ADR 0013). Null for images too plain to
 * tell apart, and for files that cannot be read as images.
 */
export async function perceptualHash(bytes: Buffer): Promise<bigint | null> {
  const pixels = await sharp(bytes, { failOn: "error", limitInputPixels: 100_000_000 })
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer()
    .catch(() => null);
  if (!pixels || pixels.length !== 72) return null;
  if (Math.max(...pixels) - Math.min(...pixels) < MIN_FINGERPRINT_CONTRAST) return null;
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = pixels[y * 9 + x] as number;
      const right = pixels[y * 9 + x + 1] as number;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  // Stored as a signed PostgreSQL bigint.
  return BigInt.asIntN(64, hash);
}
