import { createHash, randomUUID } from "node:crypto";
import { CHECK_VERSION } from "@worthybound/automated-checks";
import type { Evidence, Prisma, PrismaClient } from "@worthybound/database";
import {
  CAPTURE_CODE_SHOT,
  type CaptureShot,
  type ItemMatchReason,
  MAX_REFERENCE_PHOTOS,
  OWNER_CODE_MINUTES,
  ownerConfirmationMessage,
  PURCHASE_CHECK_MINUTES,
  PURCHASE_CHECKS_PER_ASSET_PER_DAY,
  PURCHASE_CHECKS_PER_BUYER_PER_DAY,
  purchaseCheckShots,
} from "@worthybound/shared";
import type { Storage } from "@worthybound/storage";
import type { OwnerConfirmationInput } from "@worthybound/validation";
import { fileTypeFromBuffer } from "file-type";
import type { Actor } from "../assets/service.js";
import { writeAudit } from "../audit.js";
import { verifyWalletSignature } from "../auth/siws.js";
import { captureCode } from "../capture/service.js";
import type { AutomatedChecks } from "../checks/worker.js";
import { decodeBase58 } from "../crypto.js";
import { ApiError, notFound } from "../errors.js";
import { checkImage } from "../evidence/inspect.js";
import type { CheckRecord } from "./view.js";

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

const DAY_MS = 24 * 60 * 60_000;
export const PURCHASE_CHECK_PREFIX = "purchase-checks/";
/** Largest photo accepted from the camera. */
export const MAX_CHECK_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

const withPhotos = {
  asset: true,
  photos: { select: { shot: true, createdAt: true } },
} satisfies Prisma.PurchaseCheckInclude;

const checkClosed = () =>
  new ApiError(409, "purchase_check_closed", "This check has ended; start a new one");

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
    db.captureSession.findFirst({
      where: { assetId, status: "COMPLETED" },
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

  /** The check with the recorded photos it can show, for the view. */
  async function withRecorded(check: CheckRecord) {
    const recorded =
      check.referenceEvidenceIds.length === 0
        ? []
        : await prisma.evidence.findMany({
            where: { id: { in: check.referenceEvidenceIds } },
            select: { id: true, publicStorageKey: true },
          });
    return { check, recorded };
  }

  async function removeQuietly(key: string) {
    try {
      await storage.remove(key);
    } catch (error) {
      log.warn({ err: error }, "could not remove stored file");
    }
  }

  return {
    /**
     * Starts a check of a published item, or returns the buyer's open one. Checks are limited per
     * buyer and per item per day, so they cannot be used to probe other people's items.
     */
    async start(wbId: string, actor: Actor) {
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
        const open = await tx.purchaseCheck.findFirst({
          where: { assetId: asset.id, buyerId: actor.userId, status: "OPEN" },
          orderBy: { createdAt: "desc" },
          include: withPhotos,
        });
        if (open) return { check: open, created: false };

        const since = new Date(at.getTime() - DAY_MS);
        const [forBuyer, forAsset] = await Promise.all([
          tx.purchaseCheck.count({ where: { buyerId: actor.userId, createdAt: { gt: since } } }),
          tx.purchaseCheck.count({ where: { assetId: asset.id, createdAt: { gt: since } } }),
        ]);
        if (
          forBuyer >= PURCHASE_CHECKS_PER_BUYER_PER_DAY ||
          forAsset >= PURCHASE_CHECKS_PER_ASSET_PER_DAY
        ) {
          throw new ApiError(
            429,
            "purchase_check_limit_reached",
            "Too many checks were started today; try again tomorrow",
          );
        }
        const check = await tx.purchaseCheck.create({
          data: {
            assetId: asset.id,
            buyerId: actor.userId,
            ownerCode: captureCode(),
            ownerCodeExpiresAt: new Date(at.getTime() + OWNER_CODE_MINUTES * 60_000),
            shots: purchaseCheckShots(asset.category),
            expiresAt: new Date(at.getTime() + PURCHASE_CHECK_MINUTES * 60_000),
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
            metadata: { purchaseCheckId: check.id },
          },
          actor.fp,
        );
        return { check, created: true };
      });
      return { ...(await withRecorded(result.check)), created: result.created };
    },

    async get(id: string, actor: Actor) {
      await expireDue(prisma, { id, buyerId: actor.userId }, now());
      return withRecorded(await buyersCheck(prisma, id, actor));
    },

    /** A new code for the seller, while the owner has not confirmed yet. */
    async newOwnerCode(id: string, actor: Actor) {
      const at = now();
      const check = await prisma.$transaction(async (tx) => {
        const current = await lockCheck(tx, id, actor);
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
     * Stores a photo the buyer took with the app's camera, without its metadata. The last photo
     * queues the comparison with the recorded photos.
     */
    async addPhoto(id: string, shot: CaptureShot, body: Buffer, actor: Actor) {
      const at = now();
      const assertOpen = (check: CheckRecord) => {
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
  };
}

export type PurchaseCheckService = ReturnType<typeof createPurchaseCheckService>;
