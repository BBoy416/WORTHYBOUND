import { randomUUID } from "node:crypto";
import type { Asset, Evidence, EvidenceUpload, Prisma, PrismaClient } from "@worthybound/database";
import {
  assertTransition,
  canBePublic,
  EVIDENCE_REVIEW_LIFECYCLE,
  hasPreview,
  MAX_EVIDENCE_PER_ASSET,
  MERKLE_ALGORITHM,
  merkleRoot,
  type PublicPhotoMimeType,
} from "@worthybound/shared";
import type { Storage } from "@worthybound/storage";
import type {
  EvidenceReviewInput,
  EvidenceUploadInput,
  EvidenceVisibilityRequest,
  VerifierEvidenceUploadInput,
} from "@worthybound/validation";
import { writeAudit } from "../audit.js";
import type { Actor } from "../assets/service.js";
import { ApiError, fromDomainError, notFound } from "../errors.js";
import { recordTrust } from "../trust/record.js";
import { findAssignedRequest, lockAssignedRequest } from "../verification/requests.js";
import { inspectFile, previewImage, publicPhotoCopy, readAll } from "./inspect.js";

type Tx = Prisma.TransactionClient;

export interface EvidenceServiceOptions {
  prisma: PrismaClient;
  storage: Storage;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export const STAGING_PREFIX = "staging/";
export const PREVIEW_PREFIX = "previews/";
const UPLOAD_EXPIRY_SECONDS = 15 * 60;
const DOWNLOAD_EXPIRY_SECONDS = 5 * 60;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** Reasons an uploaded file is refused. Stored on the upload and returned to the uploader. */
const REJECTIONS = {
  size_mismatch: "The uploaded file is not the declared size",
  file_type_mismatch: "The file's contents do not match its declared file type",
  hash_mismatch: "The file's SHA-256 hash does not match the declared hash",
  image_unreadable: "The photo could not be processed",
  duplicate_evidence: "This file is already attached to this asset",
  evidence_limit_reached: `An asset can have at most ${MAX_EVIDENCE_PER_ASSET} evidence files`,
  asset_unavailable: "Evidence can no longer be added to this asset",
  request_unavailable: "The verification request is no longer assigned to you",
} as const;
type Rejection = keyof typeof REJECTIONS;

class UploadRejected extends Error {
  constructor(readonly reason: Rejection) {
    super(REJECTIONS[reason]);
  }
}

const rejectionError = (reason: Rejection) =>
  reason === "duplicate_evidence" || reason === "evidence_limit_reached"
    ? new ApiError(409, reason, REJECTIONS[reason])
    : new ApiError(422, reason, REJECTIONS[reason]);

/** Discarded drafts are hidden from everyone, including their owner. */
const isDiscardedDraft = (asset: Asset) => asset.status === "REVOKED" && asset.publishedAt === null;

export function createEvidenceService({ prisma, storage, now, log }: EvidenceServiceOptions) {
  async function ownedAsset(db: Tx | PrismaClient, wbId: string, actor: Actor): Promise<Asset> {
    const asset = await db.asset.findUnique({ where: { wbId } });
    if (!asset || asset.ownerId !== actor.userId || isDiscardedDraft(asset)) {
      throw notFound("Asset");
    }
    return asset;
  }

  async function lockOwned(tx: Tx, wbId: string, actor: Actor): Promise<Asset> {
    await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${wbId} FOR UPDATE`;
    return ownedAsset(tx, wbId, actor);
  }

  /**
   * Locks the asset an upload adds to: the owner's asset, or for verifier uploads the asset of a
   * verification request that is still assigned to the uploader.
   */
  async function lockUploadTarget(
    tx: Tx,
    target: { wbId: string; requestId: string | null },
    actor: Actor,
  ): Promise<Asset> {
    if (!target.requestId) return lockOwned(tx, target.wbId, actor);
    return (await lockAssignedRequest(tx, target.requestId, actor.userId)).asset;
  }

  async function ownedEvidence(asset: Asset, evidenceId: string): Promise<Evidence> {
    const evidence = await prisma.evidence.findUnique({ where: { id: evidenceId } });
    if (!evidence || evidence.assetId !== asset.id) throw notFound("Evidence");
    return evidence;
  }

  /** Made from the private file on first request, then kept in storage. */
  async function previewOf(evidence: Evidence): Promise<Buffer> {
    if (!hasPreview(evidence.mimeType)) throw notFound("Preview");
    const key = `${PREVIEW_PREFIX}${evidence.assetId}/${evidence.id}.webp`;
    if (await storage.head(key)) return readAll(await storage.read(key));
    const image = await previewImage(await readAll(await storage.read(evidence.storageKey)));
    await storage.put(key, image, "image/webp");
    return image;
  }

  /** Best effort: the bucket's clean-up rule removes anything left in the holding area. */
  async function removeQuietly(...keys: (string | null)[]) {
    for (const key of keys) {
      if (!key) continue;
      try {
        await storage.remove(key);
      } catch (error) {
        log.warn({ err: error }, "could not remove stored file");
      }
    }
  }

  /**
   * A new seal over every evidence file of the asset in the order they were added: the previous
   * seal's files followed by the new one. Runs while the asset row is locked.
   */
  async function seal(tx: Tx, assetId: string, added: { id: string; sha256: string }, at: Date) {
    const previous = await tx.evidenceCommitment.findFirst({
      where: { assetId },
      orderBy: [{ evidenceCount: "desc" }, { createdAt: "desc" }],
      include: { items: { orderBy: { leafIndex: "asc" } } },
    });
    const all = [
      ...(previous?.items ?? []).map((item) => ({ id: item.evidenceId, sha256: item.sha256 })),
      added,
    ];
    const commitment = await tx.evidenceCommitment.create({
      data: {
        assetId,
        merkleRoot: await merkleRoot(all.map((e) => e.sha256)),
        algorithm: MERKLE_ALGORITHM,
        evidenceCount: all.length,
        createdAt: at,
      },
    });
    await tx.evidenceCommitmentItem.createMany({
      data: all.map((e, leafIndex) => ({
        commitmentId: commitment.id,
        leafIndex,
        evidenceId: e.id,
        sha256: e.sha256,
      })),
    });
    return commitment;
  }

  async function fail(upload: EvidenceUpload, reason: Rejection, actor: Actor) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.evidenceUpload.updateMany({
        where: { id: upload.id, status: "PENDING" },
        data: { status: "FAILED", failureReason: reason, completedAt: now() },
      });
      if (count === 0) return;
      await writeAudit(
        tx,
        {
          actorId: actor.userId,
          action: "evidence.upload_rejected",
          targetType: "evidence_upload",
          targetId: upload.id,
          metadata: { reason },
        },
        actor.fp,
      );
    });
    return rejectionError(reason);
  }

  async function completedResult(uploadId: string) {
    const done = await prisma.evidenceUpload.findUniqueOrThrow({
      where: { id: uploadId },
      include: { evidence: true, asset: { select: { wbId: true } } },
    });
    return { evidence: done.evidence as Evidence, wbId: done.asset.wbId, replayed: true };
  }

  /** Evidence of the asset in the order the files were added, as in the latest seal. */
  async function inSealOrder(assetId: string): Promise<Evidence[]> {
    const [items, latest] = await Promise.all([
      prisma.evidence.findMany({ where: { assetId } }),
      prisma.evidenceCommitment.findFirst({
        where: { assetId },
        orderBy: [{ evidenceCount: "desc" }, { createdAt: "desc" }],
        include: { items: { select: { evidenceId: true, leafIndex: true } } },
      }),
    ]);
    const position = new Map(latest?.items.map((i) => [i.evidenceId, i.leafIndex]));
    const at = (e: Evidence) => position.get(e.id) ?? Number.MAX_SAFE_INTEGER;
    return items.sort((a, b) => at(a) - at(b));
  }

  async function downloadLink(
    evidence: Evidence,
    wbId: string,
    actor: Actor,
    verificationRequestId: string | null,
  ) {
    const link = await storage.presignDownload({
      key: evidence.storageKey,
      filename: evidence.originalFilename ?? `${evidence.id}.${EXTENSIONS[evidence.mimeType]}`,
      contentType: evidence.mimeType,
      expiresInSeconds: DOWNLOAD_EXPIRY_SECONDS,
    });
    await writeAudit(
      prisma,
      {
        actorId: actor.userId,
        action: "evidence.downloaded",
        targetType: "asset",
        targetId: wbId,
        metadata: {
          evidenceId: evidence.id,
          ...(verificationRequestId ? { verificationRequestId } : {}),
        },
      },
      actor.fp,
    );
    return link;
  }

  async function startUpload(
    target: { wbId: string; requestId: string | null },
    input: EvidenceUploadInput,
    actor: Actor,
  ) {
    const at = now();
    const upload = await prisma.$transaction(async (tx) => {
      const asset = await lockUploadTarget(tx, target, actor);
      if (asset.status === "REVOKED") {
        throw new ApiError(409, "asset_revoked", "Evidence cannot be added to a revoked asset");
      }
      const [stored, pending] = await Promise.all([
        tx.evidence.count({ where: { assetId: asset.id } }),
        tx.evidenceUpload.count({
          where: { assetId: asset.id, status: "PENDING", expiresAt: { gt: at } },
        }),
      ]);
      if (stored + pending >= MAX_EVIDENCE_PER_ASSET) {
        throw rejectionError("evidence_limit_reached");
      }
      const existing = await tx.evidence.findUnique({
        where: { assetId_sha256: { assetId: asset.id, sha256: input.sha256 } },
        select: { id: true },
      });
      if (existing) throw rejectionError("duplicate_evidence");

      const id = randomUUID();
      const created = await tx.evidenceUpload.create({
        data: {
          id,
          assetId: asset.id,
          uploaderId: actor.userId,
          type: input.type,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          visibility: input.visibility,
          originalFilename: input.originalFilename ?? null,
          description: input.description ?? null,
          capturedAt: input.capturedAt ?? null,
          verificationRequestId: target.requestId,
          stagingKey: `${STAGING_PREFIX}${id}`,
          expiresAt: new Date(at.getTime() + UPLOAD_EXPIRY_SECONDS * 1000),
          createdAt: at,
        },
      });
      await writeAudit(
        tx,
        {
          actorId: actor.userId,
          action: "evidence.upload_requested",
          targetType: "asset",
          targetId: asset.wbId,
          metadata: {
            uploadId: id,
            ...(target.requestId ? { verificationRequestId: target.requestId } : {}),
            type: input.type,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
          },
        },
        actor.fp,
      );
      return created;
    });
    const form = await storage.presignUpload({
      key: upload.stagingKey,
      contentType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      expiresInSeconds: UPLOAD_EXPIRY_SECONDS,
    });
    return { upload, form };
  }

  return {
    /** In the order the files were added, as in the latest seal. */
    async list(wbId: string, actor: Actor) {
      const asset = await ownedAsset(prisma, wbId, actor);
      return { asset, items: await inSealOrder(asset.id) };
    },

    /** The asset's evidence, for the verifier assigned to a request. */
    async listForRequest(requestId: string, actor: Actor) {
      const request = await findAssignedRequest(prisma, requestId, actor.userId);
      return { asset: request.asset, items: await inSealOrder(request.assetId) };
    },

    async previewForRequest(requestId: string, evidenceId: string, actor: Actor) {
      const request = await findAssignedRequest(prisma, requestId, actor.userId);
      return previewOf(await ownedEvidence(request.asset, evidenceId));
    },

    async downloadForRequest(requestId: string, evidenceId: string, actor: Actor) {
      const request = await findAssignedRequest(prisma, requestId, actor.userId);
      const evidence = await ownedEvidence(request.asset, evidenceId);
      return downloadLink(evidence, request.asset.wbId, actor, requestId);
    },

    /**
     * The assigned verifier accepts or rejects an evidence item of the asset, once. Verifiers do
     * not review their own uploads.
     */
    async review(requestId: string, evidenceId: string, input: EvidenceReviewInput, actor: Actor) {
      return prisma.$transaction(async (tx) => {
        const { asset } = await lockAssignedRequest(tx, requestId, actor.userId);
        await tx.$queryRaw`SELECT 1 FROM "evidence" WHERE "id" = ${evidenceId}::uuid FOR UPDATE`;
        const evidence = await tx.evidence.findUnique({ where: { id: evidenceId } });
        if (!evidence || evidence.assetId !== asset.id) throw notFound("Evidence");
        if (evidence.uploaderId === actor.userId) {
          throw new ApiError(403, "self_review", "You cannot review evidence you uploaded");
        }
        try {
          assertTransition(
            EVIDENCE_REVIEW_LIFECYCLE,
            evidence.reviewStatus,
            input.status,
            "VERIFIER",
          );
        } catch (error) {
          throw fromDomainError(error);
        }
        const at = now();
        const updated = await tx.evidence.update({
          where: { id: evidenceId },
          data: {
            reviewStatus: input.status,
            reviewedById: actor.userId,
            reviewedAt: at,
            reviewReason: input.reason ?? null,
            updatedAt: at,
          },
        });
        await tx.provenanceEvent.create({
          data: {
            assetId: asset.id,
            type: "EVIDENCE_REVIEWED",
            actorId: actor.userId,
            occurredAt: at,
            payload: { evidenceId, reviewStatus: input.status },
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "evidence.reviewed",
            targetType: "asset",
            targetId: asset.wbId,
            metadata: { evidenceId, reviewStatus: input.status, verificationRequestId: requestId },
          },
          actor.fp,
        );
        await recordTrust(tx, asset.id, at);
        return { evidence: updated, wbId: asset.wbId };
      });
    },

    /** Records the request and returns a one-time upload URL for the holding area. */
    requestUpload(wbId: string, input: EvidenceUploadInput, actor: Actor) {
      return startUpload({ wbId, requestId: null }, input, actor);
    },

    /** An upload by the verifier assigned to a request; verifier evidence starts private. */
    requestVerifierUpload(requestId: string, input: VerifierEvidenceUploadInput, actor: Actor) {
      return startUpload({ wbId: "", requestId }, { ...input, visibility: "PRIVATE" }, actor);
    },

    /**
     * Checks the uploaded file and, if it is what was declared, stores it as evidence. The file
     * is first copied to a key only the server can write, and every check runs on that copy, so
     * it cannot be swapped between checking and storing. Safe to retry.
     */
    async complete(
      uploadId: string,
      actor: Actor,
    ): Promise<{ evidence: Evidence; wbId: string; replayed: boolean }> {
      const upload = await prisma.evidenceUpload.findUnique({
        where: { id: uploadId },
        include: { asset: true },
      });
      if (!upload || upload.uploaderId !== actor.userId || isDiscardedDraft(upload.asset)) {
        throw notFound("Upload");
      }
      if (upload.status === "COMPLETED") return completedResult(upload.id);
      if (upload.status === "FAILED") {
        const reason = upload.failureReason as Rejection | "expired";
        throw reason === "expired"
          ? new ApiError(409, "upload_expired", "This upload has expired; request a new one")
          : rejectionError(reason);
      }
      if (now() > upload.expiresAt) {
        await prisma.evidenceUpload.updateMany({
          where: { id: upload.id, status: "PENDING" },
          data: { status: "FAILED", failureReason: "expired", completedAt: now() },
        });
        await removeQuietly(upload.stagingKey);
        throw new ApiError(409, "upload_expired", "This upload has expired; request a new one");
      }

      const staged = await storage.head(upload.stagingKey);
      if (!staged) {
        const current = await prisma.evidenceUpload.findUniqueOrThrow({ where: { id: upload.id } });
        if (current.status === "COMPLETED") return completedResult(upload.id);
        throw new ApiError(409, "upload_missing", "The file has not been uploaded yet");
      }
      if (staged.sizeBytes !== upload.sizeBytes) {
        await removeQuietly(upload.stagingKey);
        throw await fail(upload, "size_mismatch", actor);
      }

      const evidenceId = randomUUID();
      const storageKey = `evidence/${upload.assetId}/${evidenceId}`;
      const wantsPublic = upload.visibility === "PUBLIC";
      const publicKey = wantsPublic ? `public/${upload.assetId}/${evidenceId}` : null;
      try {
        await storage.copy(upload.stagingKey, storageKey, staged.etag ?? undefined);
      } catch (error) {
        // The staged file changed after it was inspected; the client may upload again.
        log.warn({ err: error }, "could not copy uploaded file");
        throw new ApiError(409, "upload_changed", "The file changed while it was being checked");
      }
      await removeQuietly(upload.stagingKey);

      try {
        const file = await inspectFile(await storage.read(storageKey), wantsPublic);
        if (file.sizeBytes !== upload.sizeBytes) throw new UploadRejected("size_mismatch");
        if (file.detectedMimeType !== upload.mimeType) {
          throw new UploadRejected("file_type_mismatch");
        }
        if (file.sha256 !== upload.sha256) throw new UploadRejected("hash_mismatch");
        if (publicKey) {
          const copy = await publicPhotoCopy(
            file.bytes as Buffer,
            upload.mimeType as PublicPhotoMimeType,
          ).catch(() => {
            throw new UploadRejected("image_unreadable");
          });
          await storage.put(publicKey, copy, upload.mimeType);
        }

        const at = now();
        const result = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "evidence_uploads" WHERE "id" = ${upload.id}::uuid FOR UPDATE`;
          const current = await tx.evidenceUpload.findUniqueOrThrow({ where: { id: upload.id } });
          if (current.status !== "PENDING") return null;

          let asset: Asset;
          try {
            asset = await lockUploadTarget(
              tx,
              { wbId: upload.asset.wbId, requestId: upload.verificationRequestId },
              actor,
            );
          } catch {
            throw new UploadRejected(
              upload.verificationRequestId ? "request_unavailable" : "asset_unavailable",
            );
          }
          if (asset.status === "REVOKED") throw new UploadRejected("asset_unavailable");
          if (
            (await tx.evidence.count({ where: { assetId: asset.id } })) >= MAX_EVIDENCE_PER_ASSET
          ) {
            throw new UploadRejected("evidence_limit_reached");
          }
          const sameAsset = await tx.evidence.findUnique({
            where: { assetId_sha256: { assetId: asset.id, sha256: file.sha256 } },
            select: { id: true },
          });
          if (sameAsset) throw new UploadRejected("duplicate_evidence");
          const elsewhere = await tx.evidence.findFirst({
            where: { sha256: file.sha256, assetId: { not: asset.id } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, asset: { select: { wbId: true } } },
          });

          const evidence = await tx.evidence.create({
            data: {
              id: evidenceId,
              assetId: asset.id,
              uploaderId: actor.userId,
              type: upload.type,
              source: upload.verificationRequestId ? "VERIFIER" : "OWNER",
              verificationRequestId: upload.verificationRequestId,
              storageKey,
              publicStorageKey: publicKey,
              sha256: file.sha256,
              mimeType: upload.mimeType,
              sizeBytes: upload.sizeBytes,
              visibility: upload.visibility,
              originalFilename: upload.originalFilename,
              description: upload.description,
              capturedAt: upload.capturedAt,
              duplicateOfId: elsewhere?.id ?? null,
              createdAt: at,
            },
          });
          await tx.evidenceUpload.update({
            where: { id: upload.id },
            data: { status: "COMPLETED", evidenceId, completedAt: at },
          });
          await tx.provenanceEvent.create({
            data: {
              assetId: asset.id,
              type: "EVIDENCE_ADDED",
              actorId: actor.userId,
              occurredAt: at,
              payload: {
                evidenceId,
                type: upload.type,
                sha256: file.sha256,
                source: upload.verificationRequestId ? "VERIFIER" : "OWNER",
              },
            },
          });
          const commitment = await seal(tx, asset.id, evidence, at);
          await writeAudit(
            tx,
            {
              actorId: actor.userId,
              action: "evidence.added",
              targetType: "asset",
              targetId: asset.wbId,
              metadata: {
                evidenceId,
                type: upload.type,
                visibility: upload.visibility,
                merkleRoot: commitment.merkleRoot,
                ...(upload.verificationRequestId
                  ? { verificationRequestId: upload.verificationRequestId }
                  : {}),
              },
            },
            actor.fp,
          );
          if (elsewhere) {
            await writeAudit(
              tx,
              {
                actorId: actor.userId,
                action: "evidence.duplicate_flagged",
                targetType: "asset",
                targetId: asset.wbId,
                metadata: {
                  evidenceId,
                  duplicateOfEvidenceId: elsewhere.id,
                  duplicateOfWbId: elsewhere.asset.wbId,
                },
              },
              actor.fp,
            );
          }
          await recordTrust(tx, asset.id, at);
          return { evidence, wbId: asset.wbId };
        });
        if (!result) {
          await removeQuietly(storageKey, publicKey);
          return completedResult(upload.id);
        }
        return { ...result, replayed: false };
      } catch (error) {
        await removeQuietly(storageKey, publicKey);
        if (error instanceof UploadRejected) throw await fail(upload, error.reason, actor);
        throw error;
      }
    },

    async preview(wbId: string, evidenceId: string, actor: Actor) {
      const asset = await ownedAsset(prisma, wbId, actor);
      return previewOf(await ownedEvidence(asset, evidenceId));
    },

    async download(wbId: string, evidenceId: string, actor: Actor) {
      const asset = await ownedAsset(prisma, wbId, actor);
      const evidence = await ownedEvidence(asset, evidenceId);
      return downloadLink(evidence, asset.wbId, actor, null);
    },

    /** Public photos get a metadata-free copy; making a photo private again removes it. */
    async changeVisibility(
      wbId: string,
      evidenceId: string,
      input: EvidenceVisibilityRequest,
      actor: Actor,
    ): Promise<{ evidence: Evidence; wbId: string }> {
      const asset = await ownedAsset(prisma, wbId, actor);
      const evidence = await ownedEvidence(asset, evidenceId);
      if (evidence.visibility === input.visibility) return { evidence, wbId };
      const toPublic = input.visibility === "PUBLIC";
      if (toPublic) {
        if (asset.status === "REVOKED") {
          throw new ApiError(
            409,
            "asset_revoked",
            "Evidence of a revoked asset cannot be made public",
          );
        }
        if (!canBePublic(evidence.type, evidence.mimeType)) {
          throw new ApiError(
            409,
            "cannot_be_public",
            "Only JPEG, PNG or WebP photos can be public",
          );
        }
      }

      let publicKey: string | null = null;
      if (toPublic) {
        const file = await inspectFile(await storage.read(evidence.storageKey), true);
        if (file.sha256 !== evidence.sha256) {
          log.warn({ evidenceId }, "stored evidence does not match its hash");
          throw new ApiError(500, "internal_error", "Internal server error");
        }
        publicKey = `public/${evidence.assetId}/${evidence.id}-${randomUUID()}`;
        const copy = await publicPhotoCopy(
          file.bytes as Buffer,
          evidence.mimeType as PublicPhotoMimeType,
        );
        await storage.put(publicKey, copy, evidence.mimeType);
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const locked = await lockOwned(tx, wbId, actor);
          const current = await tx.evidence.findUniqueOrThrow({ where: { id: evidence.id } });
          if (current.visibility === input.visibility) return { updated: current, previous: null };
          const at = now();
          const updated = await tx.evidence.update({
            where: { id: evidence.id },
            data: { visibility: input.visibility, publicStorageKey: publicKey, updatedAt: at },
          });
          await tx.provenanceEvent.create({
            data: {
              assetId: locked.id,
              type: "EVIDENCE_VISIBILITY_CHANGED",
              actorId: actor.userId,
              occurredAt: at,
              payload: { evidenceId: evidence.id, visibility: input.visibility },
            },
          });
          await writeAudit(
            tx,
            {
              actorId: actor.userId,
              action: "evidence.visibility_changed",
              targetType: "asset",
              targetId: locked.wbId,
              metadata: { evidenceId: evidence.id, visibility: input.visibility },
            },
            actor.fp,
          );
          return { updated, previous: current.publicStorageKey };
        });
        if (result.previous) await removeQuietly(result.previous);
        if (result.updated.publicStorageKey !== publicKey) await removeQuietly(publicKey);
        return { evidence: result.updated, wbId };
      } catch (error) {
        await removeQuietly(publicKey);
        throw error;
      }
    },

    /** A public photo of a published passport, or null. Same answer for every kind of miss. */
    async publicPhoto(wbId: string, evidenceId: string) {
      const evidence = await prisma.evidence.findFirst({
        where: {
          id: evidenceId,
          visibility: "PUBLIC",
          reviewStatus: { not: "REJECTED" },
          asset: { wbId, publishedAt: { not: null } },
        },
        select: { publicStorageKey: true, mimeType: true, asset: { select: { status: true } } },
      });
      if (!evidence?.publicStorageKey) return null;
      return {
        status: evidence.asset.status,
        mimeType: evidence.mimeType,
        extension: EXTENSIONS[evidence.mimeType] as string,
        stream: await storage.read(evidence.publicStorageKey),
      };
    },
  };
}

export type EvidenceService = ReturnType<typeof createEvidenceService>;
