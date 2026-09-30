import { CAPTURE_CODE_SHOT, CAPTURE_SHOTS_BY_CATEGORY, type CaptureShot } from "./capture.js";
import type { AssetCategory } from "./enums.js";

/** Minutes a buyer has to finish a check before buying, in person (ADR 0014). */
export const PURCHASE_CHECK_MINUTES = 60;
/** Minutes the seller has to sign the buyer's one-time code with the owner's wallet. */
export const OWNER_CODE_MINUTES = 5;
/** Checks a buyer may start per day, and checks of one item per day by anyone. */
export const PURCHASE_CHECKS_PER_BUYER_PER_DAY = 10;
export const PURCHASE_CHECKS_PER_ASSET_PER_DAY = 10;
/** Recorded photos compared with the buyer's, at most. */
export const MAX_REFERENCE_PHOTOS = 8;

/**
 * Shots the buyer takes of the item in front of them: the capture shots for the category,
 * without the code shot, since the buyer takes them live.
 */
export const purchaseCheckShots = (category: AssetCategory): CaptureShot[] =>
  CAPTURE_SHOTS_BY_CATEGORY[category].filter((s) => s !== CAPTURE_CODE_SHOT);

/** Why an item check is inconclusive without comparing photos. */
export const ITEM_MATCH_REASONS = {
  NO_REFERENCE_PHOTOS: "The item has no recorded photos to compare with",
  NO_CONSENT: "The owner has not agreed to AI checks of the item's photos",
  CHECKS_UNAVAILABLE: "Photo comparison is not available right now",
  CHECK_FAILED: "The photos could not be compared",
} as const;
export type ItemMatchReason = keyof typeof ITEM_MATCH_REASONS;

/**
 * The text the seller signs with the owner's wallet to confirm, to a buyer in front of them,
 * that they own the item. The code comes from the buyer's check.
 */
export const ownerConfirmationMessage = (wbId: string, code: string): string =>
  `WorthyBound: I confirm to a buyer that I own ${wbId}.\nCode: ${code}`;
