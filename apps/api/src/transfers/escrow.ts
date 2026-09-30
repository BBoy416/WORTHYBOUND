import type { ItemMatchResult, Prisma, PrismaClient, TransferRequest } from "@worthybound/database";
import { RELEASE_AFTER_DAYS, SHIP_WITHIN_DAYS } from "@worthybound/shared";
import type { Actor } from "../assets/service.js";
import { writeAudit } from "../audit.js";
import { closeTransfer, lockAsset, transferJobKey } from "./service.js";

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60_000;

export const escrowPaymentJobKey = (transferId: string, attempt: number) =>
  `escrow-payment:${transferId}:${attempt}`;
export const escrowRefundJobKey = (transferId: string) => `escrow-refund:${transferId}`;

/** Locks the transfer's asset and returns the transfer as it is now. */
export async function lockEscrow(tx: Tx, transferId: string): Promise<TransferRequest> {
  const found = await tx.transferRequest.findUniqueOrThrow({
    where: { id: transferId },
    select: { assetId: true },
  });
  await lockAsset(tx, found.assetId);
  return tx.transferRequest.findUniqueOrThrow({ where: { id: transferId } });
}

const audit = (
  tx: Tx,
  transferId: string,
  action: string,
  metadata: Prisma.InputJsonObject,
  actor: Actor | null,
) =>
  writeAudit(
    tx,
    {
      actorId: actor?.userId ?? null,
      action,
      targetType: "transfer_request",
      targetId: transferId,
      metadata,
    },
    actor?.fp ?? null,
  );

/**
 * Queues the prepared transfer, which pays the seller from escrow and hands the token to the
 * buyer in one transaction. Run after locking the asset.
 */
export async function releaseEscrow(
  tx: Tx,
  transfer: TransferRequest,
  reason: string,
  at: Date,
  actor: Actor | null = null,
): Promise<void> {
  await tx.transferRequest.update({
    where: { id: transfer.id },
    data: { escrowStatus: "RELEASING", updatedAt: at },
  });
  await tx.chainTransaction.create({
    data: {
      idempotencyKey: transferJobKey(transfer.id),
      kind: "TRANSFER_ASSET",
      cluster: "DEVNET",
      entityType: "TRANSFER_REQUEST",
      entityId: transfer.id,
    },
  });
  await audit(tx, transfer.id, "transfer.escrow_releasing", { reason }, actor);
}

/**
 * Queues the refund of the escrowed price to the buyer, which also makes the prepared transfer
 * unusable. The transfer is cancelled with `reason` once the refund is confirmed. Run after
 * locking the asset.
 */
export async function refundEscrow(
  tx: Tx,
  transfer: TransferRequest,
  reason: string,
  at: Date,
  actor: Actor | null = null,
): Promise<void> {
  await tx.transferRequest.update({
    where: { id: transfer.id },
    data: { escrowStatus: "REFUNDING", closedReason: reason, updatedAt: at },
  });
  await tx.chainTransaction.create({
    data: {
      idempotencyKey: escrowRefundJobKey(transfer.id),
      kind: "ESCROW_REFUND",
      cluster: "DEVNET",
      entityType: "TRANSFER_REQUEST",
      entityId: transfer.id,
    },
  });
  await audit(tx, transfer.id, "transfer.escrow_refunding", { reason }, actor);
}

/** Holds token and payment for an administrator's decision. Run after locking the asset. */
export async function disputeEscrow(
  tx: Tx,
  transfer: TransferRequest,
  reason: string,
  at: Date,
  actor: Actor | null = null,
): Promise<void> {
  await tx.transferRequest.update({
    where: { id: transfer.id },
    data: { escrowStatus: "DISPUTED", disputedAt: at, disputeReason: reason, updatedAt: at },
  });
  await audit(tx, transfer.id, "transfer.escrow_disputed", { reason }, actor);
}

/**
 * Records the buyer's payment confirmed on-chain: the seller now has SHIP_WITHIN_DAYS to ship.
 * A payment that lands after the transfer ended is refunded. Called by the chain worker.
 */
async function paid(tx: Tx, transferId: string, signature: string, at: Date): Promise<void> {
  const transfer = await lockEscrow(tx, transferId);
  if (transfer.escrowStatus !== "AWAITING_PAYMENT") return;
  await tx.transferRequest.update({
    where: { id: transferId },
    data: {
      escrowStatus: "PAID",
      paidAt: at,
      shipBy: new Date(at.getTime() + SHIP_WITHIN_DAYS * DAY_MS),
      updatedAt: at,
    },
  });
  await audit(tx, transferId, "transfer.escrow_paid", { signature }, null);
  if (transfer.status !== "ACCEPTED") {
    await refundEscrow(tx, { ...transfer, escrowStatus: "PAID" }, "paid_after_close", at);
  }
}

/**
 * Records the refund confirmed on-chain (`signature`), or found already made (null), and cancels
 * the transfer; the asset returns to its status before the transfer. Called by the chain worker.
 */
async function refunded(
  tx: Tx,
  transferId: string,
  signature: string | null,
  at: Date,
): Promise<void> {
  const transfer = await lockEscrow(tx, transferId);
  if (transfer.escrowStatus !== "REFUNDING") return;
  if (transfer.status === "ACCEPTED") {
    const system = { actor: "SYSTEM" as const, userId: null, fp: null };
    const reason = transfer.closedReason ?? "escrow_refunded";
    await closeTransfer(tx, transfer, "CANCELLED", system, reason, at, true);
  }
  await tx.transferRequest.update({
    where: { id: transferId },
    data: { escrowStatus: "REFUNDED", updatedAt: at },
  });
  await audit(tx, transferId, "transfer.escrow_refunded", { signature }, null);
}

/**
 * The prepared transfer could not be sent; its nonce may have moved on, so only a refund is
 * safe. Holds the escrow for an administrator. Called by the chain worker.
 */
async function releaseFailed(tx: Tx, transferId: string, at: Date): Promise<void> {
  const transfer = await lockEscrow(tx, transferId);
  if (transfer.escrowStatus !== "RELEASING") return;
  await disputeEscrow(tx, transfer, "release_failed", at);
}

/** What the chain worker records for escrow jobs, in the transaction that finishes the job. */
export const escrowChainHooks = { paid, refunded, releaseFailed };
export type EscrowChainHooks = typeof escrowChainHooks;

/**
 * Applies the buyer's receipt check (ADR 0014): a match releases the sale, no match holds it for
 * an administrator; an inconclusive result waits for the release date. Run in the transaction
 * that records the result.
 */
export async function receiptChecked(
  tx: Tx,
  transferId: string,
  result: ItemMatchResult,
  at: Date,
): Promise<void> {
  const transfer = await lockEscrow(tx, transferId);
  if (transfer.status !== "ACCEPTED" || transfer.escrowStatus !== "DELIVERED") return;
  if (result === "MATCH") await releaseEscrow(tx, transfer, "receipt_match", at);
  else if (result === "NO_MATCH") await disputeEscrow(tx, transfer, "receipt_no_match", at);
}

/**
 * Applies escrow deadlines that passed: refunds sales not shipped in time, and releases sales
 * RELEASE_AFTER_DAYS after delivery, or after the delivery period without a confirmation or a
 * reported problem. Returns how many escrows changed.
 */
export async function runEscrowDeadlines(
  prisma: PrismaClient,
  at: Date,
  where: Prisma.TransferRequestWhereInput = {},
): Promise<number> {
  const unconfirmedBefore = new Date(at.getTime() - RELEASE_AFTER_DAYS * DAY_MS);
  const due = await prisma.transferRequest.findMany({
    where: {
      ...where,
      status: "ACCEPTED",
      OR: [
        { escrowStatus: "PAID", shipBy: { lte: at } },
        { escrowStatus: "DELIVERED", releaseAt: { lte: at } },
        { escrowStatus: "SHIPPED", deliveryDueAt: { lte: unconfirmedBefore } },
      ],
    },
    select: { id: true },
  });
  let changed = 0;
  for (const { id } of due) {
    await prisma.$transaction(async (tx) => {
      const t = await lockEscrow(tx, id);
      if (t.status !== "ACCEPTED") return;
      if (t.escrowStatus === "PAID" && t.shipBy && t.shipBy <= at) {
        await refundEscrow(tx, t, "not_shipped", at);
      } else if (t.escrowStatus === "DELIVERED" && t.releaseAt && t.releaseAt <= at) {
        await releaseEscrow(tx, t, "release_due", at);
      } else if (
        t.escrowStatus === "SHIPPED" &&
        t.deliveryDueAt &&
        t.deliveryDueAt <= unconfirmedBefore
      ) {
        await releaseEscrow(tx, t, "delivery_unconfirmed", at);
      } else {
        return;
      }
      changed += 1;
    });
  }
  return changed;
}
