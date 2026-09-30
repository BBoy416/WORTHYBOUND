import type { AssetCategory } from "./enums.js";

/** Minutes a capture session's code stays valid (ADR 0013). */
export const CAPTURE_SESSION_MINUTES = 15;
/** Capture sessions an owner may start per asset, and in total, per day. */
export const CAPTURE_SESSIONS_PER_ASSET_PER_DAY = 3;
export const CAPTURE_SESSIONS_PER_USER_PER_DAY = 10;

/** Characters of a capture code: no 0/O, 1/I/L, so it can be written and read by hand. */
export const CAPTURE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CAPTURE_CODE_LENGTH = 6;

export const CAPTURE_SHOTS = [
  "FRONT",
  "BACK",
  "SIDE",
  "DETAIL",
  "SERIAL",
  "MARKINGS",
  "DIAL",
  "CASEBACK",
  "CLASP",
  "HALLMARK",
  "SIGNATURE",
  "INTERIOR",
  "VIN",
  "CODE",
] as const;
export type CaptureShot = (typeof CAPTURE_SHOTS)[number];

/** The shot of the item next to the session's code written on paper. */
export const CAPTURE_CODE_SHOT = "CODE" satisfies CaptureShot;

/** Shots required in a capture session, per category; the code shot comes last. */
export const CAPTURE_SHOTS_BY_CATEGORY: Record<AssetCategory, readonly CaptureShot[]> = {
  LUXURY_WATCH: ["DIAL", "CASEBACK", "CLASP", "SERIAL", "SIDE", "CODE"],
  FINE_ART: ["FRONT", "BACK", "SIGNATURE", "DETAIL", "CODE"],
  JEWELRY: ["FRONT", "BACK", "HALLMARK", "CLASP", "CODE"],
  COLLECTIBLE_CAR: ["FRONT", "BACK", "SIDE", "INTERIOR", "VIN", "CODE"],
  COLLECTIBLE: ["FRONT", "BACK", "DETAIL", "MARKINGS", "CODE"],
  EQUIPMENT: ["FRONT", "BACK", "SERIAL", "DETAIL", "CODE"],
  OTHER: ["FRONT", "BACK", "DETAIL", "MARKINGS", "CODE"],
};

/** What each shot shows; told to the owner and to the automated check. */
export const CAPTURE_SHOT_INSTRUCTIONS: Record<CaptureShot, string> = {
  FRONT: "The whole item from the front",
  BACK: "The whole item from the back",
  SIDE: "The item from the side",
  DETAIL: "A close-up of a distinctive detail",
  SERIAL: "The serial number, close enough to read",
  MARKINGS: "Maker's marks, labels or stamps",
  DIAL: "The dial, face on",
  CASEBACK: "The caseback",
  CLASP: "The clasp or buckle",
  HALLMARK: "The hallmark or stamp, close enough to read",
  SIGNATURE: "The artist's signature",
  INTERIOR: "The interior",
  VIN: "The VIN plate, close enough to read",
  CODE: "The item next to the code written on paper",
};
