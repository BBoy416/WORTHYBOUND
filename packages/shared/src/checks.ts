import type { EvidenceType } from "./enums.js";

/**
 * Categories of problem an automated check can report (ADR 0013). Owners see the category,
 * never the detection details.
 */
export const CHECK_PROBLEMS = [
  "ITEM_NOT_VISIBLE",
  "UNREADABLE",
  "WRONG_EVIDENCE_TYPE",
  "DOES_NOT_MATCH_ASSET",
  "SCREEN_OR_PRINT",
  "AI_GENERATED_OR_EDITED",
  "STOCK_OR_ONLINE_IMAGE",
  "DOCUMENT_MISMATCH",
  "DOCUMENT_TAMPERING",
  "REUSED_FILE",
  "SIMILAR_PHOTO",
  "REUSED_DOCUMENT",
] as const;
export type CheckProblem = (typeof CHECK_PROBLEMS)[number];

/** Problems found by comparing files and records, never reported by a model. */
export const DETERMINISTIC_CHECK_PROBLEMS = [
  "REUSED_FILE",
  "SIMILAR_PHOTO",
  "REUSED_DOCUMENT",
] as const satisfies readonly CheckProblem[];

/** Problems that suggest a fake rather than a poor file; they fail a check. */
export const FAILING_CHECK_PROBLEMS: readonly CheckProblem[] = [
  "DOES_NOT_MATCH_ASSET",
  "SCREEN_OR_PRINT",
  "AI_GENERATED_OR_EDITED",
  "STOCK_OR_ONLINE_IMAGE",
  "DOCUMENT_MISMATCH",
  "DOCUMENT_TAMPERING",
  "REUSED_FILE",
  "SIMILAR_PHOTO",
  "REUSED_DOCUMENT",
];

/** What the owner is told for each problem. */
export const CHECK_PROBLEM_MESSAGES: Record<CheckProblem, string> = {
  ITEM_NOT_VISIBLE: "The item is not clearly visible",
  UNREADABLE: "The file is too blurry, dark or small to check",
  WRONG_EVIDENCE_TYPE: "The file does not look like the evidence type it was added as",
  DOES_NOT_MATCH_ASSET: "The file does not seem to show this item",
  SCREEN_OR_PRINT: "This looks like a photo of a screen or a print",
  AI_GENERATED_OR_EDITED: "This image appears to be generated or edited",
  STOCK_OR_ONLINE_IMAGE: "This looks like a stock or online image",
  DOCUMENT_MISMATCH: "The document does not match the item's details",
  DOCUMENT_TAMPERING: "The document shows signs of alteration",
  REUSED_FILE: "This file is already attached to another asset",
  SIMILAR_PHOTO: "A near-identical photo is attached to another asset",
  REUSED_DOCUMENT: "A document with the same number is attached to another asset",
};

/** File types sent to the AI check; videos and HEIC photos are not checked yet. */
export const CHECKABLE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

/** Owner evidence that the automated checks examine. */
export function isCheckable(type: EvidenceType, mimeType: string): boolean {
  return type !== "OTHER" && (CHECKABLE_MIME_TYPES as readonly string[]).includes(mimeType);
}
