import type {
  AssetStatus,
  Prisma,
  PrismaClient,
  TransferRequest,
  TransferStatus,
} from "@worthybound/database";
import {
  ASSET_LIFECYCLE,
  assertTransition,
  TRANSFER_LIFECYCLE,
  type TransferActor,
} from "@worthybound/shared";
import {
  TransferSignatureError,
  type TransferSignatureProblem,
  transferSignature,
  type WorthyBoundOracle,
} from "@worthybound/solana";
import type { TransferRequestInput, TransferSignatureInput } from "@worthybound/validation";
import type { FastifyBaseLogger } from "fastify";
import type { Actor } from "../assets/service.js";
import { writeAudit } from "../audit.js";
import { MAX_CHAIN_ATTEMPTS, TOKENIZABLE_STATUSES } from "../chain/sync.js";
import { ApiError, fromDomainError, notFound } from "../errors.js";
import { recordTrust } from "../trust/record.js";
import { closeRequestsAsSystem } from "../verification/requests.js";
import { transferInclude, type TransferRecord } from "./view.js";

type Tx = Prisma.TransactionClient;

export const OPEN_TRANSFER_STATUSES: readonly TransferStatus[] = ["PENDING", "ACCEPTED"];

export const transferJobKey = (transferId: string) => `transfer-asset:${transferId}`;

const SIGNATURE_PROBLEMS: Record<TransferSignatureProblem, string> = {
  invalid_transaction: "The wallet did not return a valid transaction",
  transaction_changed: "The wallet changed the transaction; sign it without changes",
  not_a_signer: "This wallet is not a party to the transfer",
  missing_signature: "The transaction is not signed by your wallet",
  invalid_signature: "The signature does not match the transaction",
};

/** Both parties have signed: the transaction is with the chain worker. */
const bothSigned = (t: Pick<TransferRequest, "sellerSignature" | "buyerSignature">) =>
  t.sellerSignature !== null && t.buyerSignature !== null;

const lockAsset = (tx: Tx, assetId: string) =>
  tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${assetId}::uuid FOR UPDATE`;

/**
 * Ends an open transfer without a transfer. With `restore`, an asset still TRANSFER_PENDING
 * returns to the status it had when the transfer started. Run after locking the asset.
 */
async function closeTransfer(
  tx: Tx,
  transfer: TransferRequest,
  to: Extract<TransferStatus, "REJECTED" | "CANCELLED" | "EXPIRED">,
  by: { actor: TransferActor; userId: string | null; fp: Actor["fp"] | null },
  reason: string,
  at: Date,
  restore: boolean,
): Promise<void> {
  try {
    assertTransition(TRANSFER_LIFECYCLE, transfer.status, to, by.actor);
  } catch (error) {
    throw fromDomainError(error);
  }
  await tx.transferRequest.update({
    where: { id: transfer.id },
    data: { status: to, closedReason: reason, cancelledAt: at, updatedAt: at },
  });
  await writeAudit(
    tx,
    {
      actorId: by.userId,
      action: "transfer.status_changed",
      targetType: "transfer_request",
      targetId: transfer.id,
      metadata: { fromStatus: transfer.status, toStatus: to, reason },
    },
    by.fp,
  );
  const asset = await tx.asset.findUniqueOrThrow({
    where: { id: transfer.assetId },
    select: { status: true },
  });
  if (!restore || asset.status !== "TRANSFER_PENDING" || !transfer.statusBefore) return;
  const back: AssetStatus = transfer.statusBefore;
  assertTransition(ASSET_LIFECYCLE, "TRANSFER_PENDING", back, "SYSTEM");
  await tx.asset.update({ where: { id: transfer.assetId }, data: { status: back, updatedAt: at } });
  await tx.assetStatusEvent.create({
    data: {
      assetId: transfer.assetId,
      fromStatus: "TRANSFER_PENDING",
      toStatus: back,
      reason: `transfer_${to.toLowerCase()}`,
      actorId: null,
      createdAt: at,
    },
  });
  await tx.provenanceEvent.create({
    data: {
      assetId: transfer.assetId,
      type: "STATUS_CHANGED",
      actorId: null,
      occurredAt: at,
      payload: { fromStatus: "TRANSFER_PENDING", toStatus: back },
    },
  });
  await recordTrust(tx, transfer.assetId, at);
}

/**
 * Cancels the asset's open transfer as the system, e.g. when the owner reports the item lost or
 * stolen. The asset keeps its new status. Run after locking the asset.
 */
export async function cancelOpenTransfer(
  tx: Tx,
  assetId: string,
  reason: string,
  at: Date,
): Promise<void> {
  const open = await tx.transferRequest.findFirst({
    where: { assetId, status: { in: [...OPEN_TRANSFER_STATUSES] } },
  });
  if (open) {
    await closeTransfer(
      tx,
      open,
      "CANCELLED",
      { actor: "SYSTEM", userId: null, fp: null },
      reason,
      at,
      false,
    );
  }
}

/**
 * Records a transfer confirmed on-chain: the buyer becomes the owner, a new custody period
 * starts (ADR 0002), the asset returns to the status it had before the transfer, and the seller's
 * open verification requests are cancelled. Called by the chain worker in its transaction.
 */
export async function completeTransfer(
  tx: Tx,
  transferId: string,
  signature: string,
  at: Date,
): Promise<void> {
  const found = await tx.transferRequest.findUniqueOrThrow({
    where: { id: transferId },
    select: { assetId: true },
  });
  await lockAsset(tx, found.assetId);
  const transfer = await tx.transferRequest.findUniqueOrThrow({ where: { id: transferId } });
  if (transfer.status !== "ACCEPTED" || !transfer.toUserId || !transfer.statusBefore) {
    throw new Error(`transfer ${transferId} confirmed on-chain while ${transfer.status}`);
  }
  const after = transfer.statusBefore;
  assertTransition(TRANSFER_LIFECYCLE, "ACCEPTED", "COMPLETED", "SYSTEM");
  assertTransition(ASSET_LIFECYCLE, "TRANSFER_PENDING", after, "SYSTEM");
  await tx.transferRequest.update({
    where: { id: transferId },
    data: { status: "COMPLETED", completedAt: at, updatedAt: at },
  });
  await tx.ownership.updateMany({
    where: { assetId: transfer.assetId, endedAt: null },
    data: { endedAt: at },
  });
  await tx.ownership.create({
    data: {
      assetId: transfer.assetId,
      ownerId: transfer.toUserId,
      reason: "TRANSFER",
      transferRequestId: transferId,
      startedAt: at,
    },
  });
  await tx.asset.update({
    where: { id: transfer.assetId },
    data: { ownerId: transfer.toUserId, status: after, updatedAt: at },
  });
  await tx.assetStatusEvent.create({
    data: {
      assetId: transfer.assetId,
      fromStatus: "TRANSFER_PENDING",
      toStatus: after,
      reason: "transfer_completed",
      actorId: null,
      createdAt: at,
    },
  });
  await tx.provenanceEvent.create({
    data: {
      assetId: transfer.assetId,
      type: "TRANSFER_COMPLETED",
      actorId: null,
      occurredAt: at,
      payload: { cluster: "devnet", signature },
    },
  });
  await closeRequestsAsSystem(
    tx,
    { assetId: transfer.assetId },
    "CANCELLED",
    "ownership_changed",
    at,
  );
  await writeAudit(
    tx,
    {
      actorId: null,
      action: "transfer.completed",
      targetType: "transfer_request",
      targetId: transferId,
      metadata: { signature },
    },
    null,
  );
  await recordTrust(tx, transfer.assetId, at);
}

export interface TransferServiceOptions {
  prisma: PrismaClient;
  now: () => Date;
  /** Null without an oracle key; transfers are then unavailable. */
  oracle: WorthyBoundOracle | null;
  log: FastifyBaseLogger;
}

/** Controlled transfers (ADR 0002): the seller starts, the KYC'd buyer accepts, both sign. */
export function createTransferService({ prisma, now, oracle, log }: TransferServiceOptions) {
  const load = (id: string) =>
    prisma.transferRequest.findUnique({ where: { id }, include: transferInclude });

  /** The transfer if the user is its sender or recipient; otherwise 404, as for unknown IDs. */
  async function forParty(id: string, actor: Actor): Promise<TransferRecord> {
    await expireDue({ id });
    const transfer = await load(id);
    if (!transfer || (transfer.fromUserId !== actor.userId && transfer.toUserId !== actor.userId)) {
      throw notFound("Transfer");
    }
    return transfer;
  }

  /** Locks the transfer's asset and returns the transfer as it is now. */
  async function lockTransfer(tx: Tx, id: string): Promise<TransferRequest> {
    const found = await tx.transferRequest.findUniqueOrThrow({
      where: { id },
      select: { assetId: true },
    });
    await lockAsset(tx, found.assetId);
    return tx.transferRequest.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Expires open transfers past their expiry that are not yet with the chain worker. Runs when
   * transfers are read or acted on; there is no scheduler yet.
   */
  async function expireDue(where: Prisma.TransferRequestWhereInput): Promise<void> {
    const at = now();
    const due = await prisma.transferRequest.findMany({
      where: {
        ...where,
        status: { in: [...OPEN_TRANSFER_STATUSES] },
        expiresAt: { lte: at },
        OR: [{ sellerSignature: null }, { buyerSignature: null }],
      },
      select: { id: true },
    });
    for (const { id } of due) {
      await prisma.$transaction(async (tx) => {
        const transfer = await lockTransfer(tx, id);
        if (!OPEN_TRANSFER_STATUSES.includes(transfer.status) || bothSigned(transfer)) return;
        const system = { actor: "SYSTEM" as const, userId: null, fp: null };
        await closeTransfer(tx, transfer, "EXPIRED", system, "expired", at, true);
      });
    }
  }

  async function jobsFor(ids: string[]) {
    const jobs = await prisma.chainTransaction.findMany({
      where: { entityType: "TRANSFER_REQUEST", entityId: { in: ids }, kind: "TRANSFER_ASSET" },
      select: { entityId: true, status: true, attempts: true, signature: true },
    });
    return new Map(jobs.map((j) => [j.entityId, j]));
  }

  const withJob = async (transfer: TransferRecord) => ({
    transfer,
    job: (await jobsFor([transfer.id])).get(transfer.id) ?? null,
  });

  return {
    async list(actor: Actor) {
      await expireDue({ OR: [{ fromUserId: actor.userId }, { toUserId: actor.userId }] });
      const transfers = await prisma.transferRequest.findMany({
        where: { OR: [{ fromUserId: actor.userId }, { toUserId: actor.userId }] },
        include: transferInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
      });
      const jobs = await jobsFor(transfers.map((t) => t.id));
      return transfers.map((transfer) => ({ transfer, job: jobs.get(transfer.id) ?? null }));
    },

    async get(id: string, actor: Actor) {
      return withJob(await forParty(id, actor));
    },

    /**
     * Starts a transfer to a signed-in wallet with a verified identity. The asset must be
     * tokenized and active, verified or awaiting reverification; it becomes TRANSFER_PENDING.
     */
    async start(input: TransferRequestInput, actor: Actor) {
      if (!oracle) {
        throw new ApiError(503, "transfers_unavailable", "Transfers are not available right now");
      }
      await expireDue({ asset: { wbId: input.assetId } });
      const at = now();
      const id = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${input.assetId} FOR UPDATE`;
        const asset = await tx.asset.findUnique({ where: { wbId: input.assetId } });
        if (!asset || asset.ownerId !== actor.userId || asset.publishedAt === null) {
          throw notFound("Asset");
        }
        const open = await tx.transferRequest.count({
          where: { assetId: asset.id, status: { in: [...OPEN_TRANSFER_STATUSES] } },
        });
        if (open > 0) {
          throw new ApiError(409, "transfer_open", "This asset already has an open transfer");
        }
        if (
          asset.tokenizationStatus !== "TOKENIZED" ||
          !TOKENIZABLE_STATUSES.includes(asset.status)
        ) {
          throw new ApiError(
            409,
            "not_transferable",
            "Only tokenized assets that are active, verified or awaiting reverification can be transferred",
          );
        }
        const recipient = await tx.user.findUnique({
          where: { walletAddress: input.toWalletAddress },
          select: { id: true, identityStatus: true },
        });
        if (!recipient) {
          throw new ApiError(
            422,
            "recipient_not_found",
            "The recipient must sign in to WorthyBound with this wallet first",
          );
        }
        if (recipient.id === actor.userId) {
          throw new ApiError(422, "same_owner", "You already own this asset");
        }
        if (recipient.identityStatus !== "VERIFIED") {
          throw new ApiError(
            422,
            "recipient_identity_not_verified",
            "The recipient must verify their identity before receiving an asset",
          );
        }
        try {
          assertTransition(ASSET_LIFECYCLE, asset.status, "TRANSFER_PENDING", "OWNER");
        } catch (error) {
          throw fromDomainError(error);
        }
        const transfer = await tx.transferRequest.create({
          data: {
            assetId: asset.id,
            fromUserId: actor.userId,
            toUserId: recipient.id,
            toWalletAddress: input.toWalletAddress,
            statusBefore: asset.status,
            expiresAt: new Date(at.getTime() + input.expiresInHours * 60 * 60_000),
            createdAt: at,
          },
        });
        await tx.asset.update({
          where: { id: asset.id },
          data: { status: "TRANSFER_PENDING", updatedAt: at },
        });
        await tx.assetStatusEvent.create({
          data: {
            assetId: asset.id,
            fromStatus: asset.status,
            toStatus: "TRANSFER_PENDING",
            reason: "transfer_requested",
            actorId: actor.userId,
            createdAt: at,
          },
        });
        await tx.provenanceEvent.create({
          data: {
            assetId: asset.id,
            type: "TRANSFER_REQUESTED",
            actorId: actor.userId,
            occurredAt: at,
            payload: { fromStatus: asset.status },
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "transfer.requested",
            targetType: "transfer_request",
            targetId: transfer.id,
            metadata: { wbId: asset.wbId, recipientId: recipient.id },
          },
          actor.fp,
        );
        await recordTrust(tx, asset.id, at);
        return transfer.id;
      });
      return withJob((await load(id)) as TransferRecord);
    },

    /**
     * The recipient accepts. Prepares the transaction both parties sign: a durable nonce account
     * is created on-chain first, so this can fail with 503 and be retried.
     */
    async accept(id: string, actor: Actor) {
      const transfer = await forParty(id, actor);
      if (transfer.toUserId !== actor.userId) throw notFound("Transfer");
      if (transfer.status === "ACCEPTED") return withJob(transfer);
      if (!oracle) {
        throw new ApiError(503, "transfers_unavailable", "Transfers are not available right now");
      }
      if (transfer.status !== "PENDING" || !transfer.statusBefore || !transfer.toUser) {
        throw new ApiError(409, "invalid_transition", "This transfer can no longer be accepted");
      }
      const statusSeq =
        (await prisma.assetStatusEvent.count({ where: { assetId: transfer.assetId } })) + 1;
      let prepared: { transaction: string; nonceAccount: string };
      try {
        prepared = await oracle.prepareTransfer({
          wbId: transfer.asset.wbId,
          seller: transfer.fromUser.walletAddress,
          buyer: transfer.toUser.walletAddress,
          statusAfter: transfer.statusBefore,
          statusSeq: BigInt(statusSeq),
        });
      } catch (error) {
        log.warn(
          { transferId: id, err: String((error as Error)?.message ?? error) },
          "transfer preparation failed",
        );
        throw new ApiError(
          503,
          "chain_unavailable",
          "Solana is not reachable right now; try again",
        );
      }
      const at = now();
      await prisma.$transaction(async (tx) => {
        const current = await lockTransfer(tx, id);
        const events = await tx.assetStatusEvent.count({ where: { assetId: current.assetId } });
        if (current.status !== "PENDING" || events + 1 !== statusSeq) {
          throw new ApiError(409, "transfer_changed", "The transfer changed; reload and try again");
        }
        try {
          assertTransition(TRANSFER_LIFECYCLE, "PENDING", "ACCEPTED", "RECIPIENT");
        } catch (error) {
          throw fromDomainError(error);
        }
        await tx.transferRequest.update({
          where: { id },
          data: {
            status: "ACCEPTED",
            acceptedAt: at,
            transaction: prepared.transaction,
            nonceAccount: prepared.nonceAccount,
            statusSeq,
            updatedAt: at,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "transfer.accepted",
            targetType: "transfer_request",
            targetId: id,
            metadata: { nonceAccount: prepared.nonceAccount },
          },
          actor.fp,
        );
      });
      return withJob((await load(id)) as TransferRecord);
    },

    async reject(id: string, actor: Actor) {
      const transfer = await forParty(id, actor);
      if (transfer.toUserId !== actor.userId) throw notFound("Transfer");
      await prisma.$transaction(async (tx) => {
        const current = await lockTransfer(tx, id);
        const by = { actor: "RECIPIENT" as const, userId: actor.userId, fp: actor.fp };
        await closeTransfer(tx, current, "REJECTED", by, "rejected", now(), true);
      });
      return withJob((await load(id)) as TransferRecord);
    },

    /**
     * The sender cancels before completion, the recipient after accepting. Not while the signed
     * transaction is with the chain worker, unless it gave up.
     */
    async cancel(id: string, actor: Actor) {
      const transfer = await forParty(id, actor);
      const role: TransferActor = transfer.fromUserId === actor.userId ? "SENDER" : "RECIPIENT";
      await prisma.$transaction(async (tx) => {
        const current = await lockTransfer(tx, id);
        if (bothSigned(current)) {
          const job = await tx.chainTransaction.findUnique({
            where: { idempotencyKey: transferJobKey(id) },
            select: { status: true, attempts: true },
          });
          if (job && !(job.status === "FAILED" && job.attempts >= MAX_CHAIN_ATTEMPTS)) {
            throw new ApiError(
              409,
              "transfer_in_progress",
              "Both parties have signed; the transfer is being completed on Solana",
            );
          }
        }
        const by = { actor: role, userId: actor.userId, fp: actor.fp };
        await closeTransfer(
          tx,
          current,
          "CANCELLED",
          by,
          `cancelled_by_${role.toLowerCase()}`,
          now(),
          true,
        );
      });
      return withJob((await load(id)) as TransferRecord);
    },

    /**
     * Stores the party's signature of the prepared transaction. Once both have signed, the
     * chain worker adds the oracle's signature and sends it.
     */
    async sign(id: string, input: TransferSignatureInput, actor: Actor) {
      const transfer = await forParty(id, actor);
      const seller = transfer.fromUserId === actor.userId;
      if (transfer.status !== "ACCEPTED" || !transfer.transaction || !transfer.toUser) {
        throw new ApiError(409, "not_ready_to_sign", "This transfer is not waiting for signatures");
      }
      if ((seller ? transfer.sellerSignature : transfer.buyerSignature) !== null) {
        return { ...(await withJob(transfer)), queued: false };
      }
      const wallet = seller ? transfer.fromUser.walletAddress : transfer.toUser.walletAddress;
      let signature: string;
      try {
        signature = await transferSignature(transfer.transaction, input.signedTransaction, wallet);
      } catch (error) {
        if (error instanceof TransferSignatureError) {
          throw new ApiError(422, "invalid_signature", SIGNATURE_PROBLEMS[error.problem]);
        }
        throw error;
      }
      const at = now();
      let queued = false;
      await prisma.$transaction(async (tx) => {
        const current = await lockTransfer(tx, id);
        if (current.status !== "ACCEPTED" || current.transaction !== transfer.transaction) {
          throw new ApiError(409, "transfer_changed", "The transfer changed; reload and try again");
        }
        const updated = await tx.transferRequest.update({
          where: { id },
          data: seller
            ? { sellerSignature: signature, updatedAt: at }
            : { buyerSignature: signature, updatedAt: at },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "transfer.signed",
            targetType: "transfer_request",
            targetId: id,
            metadata: { role: seller ? "SELLER" : "BUYER" },
          },
          actor.fp,
        );
        if (!bothSigned(updated)) return;
        await tx.chainTransaction.create({
          data: {
            idempotencyKey: transferJobKey(id),
            kind: "TRANSFER_ASSET",
            cluster: "DEVNET",
            entityType: "TRANSFER_REQUEST",
            entityId: id,
          },
        });
        queued = true;
      });
      return { ...(await withJob((await load(id)) as TransferRecord)), queued };
    },
  };
}

export type TransferService = ReturnType<typeof createTransferService>;
