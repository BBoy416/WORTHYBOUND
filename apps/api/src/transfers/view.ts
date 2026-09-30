import type { ChainTransactionStatus, Prisma } from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  CHAIN_TRANSACTION_STATUSES,
  ESCROW_STATUSES,
  TRANSFER_DELIVERIES,
  TRANSFER_STATUSES,
} from "@worthybound/shared";
import { z } from "zod";

const isoOrNull = (date: Date | null) => date?.toISOString() ?? null;

export const transferInclude = {
  asset: { select: { wbId: true, category: true, brand: true, model: true } },
  fromUser: { select: { walletAddress: true } },
  toUser: { select: { walletAddress: true } },
  /** The seller's latest capture session before shipping. */
  captureSessions: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { id: true, status: true },
  },
  receiptCheck: { select: { id: true } },
} satisfies Prisma.TransferRequestInclude;

export type TransferRecord = Prisma.TransferRequestGetPayload<{ include: typeof transferInclude }>;

export interface TransferJob {
  status: ChainTransactionStatus;
  attempts: number;
  signature: string | null;
}

/** The transfer's latest chain jobs: the transfer itself, and the payment into and refund from escrow. */
export interface TransferJobs {
  job: TransferJob | null;
  payment: TransferJob | null;
  refund: TransferJob | null;
}

const chainJobSchema = z
  .object({ status: z.enum(CHAIN_TRANSACTION_STATUSES), signature: z.string().nullable() })
  .nullable();
const chainJob = (job: TransferJob | null) =>
  job && { status: job.status, signature: job.signature };

/** A shipped transfer's escrow (ADR 0014), for both parties. */
const escrowSchema = z.object({
  status: z.enum(ESCROW_STATUSES),
  /** Payment into escrow (base64 wire bytes) for the buyer to sign, once both signed the transfer. */
  paymentTransaction: z.string().nullable(),
  awaitingYourPayment: z.boolean(),
  payment: chainJobSchema,
  refund: chainJobSchema,
  paidAt: z.string().nullable(),
  /** The seller films the item and the sealed package, and ships, before this. */
  shipBy: z.string().nullable(),
  /** The seller's latest capture session before shipping, and whether it was completed. */
  shipmentSessionId: z.uuid().nullable(),
  shipmentFilmed: z.boolean(),
  shippedAt: z.string().nullable(),
  carrier: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  /** The buyer confirms delivery before this, or can then cancel or extend it. */
  deliveryDueAt: z.string().nullable(),
  deliveryExtensions: z.int(),
  deliveredAt: z.string().nullable(),
  /** The buyer's photos of the package and the item (`/purchase-checks/:checkId`). */
  receiptCheckId: z.uuid().nullable(),
  /** The sale is released at this time unless the buyer reported a problem. */
  releaseAt: z.string().nullable(),
  disputedAt: z.string().nullable(),
  disputeReason: z.string().nullable(),
  resolution: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

export const transferSchema = z.object({
  id: z.uuid(),
  /** The caller's side of the transfer. */
  role: z.enum(["SENDER", "RECIPIENT"]),
  status: z.enum(TRANSFER_STATUSES),
  closedReason: z.string().nullable(),
  asset: z.object({
    wbId: z.string(),
    category: z.enum(ASSET_CATEGORIES),
    brand: z.string().nullable(),
    model: z.string().nullable(),
  }),
  fromWalletAddress: z.string(),
  toWalletAddress: z.string(),
  /** Paid by the buyer to the seller in the transfer transaction, as a decimal string; "0" for none. */
  priceLamports: z.string(),
  /** Handed over in person, or shipped with the price in escrow. */
  delivery: z.enum(TRANSFER_DELIVERIES),
  /** Null for transfers in person, and until a shipped transfer is accepted. */
  escrow: escrowSchema.nullable(),
  /** Unsigned transaction (base64 wire bytes) to sign with the wallet, while accepted. */
  transaction: z.string().nullable(),
  signedBySeller: z.boolean(),
  signedByBuyer: z.boolean(),
  awaitingYourSignature: z.boolean(),
  /** The on-chain transfer once both have signed. */
  chain: chainJobSchema,
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
});

export function toTransfer(
  { transfer: t, job, payment, refund }: { transfer: TransferRecord } & TransferJobs,
  userId: string,
): z.infer<typeof transferSchema> {
  const role = t.fromUserId === userId ? "SENDER" : "RECIPIENT";
  const signing =
    t.status === "ACCEPTED" &&
    t.transaction !== null &&
    (t.escrowStatus === null || t.escrowStatus === "AWAITING_PAYMENT");
  const mine = role === "SENDER" ? t.sellerSignature : t.buyerSignature;
  const paying =
    t.status === "ACCEPTED" &&
    t.escrowStatus === "AWAITING_PAYMENT" &&
    t.sellerSignature !== null &&
    t.buyerSignature !== null &&
    t.paymentSignature === null &&
    role === "RECIPIENT";
  const session = t.captureSessions[0];
  return {
    id: t.id,
    role,
    status: t.status,
    closedReason: t.closedReason,
    asset: t.asset,
    fromWalletAddress: t.fromUser.walletAddress,
    toWalletAddress: t.toWalletAddress,
    priceLamports: t.priceLamports.toString(),
    delivery: t.delivery,
    escrow: t.escrowStatus && {
      status: t.escrowStatus,
      paymentTransaction: paying ? t.paymentTransaction : null,
      awaitingYourPayment: paying,
      payment: chainJob(payment),
      refund: chainJob(refund),
      paidAt: isoOrNull(t.paidAt),
      shipBy: isoOrNull(t.shipBy),
      shipmentSessionId: session?.id ?? null,
      shipmentFilmed: session?.status === "COMPLETED",
      shippedAt: isoOrNull(t.shippedAt),
      carrier: t.carrier,
      trackingNumber: t.trackingNumber,
      deliveryDueAt: isoOrNull(t.deliveryDueAt),
      deliveryExtensions: t.deliveryExtensions,
      deliveredAt: isoOrNull(t.deliveredAt),
      receiptCheckId: t.receiptCheck?.id ?? null,
      releaseAt: isoOrNull(t.releaseAt),
      disputedAt: isoOrNull(t.disputedAt),
      disputeReason: t.disputeReason,
      resolution: t.resolution,
      resolvedAt: isoOrNull(t.resolvedAt),
    },
    transaction: signing ? t.transaction : null,
    signedBySeller: t.sellerSignature !== null,
    signedByBuyer: t.buyerSignature !== null,
    awaitingYourSignature: signing && mine === null,
    chain: chainJob(job),
    expiresAt: t.expiresAt.toISOString(),
    acceptedAt: isoOrNull(t.acceptedAt),
    completedAt: isoOrNull(t.completedAt),
    cancelledAt: isoOrNull(t.cancelledAt),
    createdAt: t.createdAt.toISOString(),
  };
}

/** An administrator's view of a transfer: both parties, nothing to sign. */
export const adminTransferSchema = transferSchema.omit({
  role: true,
  transaction: true,
  awaitingYourSignature: true,
});

export function toAdminTransfer(
  record: { transfer: TransferRecord } & TransferJobs,
): z.infer<typeof adminTransferSchema> {
  return adminTransferSchema.parse(toTransfer(record, record.transfer.fromUserId));
}
