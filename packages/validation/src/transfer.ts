import { z } from "zod";
import { solanaAddressSchema, text, uuidSchema, wbIdSchema } from "./common.js";

export const transferRequestSchema = z.strictObject({
  assetId: wbIdSchema,
  toWalletAddress: solanaAddressSchema,
  expiresInHours: z.int().min(1).max(168).default(72),
});
export type TransferRequestInput = z.infer<typeof transferRequestSchema>;

export const transferParamsSchema = z.strictObject({ transferId: uuidSchema });

/** The whole transaction as the wallet returned it after signing (base64 wire bytes). */
export const transferSignatureSchema = z.strictObject({
  signedTransaction: z
    .string()
    .max(4096)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64"),
});
export type TransferSignatureInput = z.infer<typeof transferSignatureSchema>;

/** A dispute targets the asset, or one attestation or evidence item on it. */
export const openDisputeSchema = z
  .strictObject({
    assetId: wbIdSchema,
    attestationId: uuidSchema.optional(),
    evidenceId: uuidSchema.optional(),
    reason: text(200),
    details: text(5000).optional(),
  })
  .refine((input) => !(input.attestationId && input.evidenceId), {
    message: "a dispute targets an attestation or an evidence item, not both",
    path: ["evidenceId"],
  });
export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;

export const resolveDisputeSchema = z.strictObject({
  outcome: z.enum(["UPHELD", "REJECTED"]),
  resolution: text(2000),
});
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;
