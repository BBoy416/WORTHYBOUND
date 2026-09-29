import type { Asset, TrustScoreSnapshot } from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  isPassportPublic,
  ITEM_CONDITIONS,
  missingPublishFields,
  passportUrl,
  TOKENIZATION_STATUSES,
  TRUST_SCORE_DISCLAIMER,
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
  /** Metaplex Core token, once tokenization has been requested. */
  chainAssetAddress: z.string().nullable(),
  /** On-chain WorthyBound record with status and Trust Score. */
  chainRecordAddress: z.string().nullable(),
  verificationLevel: z.enum(VERIFICATION_LEVELS),
  /** From the latest Trust Score snapshot; 0 until the first one. */
  trustScore: z.int(),
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
    chainRecordAddress: asset.chainRecordAddress,
    verificationLevel: asset.verificationLevel,
    trustScore: asset.currentTrustScore,
    publishedAt: asset.publishedAt?.toISOString() ?? null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    passportUrl: published ? passportUrl(publicWebUrl, asset.wbId) : null,
    missingForPublish: asset.publishedAt === null ? missingPublishFields(asset) : [],
  };
}

const pointsSchema = z.object({
  code: z.string(),
  points: z.number(),
  proofId: z.string().optional(),
  count: z.int().optional(),
  proofIds: z.array(z.string()).optional(),
  detail: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

/** The owner's view of the latest Trust Score, with every factor, deduction and cap. */
export const ownerTrustSchema = z.object({
  score: z.int(),
  verificationLevel: z.enum(VERIFICATION_LEVELS),
  factors: z.array(pointsSchema),
  deductions: z.array(pointsSchema),
  capsApplied: z.array(z.object({ code: z.string(), limit: z.number() })),
  excludedProofs: z.array(z.object({ proofId: z.string(), reason: z.string() })),
  engineVersion: z.string(),
  weightsVersion: z.string(),
  inputsHash: z.string(),
  computedAt: z.iso.datetime(),
  disclaimer: z.string(),
});
export type OwnerTrust = z.infer<typeof ownerTrustSchema>;

export function toOwnerTrust(snapshot: TrustScoreSnapshot | null): OwnerTrust | null {
  if (!snapshot) return null;
  return {
    score: snapshot.score,
    verificationLevel: snapshot.verificationLevel,
    factors: snapshot.factors as OwnerTrust["factors"],
    deductions: snapshot.deductions as OwnerTrust["deductions"],
    capsApplied: snapshot.capsApplied as OwnerTrust["capsApplied"],
    excludedProofs: snapshot.excludedProofs as OwnerTrust["excludedProofs"],
    engineVersion: snapshot.engineVersion,
    weightsVersion: snapshot.weightsVersion,
    inputsHash: snapshot.inputsHash,
    computedAt: snapshot.computedAt.toISOString(),
    disclaimer: TRUST_SCORE_DISCLAIMER,
  };
}
