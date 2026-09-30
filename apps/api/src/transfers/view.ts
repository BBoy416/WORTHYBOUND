import type { ChainTransactionStatus, Prisma } from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  CHAIN_TRANSACTION_STATUSES,
  TRANSFER_STATUSES,
} from "@worthybound/shared";
import { z } from "zod";

const isoOrNull = (date: Date | null) => date?.toISOString() ?? null;

export const transferInclude = {
  asset: { select: { wbId: true, category: true, brand: true, model: true } },
  fromUser: { select: { walletAddress: true } },
  toUser: { select: { walletAddress: true } },
} satisfies Prisma.TransferRequestInclude;

export type TransferRecord = Prisma.TransferRequestGetPayload<{ include: typeof transferInclude }>;

export interface TransferJob {
  status: ChainTransactionStatus;
  attempts: number;
  signature: string | null;
}

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
  /** Unsigned transaction (base64 wire bytes) to sign with the wallet, while accepted. */
  transaction: z.string().nullable(),
  signedBySeller: z.boolean(),
  signedByBuyer: z.boolean(),
  awaitingYourSignature: z.boolean(),
  /** The on-chain transfer once both have signed. */
  chain: z
    .object({ status: z.enum(CHAIN_TRANSACTION_STATUSES), signature: z.string().nullable() })
    .nullable(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
});

export function toTransfer(
  { transfer: t, job }: { transfer: TransferRecord; job: TransferJob | null },
  userId: string,
): z.infer<typeof transferSchema> {
  const role = t.fromUserId === userId ? "SENDER" : "RECIPIENT";
  const signing = t.status === "ACCEPTED" && t.transaction !== null;
  const mine = role === "SENDER" ? t.sellerSignature : t.buyerSignature;
  return {
    id: t.id,
    role,
    status: t.status,
    closedReason: t.closedReason,
    asset: t.asset,
    fromWalletAddress: t.fromUser.walletAddress,
    toWalletAddress: t.toWalletAddress,
    priceLamports: t.priceLamports.toString(),
    transaction: signing ? t.transaction : null,
    signedBySeller: t.sellerSignature !== null,
    signedByBuyer: t.buyerSignature !== null,
    awaitingYourSignature: signing && mine === null,
    chain: job && { status: job.status, signature: job.signature },
    expiresAt: t.expiresAt.toISOString(),
    acceptedAt: isoOrNull(t.acceptedAt),
    completedAt: isoOrNull(t.completedAt),
    cancelledAt: isoOrNull(t.cancelledAt),
    createdAt: t.createdAt.toISOString(),
  };
}
