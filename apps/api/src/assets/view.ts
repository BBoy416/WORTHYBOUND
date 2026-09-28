import type { Asset } from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  isPassportPublic,
  ITEM_CONDITIONS,
  missingPublishFields,
  passportUrl,
  TOKENIZATION_STATUSES,
  VERIFICATION_LEVELS,
} from "@worthybound/shared";
import { z } from "zod";

/** The owner's private view of an asset. The serial fingerprint is never returned. */
export const ownerAssetSchema = z.object({
  wbId: z.string(),
  category: z.enum(ASSET_CATEGORIES),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string().nullable(),
  description: z.string().nullable(),
  publicDescription: z.string().nullable(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  condition: z.enum(ITEM_CONDITIONS).nullable(),
  status: z.enum(ASSET_STATUSES),
  tokenizationStatus: z.enum(TOKENIZATION_STATUSES),
  chainAssetAddress: z.string().nullable(),
  verificationLevel: z.enum(VERIFICATION_LEVELS),
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Public passport address (for QR codes), once published. */
  passportUrl: z.string().nullable(),
  /** Fields still needed before the draft can be published. */
  missingForPublish: z.array(z.string()),
});
export type OwnerAsset = z.infer<typeof ownerAssetSchema>;

export function toOwnerAsset(asset: Asset, publicWebUrl: string): OwnerAsset {
  const published = asset.publishedAt !== null && isPassportPublic(asset.status);
  return {
    wbId: asset.wbId,
    category: asset.category,
    brand: asset.brand,
    model: asset.model,
    serialNumber: asset.serialNumber,
    description: asset.description,
    publicDescription: asset.publicDescription,
    attributes: asset.attributes as OwnerAsset["attributes"],
    condition: asset.condition,
    status: asset.status,
    tokenizationStatus: asset.tokenizationStatus,
    chainAssetAddress: asset.chainAssetAddress,
    verificationLevel: asset.verificationLevel,
    publishedAt: asset.publishedAt?.toISOString() ?? null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    passportUrl: published ? passportUrl(publicWebUrl, asset.wbId) : null,
    missingForPublish: asset.publishedAt === null ? missingPublishFields(asset) : [],
  };
}
