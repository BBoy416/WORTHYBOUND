import type {
  AssetStatus,
  ChainTransaction,
  ChainTransactionKind,
  Prisma,
  PrismaClient,
} from "@worthybound/database";
import { chainAddresses, StaleChainUpdateError, type WorthyBoundOracle } from "@worthybound/solana";
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
];

/** Failed jobs are retried with growing delays, then left FAILED for an operator. */
export const MAX_CHAIN_ATTEMPTS = 5;
const retryDelayMs = (attempts: number) => Math.min(5_000 * 2 ** (attempts - 1), 5 * 60_000);

export const registerJobKey = (assetId: string) => `register-asset:${assetId}`;

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
  const { prisma, oracle, now, log, metadataUrl } = options;
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

  async function fail(job: ChainTransaction, error: unknown, final: boolean): Promise<void> {
    const attempts = final ? MAX_CHAIN_ATTEMPTS : job.attempts + 1;
    const message =
      error instanceof NotTokenizableError
        ? error.message
        : String((error as Error)?.message ?? error).slice(0, 500);
    log.warn({ jobId: job.id, kind: job.kind, attempts, err: message }, "chain job failed");
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
    });
  }

  async function process(job: ChainTransaction): Promise<void> {
    try {
      const outcome =
        job.kind === "REGISTER_ASSET"
          ? await register(job)
          : job.kind === "UPDATE_ASSET_STATUS"
            ? await updateStatus(job)
            : await commitTrust(job);
      await complete(job, outcome);
    } catch (error) {
      if (error instanceof StaleChainUpdateError) {
        await complete(job, { status: "SUPERSEDED" });
        return;
      }
      await fail(job, error, error instanceof NotTokenizableError);
    }
  }

  async function due(): Promise<ChainTransaction[]> {
    const jobs = await prisma.chainTransaction.findMany({
      where: {
        entityType: "ASSET",
        kind: { in: [...SYNC_KINDS] },
        OR: [{ status: "PENDING" }, { status: "FAILED", attempts: { lt: MAX_CHAIN_ATTEMPTS } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    const tokenized = new Set(
      (
        await prisma.asset.findMany({
          where: {
            id: { in: [...new Set(jobs.map((j) => j.entityId))] },
            tokenizationStatus: "TOKENIZED",
          },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    const at = now().getTime();
    return jobs.filter(
      (j) =>
        // Status and score updates wait until the asset's registration is confirmed.
        (j.kind === "REGISTER_ASSET" || tokenized.has(j.entityId)) &&
        (j.status === "PENDING" || j.updatedAt.getTime() + retryDelayMs(j.attempts) <= at),
    );
  }

  async function runOnce(): Promise<number> {
    if (running) return running;
    running = (async () => {
      const attempted = new Set<string>();
      // Registrations enable an asset's other jobs, so look again after each pass.
      for (let pass = 0; pass < 3; pass++) {
        const jobs = (await due()).filter((j) => !attempted.has(j.id));
        if (jobs.length === 0) break;
        for (const job of jobs) {
          attempted.add(job.id);
          await process(job);
        }
        if (!jobs.some((j) => j.kind === "REGISTER_ASSET")) break;
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
