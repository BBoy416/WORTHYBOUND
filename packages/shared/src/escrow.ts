import { CAPTURE_PACKAGE_SHOT, CAPTURE_SHOTS_BY_CATEGORY, type CaptureShot } from "./capture.js";
import type { AssetCategory } from "./enums.js";
import { purchaseCheckShots } from "./purchase.js";

/** Days the seller has to film and ship the item once the buyer paid into escrow (ADR 0014). */
export const SHIP_WITHIN_DAYS = 3;
/** Days from shipping for the buyer to confirm delivery before they can cancel or extend. */
export const DELIVERY_WITHIN_DAYS = 21;
/** Days each extension of the delivery period adds, and how many the buyer can ask for. */
export const DELIVERY_EXTENSION_DAYS = 7;
export const MAX_DELIVERY_EXTENSIONS = 3;
/** Hours after delivery for the buyer to photograph the package and the item. */
export const RECEIPT_CHECK_HOURS = 48;
/**
 * Days after delivery, or after the delivery period without a confirmation, after which the sale
 * is released to the seller unless the buyer reported a problem.
 */
export const RELEASE_AFTER_DAYS = 7;

/**
 * Shots the seller takes before shipping, in a capture session: the capture shots for the
 * category, with the code shot, then the sealed package with the same code written on it.
 */
export const shipmentShots = (category: AssetCategory): CaptureShot[] => [
  ...CAPTURE_SHOTS_BY_CATEGORY[category],
  CAPTURE_PACKAGE_SHOT,
];

/**
 * Shots the buyer takes on receipt: the package as it arrived, with the seller's code on it,
 * then the item as in a check in person.
 */
export const receiptShots = (category: AssetCategory): CaptureShot[] => [
  CAPTURE_PACKAGE_SHOT,
  ...purchaseCheckShots(category),
];
