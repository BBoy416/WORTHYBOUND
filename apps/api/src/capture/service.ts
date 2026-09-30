import { randomInt } from "node:crypto";
import type { Asset, CaptureSession, Prisma, PrismaClient } from "@worthybound/database";
import {
  CAPTURE_CODE_ALPHABET,
  CAPTURE_CODE_LENGTH,
  CAPTURE_SESSION_MINUTES,
  CAPTURE_SESSIONS_PER_ASSET_PER_DAY,
  CAPTURE_SESSIONS_PER_USER_PER_DAY,
  CAPTURE_SHOTS_BY_CATEGORY,
  type CaptureShot,
} from "@worthybound/shared";
import type { Actor } from "../assets/service.js";
import { writeAudit } from "../audit.js";
import { ApiError, notFound } from "../errors.js";
import type { SessionRecord } from "./view.js";

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60_000;

export const withEvidence = {
  evidence: { select: { id: true, captureShot: true, createdAt: true } },
} satisfies Prisma.CaptureSessionInclude;

export const captureCode = () =>
  Array.from(
    { length: CAPTURE_CODE_LENGTH },
    () => CAPTURE_CODE_ALPHABET[randomInt(CAPTURE_CODE_ALPHABET.length)],
  ).join("");

export const sessionClosed = () =>
  new ApiError(409, "capture_session_closed", "This capture session has ended; start a new one");

/**
 * Checks, when an upload is requested, that the shot can still be taken in the session: it is
 * the asset's open session, asks for the shot, and has no photo for it yet.
 */
export async function assertShotOpen(
  tx: Tx,
  asset: Asset,
  sessionId: string,
  shot: CaptureShot,
  at: Date,
): Promise<void> {
  const session = await tx.captureSession.findUnique({
    where: { id: sessionId },
    include: withEvidence,
  });
  if (!session || session.assetId !== asset.id) throw notFound("Capture session");
  if (session.status !== "OPEN" || session.expiresAt <= at) throw sessionClosed();
  if (!session.shots.includes(shot)) {
    throw new ApiError(422, "capture_shot_not_required", "This session does not ask for this shot");
  }
  if (session.evidence.some((e) => e.captureShot === shot)) {
    throw new ApiError(409, "capture_shot_taken", "This shot was already taken in this session");
  }
}

/**
 * Completes the session once every required shot has arrived, and tells whether it did. Run after
 * storing a shot, in its transaction, with the session locked.
 */
export async function completeIfDone(
  tx: Tx,
  session: CaptureSession,
  actor: Actor,
  at: Date,
): Promise<boolean> {
  const taken = await tx.evidence.count({ where: { captureSessionId: session.id } });
  if (taken < session.shots.length) return false;
  await tx.captureSession.update({
    where: { id: session.id },
    data: { status: "COMPLETED", completedAt: at, updatedAt: at },
  });
  await tx.provenanceEvent.create({
    data: {
      assetId: session.assetId,
      type: "CAPTURE_COMPLETED",
      actorId: actor.userId,
      occurredAt: at,
      payload: { captureSessionId: session.id, shots: session.shots.length },
    },
  });
  await writeAudit(
    tx,
    {
      actorId: actor.userId,
      action: "capture.completed",
      targetType: "capture_session",
      targetId: session.id,
      metadata: { shots: session.shots.length },
    },
    actor.fp,
  );
  return true;
}

export interface CaptureServiceOptions {
  prisma: PrismaClient;
  now: () => Date;
}

/** Guided capture (ADR 0013): timed sessions of photos taken with the app's camera. */
export function createCaptureService({ prisma, now }: CaptureServiceOptions) {
  /** The owner's asset; discarded drafts are hidden, as elsewhere. */
  async function ownedAsset(db: Tx | PrismaClient, wbId: string, actor: Actor): Promise<Asset> {
    const asset = await db.asset.findUnique({ where: { wbId } });
    if (
      !asset ||
      asset.ownerId !== actor.userId ||
      (asset.status === "REVOKED" && asset.publishedAt === null)
    ) {
      throw notFound("Asset");
    }
    return asset;
  }

  /** Records sessions that passed their expiry without every shot as expired. */
  const expireDue = (db: Tx | PrismaClient, assetId: string, at: Date) =>
    db.captureSession.updateMany({
      where: { assetId, status: "OPEN", expiresAt: { lte: at } },
      data: { status: "EXPIRED", updatedAt: at },
    });

  return {
    /** The asset's latest sessions, newest first. */
    async list(wbId: string, actor: Actor): Promise<SessionRecord[]> {
      const asset = await ownedAsset(prisma, wbId, actor);
      await expireDue(prisma, asset.id, now());
      return prisma.captureSession.findMany({
        where: { assetId: asset.id },
        include: withEvidence,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
      });
    },

    /**
     * Starts a session with a new code and the shots for the asset's category, or returns the
     * open one. Sessions are limited per asset and per owner per day, so checks cannot be probed
     * cheaply.
     */
    async start(wbId: string, actor: Actor): Promise<{ session: SessionRecord; created: boolean }> {
      const at = now();
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${wbId} FOR UPDATE`;
        const asset = await ownedAsset(tx, wbId, actor);
        if (asset.status === "REVOKED") {
          throw new ApiError(409, "asset_revoked", "Evidence cannot be added to a revoked asset");
        }
        await expireDue(tx, asset.id, at);
        // Sessions for remote checks and shipments are started from them and limited with them.
        const open = await tx.captureSession.findFirst({
          where: {
            assetId: asset.id,
            purchaseCheckId: null,
            transferRequestId: null,
            status: "OPEN",
          },
          include: withEvidence,
        });
        if (open) return { session: open, created: false };

        const since = new Date(at.getTime() - DAY_MS);
        const own = { purchaseCheckId: null, transferRequestId: null, createdAt: { gt: since } };
        const [forAsset, forUser] = await Promise.all([
          tx.captureSession.count({ where: { ...own, assetId: asset.id } }),
          tx.captureSession.count({ where: { ...own, ownerId: actor.userId } }),
        ]);
        if (
          forAsset >= CAPTURE_SESSIONS_PER_ASSET_PER_DAY ||
          forUser >= CAPTURE_SESSIONS_PER_USER_PER_DAY
        ) {
          throw new ApiError(
            429,
            "capture_limit_reached",
            `You can start ${CAPTURE_SESSIONS_PER_ASSET_PER_DAY} capture sessions per item and ` +
              `${CAPTURE_SESSIONS_PER_USER_PER_DAY} in total per day; try again later`,
          );
        }
        const session = await tx.captureSession.create({
          data: {
            assetId: asset.id,
            ownerId: actor.userId,
            code: captureCode(),
            shots: [...CAPTURE_SHOTS_BY_CATEGORY[asset.category]],
            expiresAt: new Date(at.getTime() + CAPTURE_SESSION_MINUTES * 60_000),
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
            metadata: { captureSessionId: session.id, shots: session.shots },
          },
          actor.fp,
        );
        return { session, created: true };
      });
    },
  };
}
