import { createHash, randomUUID } from "node:crypto";
import { CHECK_VERSION } from "@worthybound/automated-checks";
import type { Evidence, Prisma, PrismaClient } from "@worthybound/database";
import {
  CAPTURE_CODE_SHOT,
  CAPTURE_SESSION_MINUTES,
  CAPTURE_VIDEO_SHOT,
  type CaptureShot,
  type ItemMatchReason,
  MAX_REFERENCE_PHOTOS,
  OWNER_CODE_MINUTES,
  ownerConfirmationMessage,
  PURCHASE_CHECK_MINUTES,
  PURCHASE_CHECKS_PER_ASSET_PER_DAY,
  PURCHASE_CHECKS_PER_BUYER_PER_DAY,
  type PurchaseCheckKind,
  purchaseCheckShots,
  REMOTE_CHECK_HOURS,
  REMOTE_CHECKS_PER_ASSET_PER_DAY,
  remoteCheckShots,
} from "@worthybound/shared";
import type { Storage } from "@worthybound/storage";
import type { OwnerConfirmationInput } from "@worthybound/validation";
import { fileTypeFromBuffer } from "file-type";
import type { Actor } from "../assets/service.js";
import { writeAudit } from "../audit.js";
import { verifyWalletSignature } from "../auth/siws.js";
import { captureCode, withEvidence } from "../capture/service.js";
import type { SessionRecord } from "../capture/view.js";
import { evidenceCheckStates } from "../checks/view.js";
import type { AutomatedChecks } from "../checks/worker.js";
import { decodeBase58 } from "../crypto.js";
import { ApiError, notFound } from "../errors.js";
import { checkImage } from "../evidence/inspect.js";
import type { CheckRecord, RemoteRequestRecord } from "./view.js";

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

const DAY_MS = 24 * 60 * 60_000;
export const PURCHASE_CHECK_PREFIX = "purchase-checks/";
/** Largest photo accepted from the camera. */
export const MAX_CHECK_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

const DOWNLOAD_EXPIRY_SECONDS = 5 * 60;
/** Where the buyer's copy of a remote check video is stored: the video without its metadata. */
export const remoteVideoKey = (assetId: string, evidenceId: string) =>
  `remote-check-videos/${assetId}/${evidenceId}`;
const VIDEO_EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov" };

/** A remote check's latest session, whose shots show the buyer the seller's progress. */
const latestSession = {
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  take: 1,
  select: {
    ownerId: true,
    status: true,
    expiresAt: true,
    completedAt: true,
    evidence: { select: { id: true, captureShot: true, createdAt: true } },
  },
} satisfies Prisma.CaptureSessionFindManyArgs;

const withPhotos = {
  asset: true,
  photos: { select: { shot: true, createdAt: true } },
  captureSessions: latestSession,
} satisfies Prisma.PurchaseCheckInclude;

const checkClosed = () =>
  new ApiError(409, "purchase_check_closed", "This check has ended; start a new one");
const wrongKind = (kind: PurchaseCheckKind) =>
  new ApiError(
    409,
    "purchase_check_kind",
    kind === "REMOTE"
      ? "This is a remote check; the seller films the item"
      : kind === "RECEIPT"
        ? "This check is of a delivered item; the buyer photographs the package and the item"
        : "This check is in person; the buyer photographs the item",
  );

/**
 * The asset's recorded photos to compare a buyer's photos with (ADR 0014): the verifier's, then
 * the latest completed capture session's without the code shot. Rejected photos and photos that
 * failed an automated check are left out.
 */
export async function referencePhotos(db: Db, assetId: string): Promise<Evidence[]> {
  const usable = {
    assetId,
    type: "PHOTO" as const,
    mimeType: { in: PHOTO_TYPES },
    reviewStatus: { not: "REJECTED" as const },
    automatedChecks: { none: { result: "FAILED" as const, checkVersion: CHECK_VERSION } },
  };
  const [verifier, session] = await Promise.all([
    db.evidence.findMany({
      where: { ...usable, source: "VERIFIER" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_REFERENCE_PHOTOS,
    }),
    // Sessions filmed for a remote check or before shipping are compared, not compared with.
    db.captureSession.findFirst({
      where: { assetId, purchaseCheckId: null, transferRequestId: null, status: "COMPLETED" },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      select: { id: true, shots: true },
    }),
  ]);
  const captured = session
    ? (
        await db.evidence.findMany({
          where: {
            ...usable,
            captureSessionId: session.id,
            captureShot: { not: CAPTURE_CODE_SHOT },
          },
        })
      ).sort(
        (a, b) =>
          session.shots.indexOf(a.captureShot ?? "") - session.shots.indexOf(b.captureShot ?? ""),
      )
    : [];
  return [...verifier, ...captured].slice(0, MAX_REFERENCE_PHOTOS);
}

/**
 * Records an item result without a comparison, e.g. when there is nothing to compare with.
 * Run in a transaction, after the last photo arrived.
 */
export async function recordInconclusive(
  tx: Tx,
  checkId: string,
  reason: ItemMatchReason,
  at: Date,
): Promise<void> {
  await tx.purchaseCheck.update({
    where: { id: checkId },
    data: {
      status: "COMPLETED",
      itemResult: "INCONCLUSIVE",
      itemReason: reason,
      itemCheckedAt: at,
      updatedAt: at,
    },
  });
  await writeAudit(
    tx,
    {
      actorId: null,
      action: "purchase_check.item_checked",
      targetType: "purchase_check",
      targetId: checkId,
      metadata: { result: "INCONCLUSIVE", reason },
    },
    null,
  );
}

/**
 * Records that the seller filmed the item for a remote check and queues the comparison, when the
 * seller's capture session completes. Run in the session's transaction; tells whether a
 * comparison was queued.
 */
export async function remoteCheckFilmed(
  tx: Tx,
  checkId: string,
  captureSessionId: string,
  actor: Actor,
  at: Date,
  checksAvailable: boolean,
): Promise<boolean> {
  await tx.$queryRaw`SELECT 1 FROM "purchase_checks" WHERE "id" = ${checkId}::uuid FOR UPDATE`;
  const check = await tx.purchaseCheck.findUniqueOrThrow({ where: { id: checkId } });
  if (check.status !== "OPEN" || check.photosCompletedAt !== null || check.expiresAt < at) {
    return false;
  }
  await tx.purchaseCheck.update({
    where: { id: checkId },
    data: { photosCompletedAt: at, updatedAt: at },
  });
  await writeAudit(
    tx,
    {
      actorId: actor.userId,
      action: "purchase_check.filmed",
      targetType: "purchase_check",
      targetId: checkId,
      metadata: { captureSessionId },
    },
    actor.fp,
  );
  if (!checksAvailable) {
    await recordInconclusive(tx, checkId, "CHECKS_UNAVAILABLE", at);
    return false;
  }
  await tx.automatedJob.create({
    data: {
      kind: "ITEM_MATCH",
      entityId: checkId,
      requestedById: actor.userId,
      runAfter: at,
      createdAt: at,
      updatedAt: at,
    },
  });
  return true;
}

export interface PurchaseCheckServiceOptions {
  prisma: PrismaClient;
  storage: Storage;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  /** Null when AI checks are unavailable; item checks are then inconclusive. */
  checks: AutomatedChecks | null;
}

/** Checks before buying, in person (ADR 0014). */
export function createPurchaseCheckService({
  prisma,
  storage,
  now,
  log,
  checks,
}: PurchaseCheckServiceOptions) {
  /** Records checks whose buyer did not take every photo in time as expired. */
  const expireDue = (db: Db, where: Prisma.PurchaseCheckWhereInput, at: Date) =>
    db.purchaseCheck.updateMany({
      where: { ...where, status: "OPEN", photosCompletedAt: null, expiresAt: { lte: at } },
      data: { status: "EXPIRED", updatedAt: at },
    });

  /** The buyer's check; 404 for anyone else, as for unknown IDs. */
  async function buyersCheck(db: Db, id: string, actor: Actor): Promise<CheckRecord> {
    const check = await db.purchaseCheck.findUnique({ where: { id }, include: withPhotos });
    if (!check || check.buyerId !== actor.userId) throw notFound("Check");
    return check;
  }

  async function lockCheck(tx: Tx, id: string, actor: Actor): Promise<CheckRecord> {
    await tx.$queryRaw`SELECT 1 FROM "purchase_checks" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return buyersCheck(tx, id, actor);
  }

  /**
   * The check with the recorded photos it can show and, once the seller filmed a remote check,
   * the AI check of the code photo, for the view.
   */
  async function withRecorded(check: CheckRecord) {
    const recorded =
      check.referenceEvidenceIds.length === 0
        ? []
        : await prisma.evidence.findMany({
            where: { id: { in: check.referenceEvidenceIds } },
            select: { id: true, publicStorageKey: true },
          });
    const session = check.captureSessions[0];
    const code =
      check.kind === "REMOTE" && session?.status === "COMPLETED"
        ? session.evidence.find((e) => e.captureShot === CAPTURE_CODE_SHOT)
        : undefined;
    const codeCheck = code
      ? { check: (await evidenceCheckStates(prisma, [code.id])).get(code.id) ?? null }
      : null;
    return { check, recorded, codeCheck };
  }

  async function removeQuietly(key: string) {
    try {
      await storage.remove(key);
    } catch (error) {
      log.warn({ err: error }, "could not remove stored file");
    }
  }

  /** The owner's published asset, locked; 404 for anyone else. */
  async function lockOwnedAsset(tx: Tx, wbId: string, actor: Actor) {
    await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${wbId} FOR UPDATE`;
    const asset = await tx.asset.findUnique({ where: { wbId } });
    if (!asset || asset.ownerId !== actor.userId || asset.publishedAt === null) {
      throw notFound("Asset");
    }
    return asset;
  }

  /**
   * Starts a check of a published item, or returns the buyer's open one of that kind. Checks are
   * limited per buyer and per item per day, so they cannot be used to probe other people's items;
   * remote checks, which ask the seller to film the item, are limited further per item.
   */
  async function open(wbId: string, kind: PurchaseCheckKind, actor: Actor) {
    const at = now();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${wbId} FOR UPDATE`;
      const asset = await tx.asset.findUnique({ where: { wbId } });
      if (!asset || asset.publishedAt === null || asset.status === "REVOKED") {
        throw notFound("Asset");
      }
      if (asset.ownerId === actor.userId) {
        throw new ApiError(422, "own_asset", "You cannot check an item you own before buying it");
      }
      await expireDue(tx, { assetId: asset.id }, at);
      const current = await tx.purchaseCheck.findFirst({
        where: { assetId: asset.id, buyerId: actor.userId, kind, status: "OPEN" },
        orderBy: { createdAt: "desc" },
        include: withPhotos,
      });
      if (current) return { check: current, created: false };

      const since = new Date(at.getTime() - DAY_MS);
      // Receipt checks come with a shipped transfer and are not limited.
      const started = { createdAt: { gt: since }, kind: { not: "RECEIPT" as const } };
      const [forBuyer, forAsset, remoteForAsset] = await Promise.all([
        tx.purchaseCheck.count({ where: { ...started, buyerId: actor.userId } }),
        tx.purchaseCheck.count({ where: { ...started, assetId: asset.id } }),
        tx.purchaseCheck.count({
          where: { assetId: asset.id, kind: "REMOTE", createdAt: { gt: since } },
        }),
      ]);
      if (
        forBuyer >= PURCHASE_CHECKS_PER_BUYER_PER_DAY ||
        forAsset >= PURCHASE_CHECKS_PER_ASSET_PER_DAY ||
        (kind === "REMOTE" && remoteForAsset >= REMOTE_CHECKS_PER_ASSET_PER_DAY)
      ) {
        throw new ApiError(
          429,
          "purchase_check_limit_reached",
          "Too many checks were started today; try again tomorrow",
        );
      }
      const remoteExpiry = new Date(at.getTime() + REMOTE_CHECK_HOURS * 60 * 60_000);
      const check = await tx.purchaseCheck.create({
        data: {
          assetId: asset.id,
          buyerId: actor.userId,
          kind,
          ownerCode: captureCode(),
          ...(kind === "REMOTE"
            ? {
                ownerCodeExpiresAt: remoteExpiry,
                shots: remoteCheckShots(asset.category),
                expiresAt: remoteExpiry,
              }
            : {
                ownerCodeExpiresAt: new Date(at.getTime() + OWNER_CODE_MINUTES * 60_000),
                shots: purchaseCheckShots(asset.category),
                expiresAt: new Date(at.getTime() + PURCHASE_CHECK_MINUTES * 60_000),
              }),
          createdAt: at,
        },
        include: withPhotos,
      });
      await writeAudit(
        tx,
        {
          actorId: actor.userId,
          action: "purchase_check.started",
          targetType: "asset",
          targetId: asset.wbId,
          metadata: { purchaseCheckId: check.id, kind },
        },
        actor.fp,
      );
      return { check, created: true };
    });
    return { ...(await withRecorded(result.check)), created: result.created };
  }

  return {
    /** Starts a check in person, or returns the buyer's open one. */
    start: (wbId: string, actor: Actor) => open(wbId, "IN_PERSON", actor),

    /** Requests a remote check: the seller films the item with the code within 24 hours. */
    startRemote: (wbId: string, actor: Actor) => open(wbId, "REMOTE", actor),

    async get(id: string, actor: Actor) {
      await expireDue(prisma, { id, buyerId: actor.userId }, now());
      return withRecorded(await buyersCheck(prisma, id, actor));
    },

    /** A new code for the seller, while the owner has not confirmed yet. */
    async newOwnerCode(id: string, actor: Actor) {
      const at = now();
      const check = await prisma.$transaction(async (tx) => {
        const current = await lockCheck(tx, id, actor);
        if (current.kind !== "IN_PERSON") throw wrongKind(current.kind);
        if (current.status !== "OPEN" || current.expiresAt <= at) throw checkClosed();
        if (current.ownerConfirmedAt !== null) return current;
        return tx.purchaseCheck.update({
          where: { id },
          data: {
            ownerCode: captureCode(),
            ownerCodeExpiresAt: new Date(at.getTime() + OWNER_CODE_MINUTES * 60_000),
            updatedAt: at,
          },
          include: withPhotos,
        });
      });
      return withRecorded(check);
    },

    /**
     * The owner confirms to a buyer in front of them that they own the item, by signing the
     * buyer's code with the owner's wallet within OWNER_CODE_MINUTES.
     */
    async confirmOwner(wbId: string, input: OwnerConfirmationInput, actor: Actor) {
      const at = now();
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${wbId} FOR UPDATE`;
        const asset = await tx.asset.findUnique({
          where: { wbId },
          include: { owner: { select: { walletAddress: true } } },
        });
        if (!asset || asset.ownerId !== actor.userId || asset.publishedAt === null) {
          throw notFound("Asset");
        }
        const check = await tx.purchaseCheck.findFirst({
          where: {
            assetId: asset.id,
            kind: "IN_PERSON",
            ownerCode: input.code,
            ownerConfirmedAt: null,
            status: { not: "EXPIRED" },
            ownerCodeExpiresAt: { gt: at },
            expiresAt: { gt: at },
          },
        });
        if (!check) {
          throw new ApiError(
            422,
            "invalid_code",
            "This code is not valid or has expired; ask the buyer for a new one",
          );
        }
        const signature = decodeBase58(input.signature);
        const message = new TextEncoder().encode(ownerConfirmationMessage(wbId, input.code));
        if (!signature || !verifyWalletSignature(asset.owner.walletAddress, message, signature)) {
          throw new ApiError(
            422,
            "invalid_signature",
            "The signature is not a valid signature of this code by the owner's wallet",
          );
        }
        await tx.purchaseCheck.update({
          where: { id: check.id },
          data: {
            ownerConfirmedById: actor.userId,
            ownerSignature: input.signature,
            ownerConfirmedAt: at,
            updatedAt: at,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "purchase_check.owner_confirmed",
            targetType: "asset",
            targetId: wbId,
            metadata: { purchaseCheckId: check.id },
          },
          actor.fp,
        );
        return { confirmed: true as const, confirmedAt: at.toISOString() };
      });
    },

    /**
     * Stores a photo the buyer took with the app's camera, without its metadata, in person or of
     * a delivered item. The last photo queues the comparison with the recorded photos, or with
     * the seller's photos before shipping.
     */
    async addPhoto(id: string, shot: CaptureShot, body: Buffer, actor: Actor) {
      const at = now();
      const assertOpen = (check: CheckRecord) => {
        if (check.kind === "REMOTE") throw wrongKind(check.kind);
        if (check.status !== "OPEN" || check.photosCompletedAt !== null || check.expiresAt <= at) {
          throw checkClosed();
        }
        if (!check.shots.includes(shot)) {
          throw new ApiError(422, "shot_not_required", "This check does not ask for this shot");
        }
        if (check.photos.some((p) => p.shot === shot)) {
          throw new ApiError(409, "shot_taken", "This shot was already taken in this check");
        }
      };
      assertOpen(await buyersCheck(prisma, id, actor));

      const type = await fileTypeFromBuffer(body);
      if (!type || !PHOTO_TYPES.includes(type.mime)) {
        throw new ApiError(422, "not_a_photo", "Send a JPEG, PNG or WebP photo");
      }
      const photo = await checkImage(body).catch(() => {
        throw new ApiError(422, "image_unreadable", "The photo could not be processed");
      });
      const key = `${PURCHASE_CHECK_PREFIX}${id}/${randomUUID()}.jpg`;
      await storage.put(key, photo, "image/jpeg");

      let queued = false;
      try {
        await prisma.$transaction(async (tx) => {
          const check = await lockCheck(tx, id, actor);
          assertOpen(check);
          await tx.purchaseCheckPhoto.create({
            data: {
              checkId: id,
              shot,
              storageKey: key,
              sha256: createHash("sha256").update(photo).digest("hex"),
              sizeBytes: photo.length,
              createdAt: at,
            },
          });
          await writeAudit(
            tx,
            {
              actorId: actor.userId,
              action: "purchase_check.photo_added",
              targetType: "purchase_check",
              targetId: id,
              metadata: { shot },
            },
            actor.fp,
          );
          if (check.photos.length + 1 < check.shots.length) return;
          await tx.purchaseCheck.update({
            where: { id },
            data: { photosCompletedAt: at, updatedAt: at },
          });
          if (!checks) {
            await recordInconclusive(tx, id, "CHECKS_UNAVAILABLE", at);
            return;
          }
          await tx.automatedJob.create({
            data: {
              kind: "ITEM_MATCH",
              entityId: id,
              requestedById: actor.userId,
              runAfter: at,
              createdAt: at,
              updatedAt: at,
            },
          });
          queued = true;
        });
      } catch (error) {
        await removeQuietly(key);
        throw error;
      }
      if (queued) checks?.kick();
      return withRecorded(await buyersCheck(prisma, id, actor));
    },

    /** The buyer's own photo, as stored (a JPEG without metadata). */
    async photo(id: string, shot: CaptureShot, actor: Actor) {
      await buyersCheck(prisma, id, actor);
      const photo = await prisma.purchaseCheckPhoto.findUnique({
        where: { checkId_shot: { checkId: id, shot } },
      });
      if (!photo) throw notFound("Photo");
      return storage.read(photo.storageKey);
    },

    /**
     * A 5-minute link to the video the seller filmed for the buyer's remote check, without its
     * metadata. The video is private evidence of the asset, shown only to this buyer.
     */
    async video(id: string, actor: Actor) {
      const check = await buyersCheck(prisma, id, actor);
      if (check.kind !== "REMOTE") throw wrongKind(check.kind);
      const video = await prisma.evidence.findFirst({
        where: {
          captureShot: CAPTURE_VIDEO_SHOT,
          captureSession: { purchaseCheckId: id, status: "COMPLETED" },
        },
      });
      if (!video) throw notFound("Video");
      const link = await storage.presignDownload({
        key: remoteVideoKey(video.assetId, video.id),
        filename: `remote-check-${id}.${VIDEO_EXTENSIONS[video.mimeType] ?? "mp4"}`,
        contentType: video.mimeType,
        expiresInSeconds: DOWNLOAD_EXPIRY_SECONDS,
      });
      await writeAudit(
        prisma,
        {
          actorId: actor.userId,
          action: "purchase_check.video_viewed",
          targetType: "purchase_check",
          targetId: id,
          metadata: { evidenceId: video.id },
        },
        actor.fp,
      );
      return link;
    },

    /** The asset's open remote checks, for its owner; never names the buyers. */
    async remoteRequests(wbId: string, actor: Actor): Promise<RemoteRequestRecord[]> {
      const at = now();
      const asset = await prisma.asset.findUnique({ where: { wbId } });
      if (!asset || asset.ownerId !== actor.userId || asset.publishedAt === null) {
        throw notFound("Asset");
      }
      await expireDue(prisma, { assetId: asset.id, kind: "REMOTE" }, at);
      return prisma.purchaseCheck.findMany({
        where: { assetId: asset.id, kind: "REMOTE", status: "OPEN" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          captureSessions: { orderBy: latestSession.orderBy, take: 1, include: withEvidence },
        },
      });
    },

    /**
     * Starts the capture session in which the owner films the item for a remote check, with the
     * check's code and shots, or returns the open one. The session ends with the check at the
     * latest.
     */
    async startRemoteSession(
      wbId: string,
      checkId: string,
      actor: Actor,
    ): Promise<{ session: SessionRecord; created: boolean }> {
      const at = now();
      return prisma.$transaction(async (tx) => {
        const asset = await lockOwnedAsset(tx, wbId, actor);
        if (asset.status === "REVOKED") {
          throw new ApiError(409, "asset_revoked", "Evidence cannot be added to a revoked asset");
        }
        await tx.$queryRaw`SELECT 1 FROM "purchase_checks" WHERE "id" = ${checkId}::uuid FOR UPDATE`;
        const check = await tx.purchaseCheck.findUnique({ where: { id: checkId } });
        if (!check || check.assetId !== asset.id || check.kind !== "REMOTE") {
          throw notFound("Check");
        }
        if (check.status !== "OPEN" || check.photosCompletedAt !== null || check.expiresAt <= at) {
          throw checkClosed();
        }
        await tx.captureSession.updateMany({
          where: { assetId: asset.id, status: "OPEN", expiresAt: { lte: at } },
          data: { status: "EXPIRED", updatedAt: at },
        });
        const current = await tx.captureSession.findFirst({
          where: { purchaseCheckId: check.id, status: "OPEN" },
          include: withEvidence,
        });
        if (current) return { session: current, created: false };
        const session = await tx.captureSession.create({
          data: {
            assetId: asset.id,
            ownerId: actor.userId,
            purchaseCheckId: check.id,
            code: check.ownerCode,
            shots: check.shots,
            expiresAt: new Date(
              Math.min(at.getTime() + CAPTURE_SESSION_MINUTES * 60_000, check.expiresAt.getTime()),
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
            metadata: {
              captureSessionId: session.id,
              purchaseCheckId: check.id,
              shots: session.shots,
            },
          },
          actor.fp,
        );
        return { session, created: true };
      });
    },
  };
}

export type PurchaseCheckService = ReturnType<typeof createPurchaseCheckService>;
