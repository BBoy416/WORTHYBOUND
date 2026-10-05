import type {
  AssetStatus,
  ChainTransaction,
  ChainTransactionKind,
  Prisma,
  PrismaClient,
} from "@worthybound/database";
import {
  chainAddresses,
  StaleChainUpdateError,
  TransferFailedError,
  type WorthyBoundOracle,
} from "@worthybound/solana";
import type { FastifyBaseLogger } from "fastify";

type Tx = Prisma.TransactionClient;

/** Published statuses an asset can be tokenized from; the program registers only these. */
export const TOKENIZABLE_STATUSES: readonly AssetStatus[] = [
  "ACTIVE",
  "VERIFIED",
  "REVERIFICATION_REQUIRED",
];

const SYNC_KINDS: readonly ChainTransactionKind[] = [
  "REGISTER_ASSET",
  "UPDATE_ASSET_STATUS",
  "COMMIT_TRUST_SCORE",
  "TRANSFER_ASSET",
  "ESCROW_PAYMENT",
  "ESCROW_REFUND",
  "CLOSE_NONCE_ACCOUNTS",
];

/** Failed jobs are retried with growing delays, then left FAILED for an operator. */
export const MAX_CHAIN_ATTEMPTS = 5;
const retryDelayMs = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 5 * 60_000);

export const registerJobKey = (assetId: string) => `register-asset:${assetId}`;
export const closeNoncesJobKey = (transferId: string) => `close-nonces:${transferId}`;

/**
 * Queues closing the nonce accounts of transfers that ended, once no other chain job of theirs
 * can still run and no escrow holds the price, so the oracle gets their rent back.
 */
export async function enqueueNonceClosures(prisma: PrismaClient): Promise<void> {
  const ended = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t."id" FROM "transfer_requests" t
    WHERE t."nonceAccount" IS NOT NULL
      AND t."status" IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'REJECTED')
      AND (t."escrowStatus" IS NULL
        OR t."escrowStatus" IN ('AWAITING_PAYMENT', 'RELEASED', 'REFUNDED'))
      AND NOT EXISTS (
        SELECT 1 FROM "chain_transactions" c
        WHERE c."entityType" = 'TRANSFER_REQUEST' AND c."entityId" = t."id"
          AND (c."kind" = 'CLOSE_NONCE_ACCOUNTS'
            OR c."status" IN ('PENDING', 'SUBMITTED')
            OR (c."status" = 'FAILED' AND c."attempts" < ${MAX_CHAIN_ATTEMPTS})))
    ORDER BY t."id"
    LIMIT 50`;
  if (ended.length === 0) return;
  await prisma.chainTransaction.createMany({
    data: ended.map(({ id }) => ({
      idempotencyKey: closeNoncesJobKey(id),
      kind: "CLOSE_NONCE_ACCOUNTS" as const,
      cluster: "DEVNET" as const,
      entityType: "TRANSFER_REQUEST" as const,
      entityId: id,
    })),
    skipDuplicates: true,
  });
}

/**
 * Queues mirroring of the asset's current status and latest Trust Score snapshot, if it is
 * tokenized or being tokenized. Keys carry the number of status events and snapshots, so
 * repeated calls without a change queue nothing new. Run in the transaction that changed them.
 */
export async function enqueueChainSync(tx: Tx, assetId: string): Promise<void> {
  const asset = await tx.asset.findUniqueOrThrow({
    where: { id: assetId },
    select: { tokenizationStatus: true },
  });
  if (asset.tokenizationStatus !== "TOKENIZED" && asset.tokenizationStatus !== "PENDING") return;
  const [statusSeq, trustSeq] = await Promise.all([
    tx.assetStatusEvent.count({ where: { assetId } }),
    tx.trustScoreSnapshot.count({ where: { assetId } }),
  ]);
  const job = (kind: ChainTransactionKind, idempotencyKey: string) => ({
    idempotencyKey,
    kind,
    cluster: "DEVNET" as const,
    entityType: "ASSET" as const,
    entityId: assetId,
  });
  await tx.chainTransaction.createMany({
    data: [
      job("UPDATE_ASSET_STATUS", `asset-status:${assetId}:${statusSeq}`),
      ...(trustSeq > 0 ? [job("COMMIT_TRUST_SCORE", `trust-score:${assetId}:${trustSeq}`)] : []),
    ],
    skipDuplicates: true,
  });
}

export interface ChainSyncOptions {
  prisma: PrismaClient;
  oracle: WorthyBoundOracle;
  now: () => Date;
  log: FastifyBaseLogger;
  /** Token metadata URL registered on-chain for an asset. */
  metadataUrl: (wbId: string) => string;
  /** Records a transfer confirmed on-chain, in the transaction that confirms its job. */
  completeTransfer: (tx: Tx, transferId: string, signature: string, at: Date) => Promise<void>;
  /** Records escrow payments, refunds and failed releases (ADR 0014), in the job's transaction. */
  escrow: {
    paid(tx: Tx, transferId: string, signature: string | null, at: Date): Promise<void>;
    refunded(tx: Tx, transferId: string, signature: string | null, at: Date): Promise<void>;
    releaseFailed(tx: Tx, transferId: string, at: Date): Promise<void>;
  };
  /** Applies escrow deadlines that passed, before each run. */
  escrowDeadlines: (at: Date) => Promise<unknown>;
}

export interface ChainSync {
  /** Processes due jobs once, oldest first; returns how many were attempted. */
  runOnce(): Promise<number>;
  /** Runs `runOnce` every `intervalMs` until stopped. */
  start(intervalMs?: number): void;
  /** Runs soon, e.g. after a tokenization request. */
  kick(): void;
  stop(): Promise<void>;
}

type Outcome = { status: "CONFIRMED"; signature: string } | { status: "SUPERSEDED" };

/**
 * Sends queued chain jobs with the oracle key (ADR 0016). Jobs always send the asset's current
 * state with its sequence numbers, so a late or repeated job is rejected on-chain as stale and
 * recorded as SUPERSEDED. One worker per database: run a single API instance.
 */
export function createChainSync(options: ChainSyncOptions): ChainSync {
  const { prisma, oracle, now, log, metadataUrl, completeTransfer, escrow, escrowDeadlines } =
    options;
  let running: Promise<number> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const assetOf = (id: string) =>
    prisma.asset.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        wbId: true,
        status: true,
        tokenizationStatus: true,
        owner: { select: { walletAddress: true } },
      },
    });

  async function register(job: ChainTransaction): Promise<Outcome> {
    const asset = await assetOf(job.entityId);
    if (!TOKENIZABLE_STATUSES.includes(asset.status)) {
      throw new NotTokenizableError(asset.status);
    }
    const statusSeq = await prisma.assetStatusEvent.count({ where: { assetId: asset.id } });
    const signature = await oracle.registerAsset({
      wbId: asset.wbId,
      owner: asset.owner.walletAddress,
      uri: metadataUrl(asset.wbId),
      status: asset.status,
      statusSeq: BigInt(statusSeq),
    });
    return { status: "CONFIRMED", signature };
  }

  async function updateStatus(job: ChainTransaction): Promise<Outcome> {
    const asset = await assetOf(job.entityId);
    const statusSeq = await prisma.assetStatusEvent.count({ where: { assetId: asset.id } });
    const signature = await oracle.updateStatus({
      wbId: asset.wbId,
      status: asset.status,
      statusSeq: BigInt(statusSeq),
    });
    return { status: "CONFIRMED", signature };
  }

  async function commitTrust(job: ChainTransaction): Promise<Outcome> {
    const asset = await assetOf(job.entityId);
    const [snapshot, trustSeq] = await Promise.all([
      prisma.trustScoreSnapshot.findFirst({
        where: { assetId: asset.id },
        orderBy: [{ computedAt: "desc" }, { id: "desc" }],
      }),
      prisma.trustScoreSnapshot.count({ where: { assetId: asset.id } }),
    ]);
    if (!snapshot) return { status: "SUPERSEDED" };
    const signature = await oracle.commitTrustScore({
      wbId: asset.wbId,
      score: snapshot.score,
      level: snapshot.verificationLevel,
      engineVersion: snapshot.engineVersion,
      weightsVersion: snapshot.weightsVersion,
      inputsHash: snapshot.inputsHash,
      trustSeq: BigInt(trustSeq),
    });
    return { status: "CONFIRMED", signature };
  }

  /**
   * Sends a transfer both parties signed, with the oracle's signature. A transfer that ended in
   * the meantime is not sent.
   */
  async function transfer(job: ChainTransaction): Promise<Outcome> {
    const t = await prisma.transferRequest.findUniqueOrThrow({
      where: { id: job.entityId },
      include: {
        fromUser: { select: { walletAddress: true } },
        toUser: { select: { walletAddress: true } },
      },
    });
    if (t.status !== "ACCEPTED" || !t.transaction || !t.sellerSignature || !t.buyerSignature) {
      return { status: "SUPERSEDED" };
    }
    // An escrowed transfer is sent only once released.
    if (t.delivery === "SHIPPED" && t.escrowStatus !== "RELEASING") return { status: "SUPERSEDED" };
    const signature = await oracle.sendTransfer({
      transaction: t.transaction,
      signatures: {
        [t.fromUser.walletAddress]: t.sellerSignature,
        [t.toWalletAddress]: t.buyerSignature,
      },
    });
    return { status: "CONFIRMED", signature };
  }

  /**
   * Sends the buyer's signed payment into escrow. Sent even if the transfer ended meanwhile: the
   * buyer signed it, and a payment that lands late is refunded.
   */
  async function escrowPayment(job: ChainTransaction): Promise<Outcome> {
    const t = await prisma.transferRequest.findUniqueOrThrow({ where: { id: job.entityId } });
    if (!t.paymentTransaction || !t.paymentSignature || t.escrowStatus !== "AWAITING_PAYMENT") {
      return { status: "SUPERSEDED" };
    }
    const signature = await oracle.sendTransfer({
      transaction: t.paymentTransaction,
      signatures: { [t.toWalletAddress]: t.paymentSignature },
    });
    return { status: "CONFIRMED", signature };
  }

  /** Returns the escrowed price to the buyer; SUPERSEDED if the escrow no longer holds it. */
  async function escrowRefund(job: ChainTransaction): Promise<Outcome> {
    const t = await prisma.transferRequest.findUniqueOrThrow({ where: { id: job.entityId } });
    if (t.escrowStatus !== "REFUNDING" || !t.nonceAccount) return { status: "SUPERSEDED" };
    const signature = await oracle.refundEscrow({
      escrowAccount: t.nonceAccount,
      buyer: t.toWalletAddress,
      priceLamports: t.priceLamports,
    });
    return signature ? { status: "CONFIRMED", signature } : { status: "SUPERSEDED" };
  }

  /** Returns an ended transfer's nonce accounts' rent; SUPERSEDED if none was left to close. */
  async function closeNonces(job: ChainTransaction): Promise<Outcome> {
    const t = await prisma.transferRequest.findUniqueOrThrow({ where: { id: job.entityId } });
    const accounts = [t.nonceAccount, t.paymentNonceAccount].filter((a): a is string => !!a);
    const signature = await oracle.closeNonceAccounts(accounts);
    return signature ? { status: "CONFIRMED", signature } : { status: "SUPERSEDED" };
  }

  async function complete(job: ChainTransaction, outcome: Outcome): Promise<void> {
    const at = now();
    await prisma.$transaction(async (tx) => {
      await tx.chainTransaction.update({
        where: { id: job.id },
        data: {
          status: outcome.status,
          attempts: { increment: 1 },
          lastError: null,
          ...(outcome.status === "CONFIRMED"
            ? { signature: outcome.signature, submittedAt: at, confirmedAt: at }
            : {}),
        },
      });
      if (job.kind === "TRANSFER_ASSET" && outcome.status === "CONFIRMED") {
        await completeTransfer(tx, job.entityId, outcome.signature, at);
        return;
      }
      if (job.kind === "ESCROW_PAYMENT" && outcome.status === "CONFIRMED") {
        await escrow.paid(tx, job.entityId, outcome.signature, at);
        return;
      }
      if (job.kind === "ESCROW_REFUND") {
        const signature = outcome.status === "CONFIRMED" ? outcome.signature : null;
        await escrow.refunded(tx, job.entityId, signature, at);
        return;
      }
      if (job.kind !== "REGISTER_ASSET" || outcome.status !== "CONFIRMED") return;
      await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${job.entityId}::uuid FOR UPDATE`;
      const asset = await tx.asset.update({
        where: { id: job.entityId },
        data: { tokenizationStatus: "TOKENIZED", updatedAt: at },
      });
      const { record, coreAsset } = await chainAddresses(asset.wbId);
      await tx.provenanceEvent.create({
        data: {
          assetId: asset.id,
          type: "TOKENIZED",
          actorId: null,
          occurredAt: at,
          payload: {
            cluster: "devnet",
            record,
            coreAsset,
            signature: outcome.signature,
          },
        },
      });
      await enqueueChainSync(tx, asset.id);
    });
  }

  /**
   * Gives up on a payment into escrow for good: advances its nonce so it can no longer land, then
   * checks whether it landed anyway. Null if that could not be done now; the job is then retried.
   */
  async function resetPayment(job: ChainTransaction) {
    const t = await prisma.transferRequest.findUniqueOrThrow({ where: { id: job.entityId } });
    if (t.escrowStatus !== "AWAITING_PAYMENT" || !t.nonceAccount || !t.paymentNonceAccount) {
      return { held: false as const, transaction: null };
    }
    try {
      return await oracle.resetEscrowPayment({
        buyer: t.toWalletAddress,
        escrowAccount: t.nonceAccount,
        paymentNonceAccount: t.paymentNonceAccount,
        priceLamports: t.priceLamports,
      });
    } catch (error) {
      log.warn({ jobId: job.id, err: String(error) }, "escrow payment reset failed");
      return null;
    }
  }

  async function fail(job: ChainTransaction, error: unknown, final: boolean): Promise<void> {
    let attempts = final ? MAX_CHAIN_ATTEMPTS : job.attempts + 1;
    const message =
      error instanceof NotTokenizableError || error instanceof TransferFailedError
        ? error.message
        : String((error as Error)?.message ?? error).slice(0, 500);
    log.warn({ jobId: job.id, kind: job.kind, attempts, err: message }, "chain job failed");
    // A signed payment stays valid until its nonce moves on, so it is given up only once reset.
    const reset =
      job.kind === "ESCROW_PAYMENT" && attempts >= MAX_CHAIN_ATTEMPTS
        ? await resetPayment(job)
        : undefined;
    if (reset === null) attempts = MAX_CHAIN_ATTEMPTS - 1;
    await prisma.$transaction(async (tx) => {
      await tx.chainTransaction.update({
        where: { id: job.id },
        data: { status: "FAILED", attempts, lastError: message },
      });
      if (job.kind === "REGISTER_ASSET" && attempts >= MAX_CHAIN_ATTEMPTS) {
        await tx.asset.update({
          where: { id: job.entityId },
          data: { tokenizationStatus: "FAILED", updatedAt: now() },
        });
      }
      if (reset?.held) {
        await escrow.paid(tx, job.entityId, null, now());
      } else if (reset) {
        await tx.transferRequest.updateMany({
          where: { id: job.entityId, escrowStatus: "AWAITING_PAYMENT" },
          data: {
            paymentSignature: null,
            ...(reset.transaction ? { paymentTransaction: reset.transaction } : {}),
            updatedAt: now(),
          },
        });
      }
      if (job.kind === "TRANSFER_ASSET" && attempts >= MAX_CHAIN_ATTEMPTS) {
        await escrow.releaseFailed(tx, job.entityId, now());
      }
    });
  }

  async function process(job: ChainTransaction): Promise<void> {
    try {
      const outcome =
        job.kind === "REGISTER_ASSET"
          ? await register(job)
          : job.kind === "UPDATE_ASSET_STATUS"
            ? await updateStatus(job)
            : job.kind === "TRANSFER_ASSET"
              ? await transfer(job)
              : job.kind === "ESCROW_PAYMENT"
                ? await escrowPayment(job)
                : job.kind === "ESCROW_REFUND"
                  ? await escrowRefund(job)
                  : job.kind === "CLOSE_NONCE_ACCOUNTS"
                    ? await closeNonces(job)
                    : await commitTrust(job);
      await complete(job, outcome);
    } catch (error) {
      if (
        error instanceof StaleChainUpdateError &&
        job.kind !== "TRANSFER_ASSET" &&
        job.kind !== "ESCROW_PAYMENT" &&
        job.kind !== "ESCROW_REFUND"
      ) {
        await complete(job, { status: "SUPERSEDED" });
        return;
      }
      await fail(
        job,
        error,
        error instanceof NotTokenizableError || error instanceof TransferFailedError,
      );
    }
  }

  async function due(): Promise<ChainTransaction[]> {
    const unfinished = {
      OR: [
        { status: "PENDING" as const },
        { status: "FAILED" as const, attempts: { lt: MAX_CHAIN_ATTEMPTS } },
      ],
    };
    const jobs = await prisma.chainTransaction.findMany({
      where: {
        entityType: { in: ["ASSET", "TRANSFER_REQUEST"] },
        kind: { in: [...SYNC_KINDS] },
        ...unfinished,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    const assetJobs = jobs.filter((j) => j.entityType === "ASSET");
    const tokenized = new Set(
      (
        await prisma.asset.findMany({
          where: {
            id: { in: [...new Set(assetJobs.map((j) => j.entityId))] },
            tokenizationStatus: "TOKENIZED",
          },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    // A transfer waits until the asset's earlier status updates (TRANSFER_PENDING) are on-chain.
    const transfers = await prisma.transferRequest.findMany({
      where: {
        id: { in: jobs.filter((j) => j.entityType === "TRANSFER_REQUEST").map((j) => j.entityId) },
      },
      select: { id: true, assetId: true },
    });
    const waiting = new Set(
      (
        await prisma.chainTransaction.findMany({
          where: {
            entityType: "ASSET",
            entityId: { in: transfers.map((t) => t.assetId) },
            kind: { in: ["REGISTER_ASSET", "UPDATE_ASSET_STATUS"] },
            ...unfinished,
          },
          select: { entityId: true },
        })
      ).map((j) => j.entityId),
    );
    const paying = new Set(jobs.filter((j) => j.kind === "ESCROW_PAYMENT").map((j) => j.entityId));
    const ready = new Set(transfers.filter((t) => !waiting.has(t.assetId)).map((t) => t.id));
    const at = now().getTime();
    return jobs.filter(
      (j) =>
        (j.entityType === "TRANSFER_REQUEST"
          ? ready.has(j.entityId) &&
            // A refund waits until the payment into escrow is sent or given up.
            !(j.kind === "ESCROW_REFUND" && paying.has(j.entityId))
          : // Status and score updates wait until the asset's registration is confirmed.
            j.kind === "REGISTER_ASSET" || tokenized.has(j.entityId)) &&
        (j.status === "PENDING" || j.updatedAt.getTime() + retryDelayMs(j.attempts) <= at),
    );
  }

  async function runOnce(): Promise<number> {
    if (running) return running;
    running = (async () => {
      await escrowDeadlines(now()).catch((error: unknown) =>
        log.error({ err: error }, "escrow deadlines failed"),
      );
      await enqueueNonceClosures(prisma).catch((error: unknown) =>
        log.error({ err: error }, "queueing nonce closures failed"),
      );
      const attempted = new Set<string>();
      // Registrations enable an asset's other jobs, so look again after each pass.
      for (let pass = 0; pass < 3; pass++) {
        const jobs = (await due()).filter((j) => !attempted.has(j.id));
        if (jobs.length === 0) break;
        for (const job of jobs) {
          attempted.add(job.id);
          await process(job);
        }
        // Registrations and status updates can make other jobs due.
        if (!jobs.some((j) => j.kind === "REGISTER_ASSET" || j.kind === "UPDATE_ASSET_STATUS")) {
          break;
        }
      }
      return attempted.size;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  const tick = () => {
    runOnce().catch((error: unknown) => log.error({ err: error }, "chain sync failed"));
  };

  return {
    runOnce,
    start(intervalMs = 5_000) {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    kick() {
      setImmediate(tick);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}

class NotTokenizableError extends Error {
  constructor(status: AssetStatus) {
    super(`asset_not_tokenizable: status ${status}`);
  }
}
