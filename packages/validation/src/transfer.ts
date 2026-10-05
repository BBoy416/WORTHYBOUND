import {
  CAPTURE_CODE_ALPHABET,
  CAPTURE_CODE_LENGTH,
  CAPTURE_SHOTS,
  DISPUTE_STATUSES,
  TRANSFER_DELIVERIES,
} from "@worthybound/shared";
import { z } from "zod";
import {
  solanaAddressSchema,
  solanaSignatureSchema,
  text,
  uuidSchema,
  wbIdSchema,
} from "./common.js";

export const transferRequestSchema = z.strictObject({
  assetId: wbIdSchema,
  toWalletAddress: solanaAddressSchema,
  expiresInHours: z.int().min(1).max(168).default(72),
  /** Lamports as a decimal string, below 10^18 (1 billion SOL); "0" for no payment. */
  priceLamports: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,17})$/, "expected a whole number of lamports")
    .default("0"),
  /** Shipped items are paid into escrow and need a price (ADR 0014). */
  delivery: z.enum(TRANSFER_DELIVERIES).default("IN_PERSON"),
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

/** The seller has shipped the filmed, sealed package. */
export const shipmentSchema = z.strictObject({
  carrier: text(100),
  trackingNumber: text(100),
});
export type ShipmentInput = z.infer<typeof shipmentSchema>;

/** The buyer reports a problem with a shipped item; the escrow is held for an administrator. */
export const escrowDisputeSchema = z.strictObject({ reason: text(2000) });
export type EscrowDisputeInput = z.infer<typeof escrowDisputeSchema>;

/** An administrator's decision on a disputed escrow: pay the seller or refund the buyer. */
export const resolveEscrowSchema = z.strictObject({
  outcome: z.enum(["RELEASE", "REFUND"]),
  resolution: text(2000),
});
export type ResolveEscrowInput = z.infer<typeof resolveEscrowSchema>;

export const purchaseCheckParamsSchema = z.strictObject({ checkId: uuidSchema });
export const purchaseCheckPhotoParamsSchema = z.strictObject({
  checkId: uuidSchema,
  shot: z.enum(CAPTURE_SHOTS),
});
/** A remote check of the owner's asset. */
export const remoteCheckParamsSchema = z.strictObject({ wbId: wbIdSchema, checkId: uuidSchema });

/**
 * The seller's signature (base58) of `ownerConfirmationMessage` with the buyer's code. The code
 * is accepted in any case and with spaces, as read out or typed.
 */
export const ownerConfirmationSchema = z.strictObject({
  code: z
    .string()
    .max(20)
    .transform((code) => code.replace(/\s/g, "").toUpperCase())
    .pipe(
      z
        .string()
        .regex(
          new RegExp(`^[${CAPTURE_CODE_ALPHABET}]{${CAPTURE_CODE_LENGTH}}$`),
          "expected the buyer's code",
        ),
    ),
  signature: solanaSignatureSchema,
});
export type OwnerConfirmationInput = z.infer<typeof ownerConfirmationSchema>;

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

/** Statuses an administrator can give an asset held by a dispute when deciding it (ADR 0017). */
export const DISPUTE_ASSET_OUTCOMES = ["ACTIVE", "REVERIFICATION_REQUIRED", "REVOKED"] as const;

/**
 * `assetStatus` applies only when the dispute holds the asset; without it the asset returns to
 * ACTIVE, or REVERIFICATION_REQUIRED if it was awaiting reverification.
 */
export const resolveDisputeSchema = z.strictObject({
  outcome: z.enum(["UPHELD", "REJECTED"]),
  resolution: text(2000),
  assetStatus: z.enum(DISPUTE_ASSET_OUTCOMES).optional(),
});
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;

/** Starting a review; `holdAsset` puts the asset on hold (DISPUTED), which blocks transfers. */
export const reviewDisputeSchema = z.strictObject({ holdAsset: z.boolean().default(false) });
export type ReviewDisputeInput = z.infer<typeof reviewDisputeSchema>;

export const disputeParamsSchema = z.strictObject({ disputeId: uuidSchema });

export const disputeListQuerySchema = z.strictObject({
  status: z.enum(DISPUTE_STATUSES).optional(),
});
