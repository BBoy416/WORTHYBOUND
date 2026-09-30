import type { Asset, Evidence, PurchaseCheck, PurchaseCheckPhoto } from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  CAPTURE_SHOT_INSTRUCTIONS,
  CAPTURE_SHOTS,
  type CaptureShot,
  ITEM_MATCH_REASONS,
  ITEM_MATCH_RESULTS,
  type ItemMatchReason,
  ownerConfirmationMessage,
  PURCHASE_CHECK_STATUSES,
  publicEvidencePath,
  VERIFICATION_LEVELS,
} from "@worthybound/shared";
import { z } from "zod";

export type CheckRecord = PurchaseCheck & {
  asset: Asset;
  photos: Pick<PurchaseCheckPhoto, "shot" | "createdAt">[];
};

export type RecordedPhoto = Pick<Evidence, "id" | "publicStorageKey">;

/** Asset statuses in which the item cannot be transferred. */
const BLOCKED = ["REPORTED_LOST", "REPORTED_STOLEN", "DISPUTED", "REVOKED"] as const;

/** The buyer's view of a check. Never names the seller's wallet or identity. */
export const purchaseCheckSchema = z.object({
  id: z.uuid(),
  status: z.enum(PURCHASE_CHECK_STATUSES),
  asset: z.object({
    wbId: z.string(),
    category: z.enum(ASSET_CATEGORIES),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(ASSET_STATUSES),
    verificationLevel: z.enum(VERIFICATION_LEVELS),
    /** Lost, stolen, disputed or revoked: the item cannot be transferred. */
    transferBlocked: z.boolean(),
  }),
  owner: z.object({
    /** The current owner signed the buyer's code with the owner's wallet. */
    confirmed: z.boolean(),
    confirmedAt: z.iso.datetime().nullable(),
    /** Code for the seller to sign, while it is valid and not yet signed. */
    code: z.string().nullable(),
    codeExpiresAt: z.iso.datetime().nullable(),
    /** What the seller's wallet shows when signing. */
    message: z.string().nullable(),
  }),
  item: z.object({
    shots: z.array(
      z.object({
        shot: z.enum(CAPTURE_SHOTS),
        instruction: z.string(),
        receivedAt: z.iso.datetime().nullable(),
      }),
    ),
    /** Every photo arrived and the comparison is running. */
    comparing: z.boolean(),
    result: z.enum(ITEM_MATCH_RESULTS).nullable(),
    /** Why the result is inconclusive without a comparison. */
    reason: z.string().nullable(),
    checkedAt: z.iso.datetime().nullable(),
    /** Public copies of the recorded photos that were compared; private ones are never shown. */
    recordedPhotos: z.array(z.object({ path: z.string() })),
  }),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type PurchaseCheckView = z.infer<typeof purchaseCheckSchema>;

const iso = (date: Date | null) => date?.toISOString() ?? null;

export function toPurchaseCheck(
  check: CheckRecord,
  recorded: RecordedPhoto[],
  at: Date,
): PurchaseCheckView {
  const { asset } = check;
  const taken = new Map(check.photos.map((p) => [p.shot, p.createdAt]));
  const confirmed = check.ownerConfirmedAt !== null && check.ownerConfirmedById === asset.ownerId;
  const codeValid =
    check.status === "OPEN" &&
    check.ownerConfirmedAt === null &&
    check.ownerCodeExpiresAt > at &&
    check.expiresAt > at;
  const expired =
    check.status === "OPEN" && check.photosCompletedAt === null && check.expiresAt <= at;
  return {
    id: check.id,
    status: expired ? "EXPIRED" : check.status,
    asset: {
      wbId: asset.wbId,
      category: asset.category,
      brand: asset.brand,
      model: asset.model,
      status: asset.status,
      verificationLevel: asset.verificationLevel,
      transferBlocked: (BLOCKED as readonly string[]).includes(asset.status),
    },
    owner: {
      confirmed,
      confirmedAt: confirmed ? iso(check.ownerConfirmedAt) : null,
      code: codeValid ? check.ownerCode : null,
      codeExpiresAt: codeValid ? iso(check.ownerCodeExpiresAt) : null,
      message: codeValid ? ownerConfirmationMessage(asset.wbId, check.ownerCode) : null,
    },
    item: {
      shots: (check.shots as CaptureShot[]).map((shot) => ({
        shot,
        instruction: CAPTURE_SHOT_INSTRUCTIONS[shot],
        receivedAt: iso(taken.get(shot) ?? null),
      })),
      comparing: check.photosCompletedAt !== null && check.itemResult === null,
      result: check.itemResult,
      reason: check.itemReason
        ? (ITEM_MATCH_REASONS[check.itemReason as ItemMatchReason] ?? null)
        : null,
      checkedAt: iso(check.itemCheckedAt),
      recordedPhotos: recorded
        .filter((e) => e.publicStorageKey !== null && check.referenceEvidenceIds.includes(e.id))
        .map((e) => ({ path: publicEvidencePath(asset.wbId, e.id) })),
    },
    expiresAt: check.expiresAt.toISOString(),
    createdAt: check.createdAt.toISOString(),
  };
}
