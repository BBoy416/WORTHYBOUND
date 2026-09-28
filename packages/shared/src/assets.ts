import type { AssetCategory, AssetStatus } from "./enums.js";

/** Fields that identify the physical item; locked once the passport is published. */
export const ASSET_IDENTITY_FIELDS = ["category", "brand", "model", "serialNumber"] as const;
export type AssetIdentityField = (typeof ASSET_IDENTITY_FIELDS)[number];

/** Fields that must be filled in before a passport can be published. */
export const PUBLISH_REQUIRED_FIELDS = ["brand", "model"] as const;

export function missingPublishFields(asset: {
  brand: string | null;
  model: string | null;
}): (typeof PUBLISH_REQUIRED_FIELDS)[number][] {
  return PUBLISH_REQUIRED_FIELDS.filter((field) => !asset[field]?.trim());
}

/** Statuses from which the owner may publish (DRAFT, or TOKENIZED before publication). */
export function canPublish(status: AssetStatus, publishedAt: Date | null): boolean {
  return publishedAt === null && (status === "DRAFT" || status === "TOKENIZED");
}

/**
 * Serial as printed, reduced to letters and digits in upper case, so `ab-12 34`, `AB1234` and
 * full-width characters match.
 */
export function normalizeSerial(serial: string): string {
  return serial
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Brand reduced to lower-case letters and digits, so `Rolex`, `ROLEX` and `rolex.` match. */
export function normalizeBrand(brand: string | null): string {
  return (brand ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Canonical input of the serial fingerprint (HMAC). Versioned so the format can change
 * together with the key.
 */
export function serialFingerprintInput(
  category: AssetCategory,
  brand: string | null,
  serial: string,
): string {
  return ["wb-serial-v1", category, normalizeBrand(brand), normalizeSerial(serial)].join("|");
}
