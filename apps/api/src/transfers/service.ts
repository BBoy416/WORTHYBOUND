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
  CAPTURE_SESSION_MINUTES,
  DELIVERY_EXTENSION_DAYS,
  DELIVERY_WITHIN_DAYS,
  MAX_DELIVERY_EXTENSIONS,
  RECEIPT_CHECK_HOURS,
  RELEASE_AFTER_DAYS,
  receiptShots,
  shipmentShots,
  TRANSFER_LIFECYCLE,
  type TransferActor,
} from "@worthybound/shared";
import {
  TransferSignatureError,
  type TransferSignatureProblem,
  transferSignature,
  type WorthyBoundOracle,
} from "@worthybound/solana";
import type {
  EscrowDisputeInput,
  ResolveEscrowInput,
  ShipmentInput,
  TransferRequestInput,
  TransferSignatureInput,
} from "@worthybound/validation";
import type { FastifyBaseLogger } from "fastify";
import type { Actor } from "../assets/service.js";
import { writeAudit } from "../audit.js";
import { captureCode, withEvidence } from "../capture/service.js";
import type { SessionRecord } from "../capture/view.js";
import { MAX_CHAIN_ATTEMPTS, TOKENIZABLE_STATUSES } from "../chain/sync.js";
import { ApiError, fromDomainError, notFound } from "../errors.js";
import { recordTrust } from "../trust/record.js";
import { closeRequestsAsSystem } from "../verification/requests.js";
import {
  disputeEscrow,
  escrowPaymentJobKey,
  lockEscrow,
  refundEscrow,
  releaseEscrow,
  runEscrowDeadlines,
} from "./escrow.js";
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

const DAY_MS = 24 * 60 * 60_000;

/** Both parties have signed: for in-person transfers, the transaction is with the chain worker. */
const bothSigned = (t: Pick<TransferRequest, "sellerSignature" | "buyerSignature">) =>
  t.sellerSignature !== null && t.buyerSignature !== null;

export const lockAsset = (tx: Tx, assetId: string) =>
  tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${assetId}::uuid FOR UPDATE`;

/**
 * Ends an open transfer without a transfer. With `restore`, an asset still TRANSFER_PENDING
 * returns to the status it had when the transfer started. Run after locking the asset.
 */
export async function closeTransfer(
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
  // A paid escrow is refunded before shipping; once shipped, an administrator decides.
  if (open?.escrowStatus === "PAID") return refundEscrow(tx, open, reason, at);
  if (open?.escrowStatus === "SHIPPED" || open?.escrowStatus === "DELIVERED") {
    return disputeEscrow(tx, open, reason, at);
  }
  if (open && open.escrowStatus !== null && open.escrowStatus !== "AWAITING_PAYMENT") return;
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
    data: {
      status: "COMPLETED",
      completedAt: at,
      updatedAt: at,
      ...(transfer.delivery === "SHIPPED" ? { escrowStatus: "RELEASED" as const } : {}),
    },
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

  /** Not yet with the chain worker: unsigned, or for escrow not yet paid. */
  const expirable = (t: TransferRequest) =>
    t.delivery === "SHIPPED"
      ? t.paymentSignature === null &&
        (t.escrowStatus === null || t.escrowStatus === "AWAITING_PAYMENT")
      : !bothSigned(t);

  /**
   * Expires open transfers past their expiry that are not yet with the chain worker, and applies
   * escrow deadlines. Runs when transfers are read or acted on, and with the chain worker.
   */
  async function expireDue(where: Prisma.TransferRequestWhereInput): Promise<void> {
    const at = now();
    await runEscrowDeadlines(prisma, at, where);
    const due = await prisma.transferRequest.findMany({
      where: {
        ...where,
        status: { in: [...OPEN_TRANSFER_STATUSES] },
        expiresAt: { lte: at },
        OR: [
          { delivery: "IN_PERSON", OR: [{ sellerSignature: null }, { buyerSignature: null }] },
          {
            delivery: "SHIPPED",
            paymentSignature: null,
            OR: [{ escrowStatus: null }, { escrowStatus: "AWAITING_PAYMENT" }],
          },
        ],
      },
      select: { id: true },
    });
    for (const { id } of due) {
      await prisma.$transaction(async (tx) => {
        const transfer = await lockTransfer(tx, id);
        if (!OPEN_TRANSFER_STATUSES.includes(transfer.status) || !expirable(transfer)) return;
        const system = { actor: "SYSTEM" as const, userId: null, fp: null };
        await closeTransfer(tx, transfer, "EXPIRED", system, "expired", at, true);
      });
    }
  }

  async function jobsFor(ids: string[]) {
    const jobs = await prisma.chainTransaction.findMany({
      where: {
        entityType: "TRANSFER_REQUEST",
        entityId: { in: ids },
        kind: { in: ["TRANSFER_ASSET", "ESCROW_PAYMENT", "ESCROW_REFUND"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { entityId: true, kind: true, status: true, attempts: true, signature: true },
    });
    const latest = (id: string, kind: (typeof jobs)[number]["kind"]) =>
      jobs.filter((j) => j.entityId === id && j.kind === kind).at(-1) ?? null;
    return new Map(
      ids.map((id) => [
        id,
        {
          job: latest(id, "TRANSFER_ASSET"),
          payment: latest(id, "ESCROW_PAYMENT"),
          refund: latest(id, "ESCROW_REFUND"),
        },
      ]),
    );
  }

  const withJob = async (transfer: TransferRecord) => ({
    transfer,
    ...(await jobsFor([transfer.id])).get(transfer.id)!,
  });

  /** Unfinished, or failed with retries left. */
  const inFlight = (job: { status: string; attempts: number } | null) =>
    job !== null &&
    job.status !== "CONFIRMED" &&
    job.status !== "SUPERSEDED" &&
    !(job.status === "FAILED" && job.attempts >= MAX_CHAIN_ATTEMPTS);

  const unavailable = () =>
    new ApiError(503, "transfers_unavailable", "Transfers are not available right now");
  const chainUnavailable = (id: string, what: string, error: unknown) => {
    log.warn({ transferId: id, err: String((error as Error)?.message ?? error) }, what);
    return new ApiError(503, "chain_unavailable", "Solana is not reachable right now; try again");
  };

  /** The shipped transfer if the caller is the given party; 404 otherwise. */
  async function escrowFor(id: string, actor: Actor, party: "SELLER" | "BUYER") {
    const transfer = await forParty(id, actor);
    const userId = party === "SELLER" ? transfer.fromUserId : transfer.toUserId;
    if (userId !== actor.userId) throw notFound("Transfer");
    if (transfer.delivery !== "SHIPPED") {
      throw new ApiError(409, "not_shipped_transfer", "This transfer is handed over in person");
    }
    return transfer;
  }

  const escrowState = (message: string) => new ApiError(409, "escrow_state", message);

  /** Locks a shipped transfer and checks it is still open in one of `states`. */
  async function lockOpenEscrow(tx: Tx, id: string, states: TransferRequest["escrowStatus"][]) {
    const current = await lockEscrow(tx, id);
    if (current.status !== "ACCEPTED" || !states.includes(current.escrowStatus)) {
      throw new ApiError(409, "transfer_changed", "The transfer changed; reload and try again");
    }
    return current;
  }

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
      return transfers.map((transfer) => ({ transfer, ...jobs.get(transfer.id)! }));
    },

    async get(id: string, actor: Actor) {
      return withJob(await forParty(id, actor));
    },

    /**
     * Starts a transfer to a signed-in wallet with a verified identity. The asset must be
     * tokenized and active, verified or awaiting reverification; it becomes TRANSFER_PENDING.
     */
    async start(input: TransferRequestInput, actor: Actor) {
      if (!oracle) throw unavailable();
      if (input.delivery === "SHIPPED" && BigInt(input.priceLamports) === 0n) {
        throw new ApiError(
          422,
          "escrow_needs_price",
          "A shipped item is paid into escrow; set a price",
        );
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
            priceLamports: BigInt(input.priceLamports),
            delivery: input.delivery,
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
            metadata: {
              wbId: asset.wbId,
              recipientId: recipient.id,
              priceLamports: input.priceLamports,
              delivery: input.delivery,
            },
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
      if (!oracle) throw unavailable();
      if (transfer.status !== "PENDING" || !transfer.statusBefore || !transfer.toUser) {
        throw new ApiError(409, "invalid_transition", "This transfer can no longer be accepted");
      }
      const statusSeq =
        (await prisma.assetStatusEvent.count({ where: { assetId: transfer.assetId } })) + 1;
      const shipped = transfer.delivery === "SHIPPED";
      let prepared: {
        transaction: string;
        nonceAccount: string;
        paymentNonceAccount: string | null;
      };
      let paymentTransaction: string | null = null;
      try {
        prepared = await oracle.prepareTransfer({
          wbId: transfer.asset.wbId,
          seller: transfer.fromUser.walletAddress,
          buyer: transfer.toUser.walletAddress,
          statusAfter: transfer.statusBefore,
          statusSeq: BigInt(statusSeq),
          priceLamports: transfer.priceLamports,
          escrow: shipped,
        });
        if (shipped) {
          if (!prepared.paymentNonceAccount) throw new Error("no payment nonce account");
          paymentTransaction = await oracle.prepareEscrowPayment({
            buyer: transfer.toUser.walletAddress,
            escrowAccount: prepared.nonceAccount,
            paymentNonceAccount: prepared.paymentNonceAccount,
            priceLamports: transfer.priceLamports,
          });
        }
      } catch (error) {
        throw chainUnavailable(id, "transfer preparation failed", error);
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
            ...(shipped
              ? {
                  escrowStatus: "AWAITING_PAYMENT" as const,
                  paymentNonceAccount: prepared.paymentNonceAccount,
                  paymentTransaction,
                }
              : {}),
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "transfer.accepted",
            targetType: "transfer_request",
            targetId: id,
            metadata: {
              nonceAccount: prepared.nonceAccount,
              ...(shipped ? { paymentNonceAccount: prepared.paymentNonceAccount } : {}),
            },
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
     * transaction is with the chain worker, unless it gave up. In escrow, a paid sale is refunded
     * instead: the seller can cancel until they ship, the buyer once the delivery period passed.
     */
    async cancel(id: string, actor: Actor) {
      const transfer = await forParty(id, actor);
      const role: TransferActor = transfer.fromUserId === actor.userId ? "SENDER" : "RECIPIENT";
      const at = now();
      await prisma.$transaction(async (tx) => {
        const current = await lockTransfer(tx, id);
        const escrow = current.escrowStatus;
        if (current.status === "ACCEPTED" && escrow !== null && escrow !== "AWAITING_PAYMENT") {
          if (escrow === "PAID" && role === "SENDER") {
            return refundEscrow(tx, current, "cancelled_by_sender", at, actor);
          }
          if (
            escrow === "SHIPPED" &&
            role === "RECIPIENT" &&
            current.deliveryDueAt &&
            current.deliveryDueAt <= at
          ) {
            return refundEscrow(tx, current, "delivery_overdue", at, actor);
          }
          throw escrowState(
            escrow === "PAID"
              ? "The seller has until the shipping date to ship; you are refunded if they do not"
              : escrow === "SHIPPED"
                ? role === "SENDER"
                  ? "The item was shipped; the buyer can report a problem if it does not arrive"
                  : "You can cancel once the delivery period has passed, or extend it"
                : "The payment is held in escrow; the sale can no longer be cancelled",
          );
        }
        if (current.paymentSignature !== null && escrow === "AWAITING_PAYMENT") {
          const payment = await tx.chainTransaction.findFirst({
            where: { entityId: id, kind: "ESCROW_PAYMENT" },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { status: true, attempts: true },
          });
          if (inFlight(payment)) {
            throw new ApiError(
              409,
              "payment_in_progress",
              "The payment is being sent to escrow on Solana",
            );
          }
        }
        if (current.delivery === "IN_PERSON" && bothSigned(current)) {
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
          at,
          true,
        );
      });
      return withJob((await load(id)) as TransferRecord);
    },

    /**
     * The buyer's signature of the payment into escrow, once both parties signed the transfer.
     * The chain worker adds the oracle's signature and sends it.
     */
    async pay(id: string, input: TransferSignatureInput, actor: Actor) {
      const transfer = await escrowFor(id, actor, "BUYER");
      if (
        transfer.status !== "ACCEPTED" ||
        transfer.escrowStatus !== "AWAITING_PAYMENT" ||
        !transfer.paymentTransaction ||
        !transfer.toUser
      ) {
        throw escrowState("This transfer is not waiting for a payment");
      }
      if (transfer.paymentSignature !== null) {
        return { ...(await withJob(transfer)), queued: false };
      }
      if (!bothSigned(transfer)) {
        throw new ApiError(
          409,
          "transfer_not_signed",
          "Both parties sign the transfer before the payment",
        );
      }
      const wallet = transfer.toUser.walletAddress;
      let signature: string;
      try {
        signature = await transferSignature(
          transfer.paymentTransaction,
          input.signedTransaction,
          wallet,
        );
      } catch (error) {
        if (error instanceof TransferSignatureError) {
          throw new ApiError(422, "invalid_signature", SIGNATURE_PROBLEMS[error.problem]);
        }
        throw error;
      }
      let balance: bigint;
      try {
        if (!oracle) throw new Error("no oracle");
        balance = await oracle.getBalance(wallet);
      } catch (error) {
        throw chainUnavailable(id, "buyer balance check failed", error);
      }
      if (balance < transfer.priceLamports) {
        throw new ApiError(
          422,
          "insufficient_funds",
          "Your wallet does not hold enough SOL to pay the price",
        );
      }
      const at = now();
      await prisma.$transaction(async (tx) => {
        const current = await lockOpenEscrow(tx, id, ["AWAITING_PAYMENT"]);
        if (
          current.paymentTransaction !== transfer.paymentTransaction ||
          current.paymentSignature !== null
        ) {
          throw new ApiError(409, "transfer_changed", "The transfer changed; reload and try again");
        }
        await tx.transferRequest.update({
          where: { id },
          data: { paymentSignature: signature, updatedAt: at },
        });
        const attempt = await tx.chainTransaction.count({
          where: { entityId: id, kind: "ESCROW_PAYMENT" },
        });
        await tx.chainTransaction.create({
          data: {
            idempotencyKey: escrowPaymentJobKey(id, attempt + 1),
            kind: "ESCROW_PAYMENT",
            cluster: "DEVNET",
            entityType: "TRANSFER_REQUEST",
            entityId: id,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "transfer.escrow_payment_signed",
            targetType: "transfer_request",
            targetId: id,
            metadata: { priceLamports: transfer.priceLamports.toString() },
          },
          actor.fp,
        );
      });
      return { ...(await withJob((await load(id)) as TransferRecord)), queued: true };
    },

    /**
     * Starts the capture session in which the seller films the item and the sealed package with
     * the session's code before shipping, or returns the open one.
     */
    /** The seller's latest capture session before shipping; 404 until one was started. */
    async shipmentSession(id: string, actor: Actor): Promise<SessionRecord> {
      await escrowFor(id, actor, "SELLER");
      const at = now();
      await prisma.captureSession.updateMany({
        where: { transferRequestId: id, status: "OPEN", expiresAt: { lte: at } },
        data: { status: "EXPIRED", updatedAt: at },
      });
      const session = await prisma.captureSession.findFirst({
        where: { transferRequestId: id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: withEvidence,
      });
      if (!session) throw notFound("Capture session");
      return session;
    },

    async startShipmentSession(
      id: string,
      actor: Actor,
    ): Promise<{ session: SessionRecord; created: boolean }> {
      await escrowFor(id, actor, "SELLER");
      const at = now();
      return prisma.$transaction(async (tx) => {
        const current = await lockOpenEscrow(tx, id, ["PAID"]);
        if (!current.shipBy || current.shipBy <= at) throw escrowState("The shipping date passed");
        const asset = await tx.asset.findUniqueOrThrow({ where: { id: current.assetId } });
        if (asset.ownerId !== actor.userId) throw notFound("Transfer");
        await tx.captureSession.updateMany({
          where: { assetId: asset.id, status: "OPEN", expiresAt: { lte: at } },
          data: { status: "EXPIRED", updatedAt: at },
        });
        const open = await tx.captureSession.findFirst({
          where: { transferRequestId: id, status: "OPEN" },
          include: withEvidence,
        });
        if (open) return { session: open, created: false };
        const session = await tx.captureSession.create({
          data: {
            assetId: asset.id,
            ownerId: actor.userId,
            transferRequestId: id,
            code: captureCode(),
            shots: shipmentShots(asset.category),
            expiresAt: new Date(
              Math.min(at.getTime() + CAPTURE_SESSION_MINUTES * 60_000, current.shipBy.getTime()),
            ),
            createdAt: at,
          },
          include: withEvidence,
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "capture.started",
            targetType: "asset",
            targetId: asset.wbId,
            metadata: { captureSessionId: session.id, transferRequestId: id, shots: session.shots },
          },
          actor.fp,
        );
        return { session, created: true };
      });
    },

    /**
     * The seller shipped the filmed, sealed package. The buyer then has DELIVERY_WITHIN_DAYS to
     * confirm delivery.
     */
    async ship(id: string, input: ShipmentInput, actor: Actor) {
      await escrowFor(id, actor, "SELLER");
      const at = now();
      await prisma.$transaction(async (tx) => {
        const current = await lockOpenEscrow(tx, id, ["PAID"]);
        if (!current.shipBy || current.shipBy <= at) throw escrowState("The shipping date passed");
        const filmed = await tx.captureSession.count({
          where: { transferRequestId: id, status: "COMPLETED" },
        });
        if (filmed === 0) {
          throw new ApiError(
            409,
            "shipment_not_filmed",
            "Film the item and the sealed package with the code before shipping",
          );
        }
        await tx.transferRequest.update({
          where: { id },
          data: {
            escrowStatus: "SHIPPED",
            shippedAt: at,
            carrier: input.carrier,
            trackingNumber: input.trackingNumber,
            deliveryDueAt: new Date(at.getTime() + DELIVERY_WITHIN_DAYS * DAY_MS),
            updatedAt: at,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "transfer.shipped",
            targetType: "transfer_request",
            targetId: id,
            metadata: { carrier: input.carrier },
          },
          actor.fp,
        );
      });
      return withJob((await load(id)) as TransferRecord);
    },

    /**
     * The buyer received the package. Starts the receipt check, in which the buyer photographs
     * the package and the item within RECEIPT_CHECK_HOURS; the sale is released after
     * RELEASE_AFTER_DAYS unless the buyer reports a problem.
     */
    async delivered(id: string, actor: Actor) {
      await escrowFor(id, actor, "BUYER");
      const at = now();
      await prisma.$transaction(async (tx) => {
        const current = await lockOpenEscrow(tx, id, ["SHIPPED"]);
        const [asset, session] = await Promise.all([
          tx.asset.findUniqueOrThrow({ where: { id: current.assetId } }),
          tx.captureSession.findFirstOrThrow({
            where: { transferRequestId: id, status: "COMPLETED" },
            orderBy: [{ completedAt: "desc" }, { id: "desc" }],
          }),
        ]);
        await tx.transferRequest.update({
          where: { id },
          data: {
            escrowStatus: "DELIVERED",
            deliveredAt: at,
            releaseAt: new Date(at.getTime() + RELEASE_AFTER_DAYS * DAY_MS),
            updatedAt: at,
          },
        });
        const expiresAt = new Date(at.getTime() + RECEIPT_CHECK_HOURS * 60 * 60_000);
        const check = await tx.purchaseCheck.create({
          data: {
            assetId: asset.id,
            buyerId: actor.userId,
            kind: "RECEIPT",
            transferRequestId: id,
            // The code the seller wrote on the package.
            ownerCode: session.code,
            ownerCodeExpiresAt: expiresAt,
            shots: receiptShots(asset.category),
            expiresAt,
            createdAt: at,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "transfer.delivered",
            targetType: "transfer_request",
            targetId: id,
            metadata: { purchaseCheckId: check.id },
          },
          actor.fp,
        );
      });
      return withJob((await load(id)) as TransferRecord);
    },

    /** The buyer waits longer for the package, DELIVERY_EXTENSION_DAYS at a time. */
    async extendDelivery(id: string, actor: Actor) {
      await escrowFor(id, actor, "BUYER");
      const at = now();
      await prisma.$transaction(async (tx) => {
        const current = await lockOpenEscrow(tx, id, ["SHIPPED"]);
        if (current.deliveryExtensions >= MAX_DELIVERY_EXTENSIONS || !current.deliveryDueAt) {
          throw new ApiError(
            409,
            "delivery_extension_limit",
            `The delivery period can be extended ${MAX_DELIVERY_EXTENSIONS} times`,
          );
        }
        const from = Math.max(current.deliveryDueAt.getTime(), at.getTime());
        await tx.transferRequest.update({
          where: { id },
          data: {
            deliveryDueAt: new Date(from + DELIVERY_EXTENSION_DAYS * DAY_MS),
            deliveryExtensions: { increment: 1 },
            updatedAt: at,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "transfer.delivery_extended",
            targetType: "transfer_request",
            targetId: id,
            metadata: { extensions: current.deliveryExtensions + 1 },
          },
          actor.fp,
        );
      });
      return withJob((await load(id)) as TransferRecord);
    },

    /** The buyer reports a problem; token and payment stay in escrow for an administrator. */
    async dispute(id: string, input: EscrowDisputeInput, actor: Actor) {
      await escrowFor(id, actor, "BUYER");
      const at = now();
      await prisma.$transaction(async (tx) => {
        const current = await lockOpenEscrow(tx, id, ["SHIPPED", "DELIVERED"]);
        await disputeEscrow(tx, current, input.reason, at, actor);
      });
      return withJob((await load(id)) as TransferRecord);
    },

    /** Escrows held for an administrator, oldest first. */
    async disputes() {
      await runEscrowDeadlines(prisma, now());
      const transfers = await prisma.transferRequest.findMany({
        where: { escrowStatus: "DISPUTED" },
        include: transferInclude,
        orderBy: [{ disputedAt: "asc" }, { id: "asc" }],
        take: 100,
      });
      const jobs = await jobsFor(transfers.map((t) => t.id));
      return transfers.map((transfer) => ({ transfer, ...jobs.get(transfer.id)! }));
    },

    /**
     * An administrator decides a disputed escrow: the sale is released, or the buyer refunded
     * (e.g. once the seller has the item back). A transfer that failed to send can only be
     * refunded.
     */
    async resolve(id: string, input: ResolveEscrowInput, actor: Actor) {
      const at = now();
      await prisma.$transaction(async (tx) => {
        const current = await lockEscrow(tx, id).catch(() => {
          throw notFound("Transfer");
        });
        if (current.status !== "ACCEPTED" || current.escrowStatus !== "DISPUTED") {
          throw escrowState("This escrow is not disputed");
        }
        if (input.outcome === "RELEASE" && current.disputeReason === "release_failed") {
          throw escrowState("The transfer could not be sent; the buyer can only be refunded");
        }
        await tx.transferRequest.update({
          where: { id },
          data: {
            resolvedById: actor.userId,
            resolution: input.resolution,
            resolvedAt: at,
            updatedAt: at,
          },
        });
        if (input.outcome === "RELEASE") {
          await releaseEscrow(tx, current, "released_by_admin", at, actor);
        } else {
          await refundEscrow(tx, current, "refunded_by_admin", at, actor);
        }
      });
      const transfer = await load(id);
      if (!transfer) throw notFound("Transfer");
      return withJob(transfer);
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
      // Checked again on-chain; a buyer who cannot pay would only make the transfer fail there.
      // In escrow, the buyer pays separately and the price is checked then.
      if (!seller && transfer.priceLamports > 0n && transfer.delivery === "IN_PERSON") {
        let balance: bigint;
        try {
          if (!oracle) throw new Error("no oracle");
          balance = await oracle.getBalance(wallet);
        } catch (error) {
          throw chainUnavailable(id, "buyer balance check failed", error);
        }
        if (balance < transfer.priceLamports) {
          throw new ApiError(
            422,
            "insufficient_funds",
            "Your wallet does not hold enough SOL to pay the price",
          );
        }
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
        // In escrow, the signed transfer waits for the payment and the buyer's receipt.
        if (!bothSigned(updated) || updated.delivery === "SHIPPED") return;
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
