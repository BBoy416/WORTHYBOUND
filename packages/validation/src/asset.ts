import { ASSET_CATEGORIES, ASSET_STATUSES, ITEM_CONDITIONS } from "@worthybound/shared";
import { z } from "zod";
import { text, wbIdSchema } from "./common.js";

export const MAX_ASSET_ATTRIBUTES = 50;

/** Flat key/value details such as dial colour or year; stored as a JSON object. */
export const assetAttributesSchema = z
  .record(z.string().trim().min(1).max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine(
    (attributes) => Object.keys(attributes).length <= MAX_ASSET_ATTRIBUTES,
    `at most ${MAX_ASSET_ATTRIBUTES} attributes`,
  );

const assetFields = {
  category: z.enum(ASSET_CATEGORIES),
  brand: text(100).optional(),
  model: text(100).optional(),
  /** Private: never shown publicly or written on-chain. */
  serialNumber: text(100).optional(),
  /** Private notes for the owner and verifiers. */
  description: text(5000).optional(),
  publicDescription: text(2000).optional(),
  attributes: assetAttributesSchema.optional(),
  /** Owner-stated; the verified condition comes from CONDITION attestations. */
  condition: z.enum(ITEM_CONDITIONS).optional(),
};

/** IDs, status, owner, Trust Score and chain fields are set by the backend and rejected here. */
export const registerAssetSchema = z.strictObject(assetFields);
export type RegisterAssetInput = z.infer<typeof registerAssetSchema>;

export const updateDraftAssetSchema = z
  .strictObject(assetFields)
  .partial()
  .refine((input) => Object.keys(input).length > 0, "no fields to update");
export type UpdateDraftAssetInput = z.infer<typeof updateDraftAssetSchema>;

const conditionFields = {
  condition: z.enum(ITEM_CONDITIONS),
  note: text(500).optional(),
};

/** Body of `POST /assets/:wbId/condition`. */
export const assetConditionRequestSchema = z.strictObject(conditionFields);
export type AssetConditionRequest = z.infer<typeof assetConditionRequestSchema>;

/** Owner updates the stated condition of a published asset; recorded as CONDITION_UPDATED. */
export const assetConditionUpdateSchema = z.strictObject({
  assetId: wbIdSchema,
  ...conditionFields,
});
export type AssetConditionUpdateInput = z.infer<typeof assetConditionUpdateSchema>;

const statusFields = {
  toStatus: z.enum(ASSET_STATUSES),
  reason: text(500).optional(),
};

/** Body of `POST /assets/:wbId/status`. */
export const assetStatusRequestSchema = z.strictObject(statusFields);
export type AssetStatusRequest = z.infer<typeof assetStatusRequestSchema>;

/** Requested status change; the lifecycle rules decide whether the caller may make it. */
export const assetStatusChangeSchema = z.strictObject({ assetId: wbIdSchema, ...statusFields });
export type AssetStatusChangeInput = z.infer<typeof assetStatusChangeSchema>;

/** Path parameter of the asset and passport endpoints. */
export const assetParamsSchema = z.strictObject({ wbId: wbIdSchema });
