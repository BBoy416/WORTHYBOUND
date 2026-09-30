import { createHash } from "node:crypto";
import {
  type Asset,
  type AssetStatus,
  isDatabaseError,
  type Prisma,
  type PrismaClient,
  type ProvenanceEventType,
} from "@worthybound/database";
import {
  ASSET_IDENTITY_FIELDS,
  ASSET_LIFECYCLE,
  assertTransition,
  canPublish,
  generateWbId,
  missingPublishFields,
  PUBLIC_PHOTO_MIME_TYPES,
  REQUEST_CANCELLING_ASSET_STATUSES,
} from "@worthybound/shared";
import { chainAddresses } from "@worthybound/solana";
import type {
  AssetConditionRequest,
  AssetStatusRequest,
  RegisterAssetInput,
  UpdateDraftAssetInput,
} from "@worthybound/validation";
import { type RequestFingerprint, writeAudit } from "../audit.js";
import { registerJobKey, TOKENIZABLE_STATUSES } from "../chain/sync.js";
import { ApiError, fromDomainError, notFound } from "../errors.js";
import { recordTrust } from "../trust/record.js";
import { closeRequestsAsSystem } from "../verification/requests.js";
import { serialFingerprint } from "./fingerprint.js";

type Tx = Prisma.TransactionClient;

export interface Actor {
  userId: string;
  fp: RequestFingerprint;
}

export interface AssetServiceOptions {
  prisma: PrismaClient;
  now: () => Date;
  serialFingerprintKey: string;
}

const REGISTER_SCOPE = "asset.register";
const UNIQUE_VIOLATION = "23505";
const WB_ID_ATTEMPTS = 5;

/**
 * Deliberately says nothing about serial numbers or other owners, so the response cannot be used
 * to look up which items are registered.
 */
const registrationRejected = () =>
  new ApiError(
    422,
    "registration_rejected",
    "This item can't be registered. If you believe this is a mistake, contact support.",
  );

/** Statuses the owner may set through the status endpoint; the lifecycle decides from where. */
export const OWNER_STATUS_TARGETS: readonly AssetStatus[] = [
  "REPORTED_LOST",
  "REPORTED_STOLEN",
  "REVERIFICATION_REQUIRED",
  "REVOKED",
];

function provenanceTypeFor(from: AssetStatus, to: AssetStatus): ProvenanceEventType {
  if (to === "REPORTED_LOST" || to === "REPORTED_STOLEN") return to;
  if (to === "REVERIFICATION_REQUIRED") {
    return from === "REPORTED_LOST" || from === "REPORTED_STOLEN"
      ? "RECOVERED"
      : "REVERIFICATION_REQUIRED";
  }
  return "STATUS_CHANGED";
}

const isUniqueViolation = (error: unknown) =>
  isDatabaseError(error, UNIQUE_VIOLATION) || (error as { code?: string })?.code === "P2002";

/** SHA-256 of the body with sorted keys, so key order does not matter. */
function requestHash(body: object): string {
  const canonical = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
        )
      : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical(body)))
    .digest("hex");
}

/** Discarded drafts are hidden from everyone, including their owner. */
const isDiscardedDraft = (asset: Asset) => asset.status === "REVOKED" && asset.publishedAt === null;

export function createAssetService({ prisma, now, serialFingerprintKey }: AssetServiceOptions) {
  const fingerprintOf = (asset: Pick<Asset, "category" | "brand" | "serialNumber">) =>
    asset.serialNumber
      ? serialFingerprint(serialFingerprintKey, { ...asset, serialNumber: asset.serialNumber })
      : { serialFingerprint: null, serialFingerprintKeyVersion: null };

  /** Another asset that is not REVOKED and has the same serial fingerprint. */
  const findConflict = (fingerprint: string | null, exceptId?: string) =>
    fingerprint
      ? prisma.asset.findFirst({
          where: {
            serialFingerprint: fingerprint,
            status: { not: "REVOKED" },
            ...(exceptId ? { id: { not: exceptId } } : {}),
          },
          select: { wbId: true },
        })
      : null;

  const block = async (
    actor: Actor,
    action: string,
    conflictingWbId: string,
    targetWbId: string | null,
  ) => {
    await writeAudit(
      prisma,
      {
        actorId: actor.userId,
        action,
        targetType: "asset",
        targetId: targetWbId,
        metadata: { reason: "duplicate_serial", conflictingWbId },
      },
      actor.fp,
    );
    return registrationRejected();
  };

  /** Locks the asset row for the rest of the transaction and returns it if the actor owns it. */
  async function lockOwned(tx: Tx, wbId: string, actor: Actor): Promise<Asset> {
    await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${wbId} FOR UPDATE`;
    const asset = await tx.asset.findUnique({ where: { wbId } });
    if (!asset || asset.ownerId !== actor.userId || isDiscardedDraft(asset)) {
      throw notFound("Asset");
    }
    return asset;
  }

  async function recordStatusChange(
    tx: Tx,
    asset: Asset,
    to: AssetStatus,
    actor: Actor,
    at: Date,
    reason?: string,
  ) {
    await tx.assetStatusEvent.create({
      data: {
        assetId: asset.id,
        fromStatus: asset.status,
        toStatus: to,
        reason: reason ?? null,
        actorId: actor.userId,
        createdAt: at,
      },
    });
    await tx.provenanceEvent.create({
      data: {
        assetId: asset.id,
        type: provenanceTypeFor(asset.status, to),
        actorId: actor.userId,
        occurredAt: at,
        payload: { fromStatus: asset.status, toStatus: to },
      },
    });
  }

  async function replay(actor: Actor, key: string, hash: string): Promise<Asset | null> {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_scope_key: { userId: actor.userId, scope: REGISTER_SCOPE, key } },
    });
    if (!existing) return null;
    if (existing.requestHash !== hash) {
      throw new ApiError(
        422,
        "idempotency_key_reused",
        "This Idempotency-Key was already used for a different request",
      );
    }
    return prisma.asset.findUniqueOrThrow({ where: { id: existing.resourceId } });
  }

  return {
    async get(wbId: string, actor: Actor): Promise<Asset> {
      const asset = await prisma.asset.findUnique({ where: { wbId } });
      if (!asset || asset.ownerId !== actor.userId || isDiscardedDraft(asset)) {
        throw notFound("Asset");
      }
      return asset;
    },

    /** The latest Trust Score snapshot, or null before the first one. */
    async trust(wbId: string, actor: Actor) {
      const asset = await this.get(wbId, actor);
      return prisma.trustScoreSnapshot.findFirst({
        where: { assetId: asset.id },
        orderBy: [{ computedAt: "desc" }, { id: "desc" }],
      });
    },

    /** Newest first. `cursor` is the last WB ID of the previous page. */
    async list(actor: Actor, limit: number, cursor?: string) {
      const items = await prisma.asset.findMany({
        where: { ownerId: actor.userId, NOT: { status: "REVOKED", publishedAt: null } },
        orderBy: { id: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { wbId: cursor }, skip: 1 } : {}),
      });
      const page = items.slice(0, limit);
      // One photo per asset for its thumbnail: the first public one, else the first private one.
      const photos = await prisma.evidence.findMany({
        where: {
          assetId: { in: page.map((a) => a.id) },
          type: "PHOTO",
          mimeType: { in: [...PUBLIC_PHOTO_MIME_TYPES] },
          reviewStatus: { not: "REJECTED" },
        },
        orderBy: [{ visibility: "desc" }, { createdAt: "asc" }, { id: "asc" }],
        distinct: ["assetId"],
        select: { id: true, assetId: true },
      });
      const thumbnails = new Map(photos.map((p) => [p.assetId, p.id]));
      return {
        items: page.map((asset) => ({
          asset,
          thumbnailEvidenceId: thumbnails.get(asset.id) ?? null,
        })),
        nextCursor: items.length > limit ? (page.at(-1)?.wbId ?? null) : null,
      };
    },

    /** Creates a private draft. Returns `replayed` when an Idempotency-Key matched. */
    async register(
      input: RegisterAssetInput,
      actor: Actor,
      idempotencyKey?: string,
    ): Promise<{ asset: Asset; replayed: boolean }> {
      const hash = requestHash(input);
      if (idempotencyKey) {
        const previous = await replay(actor, idempotencyKey, hash);
        if (previous) return { asset: previous, replayed: true };
      }

      const fingerprint = fingerprintOf({
        category: input.category,
        brand: input.brand ?? null,
        serialNumber: input.serialNumber ?? null,
      });
      const conflict = await findConflict(fingerprint.serialFingerprint);
      if (conflict) throw await block(actor, "asset.registration_blocked", conflict.wbId, null);

      for (let attempt = 1; ; attempt++) {
        const at = now();
        try {
          const asset = await prisma.$transaction(async (tx) => {
            const created = await tx.asset.create({
              data: {
                wbId: generateWbId(),
                ownerId: actor.userId,
                category: input.category,
                brand: input.brand ?? null,
                model: input.model ?? null,
                serialNumber: input.serialNumber ?? null,
                ...fingerprint,
                description: input.description ?? null,
                publicDescription: input.publicDescription ?? null,
                attributes: input.attributes ?? {},
                condition: input.condition ?? null,
                createdAt: at,
              },
            });
            await tx.ownership.create({
              data: {
                assetId: created.id,
                ownerId: actor.userId,
                reason: "REGISTRATION",
                startedAt: at,
              },
            });
            await tx.assetStatusEvent.create({
              data: {
                assetId: created.id,
                toStatus: "DRAFT",
                actorId: actor.userId,
                createdAt: at,
              },
            });
            await tx.provenanceEvent.create({
              data: {
                assetId: created.id,
                type: "REGISTERED",
                actorId: actor.userId,
                occurredAt: at,
                payload: { category: created.category },
              },
            });
            if (idempotencyKey) {
              await tx.idempotencyKey.create({
                data: {
                  userId: actor.userId,
                  scope: REGISTER_SCOPE,
                  key: idempotencyKey,
                  requestHash: hash,
                  resourceId: created.id,
                  createdAt: at,
                },
              });
            }
            await writeAudit(
              tx,
              {
                actorId: actor.userId,
                action: "asset.registered",
                targetType: "asset",
                targetId: created.wbId,
                metadata: { category: created.category, hasSerial: created.serialNumber !== null },
              },
              actor.fp,
            );
            return created;
          });
          return { asset, replayed: false };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // A concurrent request won: same Idempotency-Key, same item, or (rarely) the same WB ID.
          if (idempotencyKey) {
            const previous = await replay(actor, idempotencyKey, hash);
            if (previous) return { asset: previous, replayed: true };
          }
          const raced = await findConflict(fingerprint.serialFingerprint);
          if (raced) throw await block(actor, "asset.registration_blocked", raced.wbId, null);
          if (attempt >= WB_ID_ATTEMPTS) throw error;
        }
      }
    },

    /**
     * Drafts: every field. Published: identity fields are locked (also enforced by the database)
     * and the condition has its own endpoint so each change is recorded.
     */
    async update(wbId: string, input: UpdateDraftAssetInput, actor: Actor): Promise<Asset> {
      let conflictingWbId: string | null = null;
      const result = await prisma.$transaction(async (tx) => {
        const asset = await lockOwned(tx, wbId, actor);
        if (asset.status === "REVOKED") {
          throw new ApiError(409, "asset_revoked", "A revoked asset can no longer be changed");
        }
        const changed = (Object.keys(input) as (keyof UpdateDraftAssetInput)[]).filter(
          (field) => JSON.stringify(input[field]) !== JSON.stringify(asset[field]),
        );
        if (changed.length === 0) return asset;

        const published = asset.publishedAt !== null;
        if (published) {
          const locked = changed.filter((f) =>
            (ASSET_IDENTITY_FIELDS as readonly string[]).includes(f),
          );
          if (locked.length > 0) {
            throw new ApiError(
              409,
              "field_locked",
              `These fields cannot be changed after publishing: ${locked.join(", ")}`,
            );
          }
          if (changed.includes("condition")) {
            throw new ApiError(
              409,
              "use_condition_endpoint",
              "Update the condition of a published asset with POST /assets/:wbId/condition",
            );
          }
        }

        const next = {
          category: input.category ?? asset.category,
          brand: input.brand ?? asset.brand,
          serialNumber: input.serialNumber ?? asset.serialNumber,
        };
        const fingerprint = fingerprintOf(next);
        if (fingerprint.serialFingerprint !== asset.serialFingerprint) {
          const conflict = await findConflict(fingerprint.serialFingerprint, asset.id);
          if (conflict) {
            conflictingWbId = conflict.wbId;
            return null;
          }
        }

        const at = now();
        const updated = await tx.asset.update({
          where: { id: asset.id },
          data: {
            ...(Object.fromEntries(
              changed.map((field) => [field, input[field]]),
            ) as Prisma.AssetUncheckedUpdateInput),
            ...fingerprint,
            updatedAt: at,
          },
        });
        if (published && changed.includes("publicDescription")) {
          await tx.provenanceEvent.create({
            data: {
              assetId: asset.id,
              type: "DETAILS_UPDATED",
              actorId: actor.userId,
              occurredAt: at,
              payload: { fields: ["publicDescription"] },
            },
          });
        }
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "asset.updated",
            targetType: "asset",
            targetId: asset.wbId,
            metadata: { fields: changed },
          },
          actor.fp,
        );
        return updated;
      });
      if (conflictingWbId) throw await block(actor, "asset.update_blocked", conflictingWbId, wbId);
      return result as Asset;
    },

    async publish(wbId: string, actor: Actor): Promise<Asset> {
      return prisma.$transaction(async (tx) => {
        const asset = await lockOwned(tx, wbId, actor);
        if (!canPublish(asset.status, asset.publishedAt)) {
          throw new ApiError(409, "invalid_transition", "This asset cannot be published");
        }
        const missing = missingPublishFields(asset);
        if (missing.length > 0) {
          throw new ApiError(
            409,
            "publish_requirements_missing",
            `Add ${missing.join(" and ")} before publishing`,
          );
        }
        try {
          assertTransition(ASSET_LIFECYCLE, asset.status, "ACTIVE", "OWNER");
        } catch (error) {
          throw fromDomainError(error);
        }
        const at = now();
        await tx.asset.update({
          where: { id: asset.id },
          data: { status: "ACTIVE", publishedAt: at, updatedAt: at },
        });
        await recordStatusChange(tx, asset, "ACTIVE", actor, at);
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "asset.published",
            targetType: "asset",
            targetId: asset.wbId,
          },
          actor.fp,
        );
        await recordTrust(tx, asset.id, at);
        return tx.asset.findUniqueOrThrow({ where: { id: asset.id } });
      });
    },

    async changeStatus(wbId: string, input: AssetStatusRequest, actor: Actor): Promise<Asset> {
      return prisma.$transaction(async (tx) => {
        const asset = await lockOwned(tx, wbId, actor);
        if (!OWNER_STATUS_TARGETS.includes(input.toStatus)) {
          throw new ApiError(
            409,
            "forbidden_transition",
            input.toStatus === "ACTIVE" && asset.publishedAt === null
              ? "Use POST /assets/:wbId/publish to publish an asset"
              : `The owner cannot set the status ${input.toStatus}`,
          );
        }
        try {
          assertTransition(ASSET_LIFECYCLE, asset.status, input.toStatus, "OWNER");
        } catch (error) {
          throw fromDomainError(error);
        }
        const at = now();
        await tx.asset.update({
          where: { id: asset.id },
          data: { status: input.toStatus, updatedAt: at },
        });
        await recordStatusChange(tx, asset, input.toStatus, actor, at, input.reason);
        if (REQUEST_CANCELLING_ASSET_STATUSES.includes(input.toStatus)) {
          await closeRequestsAsSystem(
            tx,
            { assetId: asset.id },
            "CANCELLED",
            "asset_unavailable",
            at,
          );
        }
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "asset.status_changed",
            targetType: "asset",
            targetId: asset.wbId,
            metadata: { fromStatus: asset.status, toStatus: input.toStatus },
          },
          actor.fp,
        );
        await recordTrust(tx, asset.id, at);
        return tx.asset.findUniqueOrThrow({ where: { id: asset.id } });
      });
    },

    /**
     * Queues registration on-chain: a frozen token minted to the owner's wallet (ADR 0002,
     * ADR 0016). Needs a published asset and a verified identity (ADR 0004). Repeating the
     * request while pending changes nothing; after a failure it retries.
     */
    async tokenize(wbId: string, actor: Actor): Promise<Asset> {
      return prisma.$transaction(async (tx) => {
        const asset = await lockOwned(tx, wbId, actor);
        if (asset.tokenizationStatus === "TOKENIZED") {
          throw new ApiError(409, "already_tokenized", "This asset is already tokenized");
        }
        if (asset.tokenizationStatus === "PENDING") return asset;
        if (asset.publishedAt === null || !TOKENIZABLE_STATUSES.includes(asset.status)) {
          throw new ApiError(
            409,
            "not_tokenizable",
            "Only published assets that are active, verified or awaiting reverification can be tokenized",
          );
        }
        const owner = await tx.user.findUniqueOrThrow({
          where: { id: actor.userId },
          select: { identityStatus: true },
        });
        if (owner.identityStatus !== "VERIFIED") {
          throw new ApiError(
            403,
            "identity_verification_required",
            "Verify your identity before tokenizing an asset",
          );
        }
        const { record, coreAsset } = await chainAddresses(asset.wbId);
        const at = now();
        await tx.asset.update({
          where: { id: asset.id },
          data: {
            tokenizationStatus: "PENDING",
            chainRecordAddress: record,
            chainAssetAddress: coreAsset,
            updatedAt: at,
          },
        });
        await tx.chainTransaction.upsert({
          where: { idempotencyKey: registerJobKey(asset.id) },
          create: {
            idempotencyKey: registerJobKey(asset.id),
            kind: "REGISTER_ASSET",
            cluster: "DEVNET",
            entityType: "ASSET",
            entityId: asset.id,
          },
          update: { status: "PENDING", attempts: 0, lastError: null },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "asset.tokenization_requested",
            targetType: "asset",
            targetId: asset.wbId,
            metadata: { retry: asset.tokenizationStatus === "FAILED" },
          },
          actor.fp,
        );
        return tx.asset.findUniqueOrThrow({ where: { id: asset.id } });
      });
    },

    async updateCondition(
      wbId: string,
      input: AssetConditionRequest,
      actor: Actor,
    ): Promise<Asset> {
      return prisma.$transaction(async (tx) => {
        const asset = await lockOwned(tx, wbId, actor);
        if (asset.status === "REVOKED") {
          throw new ApiError(409, "asset_revoked", "A revoked asset can no longer be changed");
        }
        const at = now();
        const updated = await tx.asset.update({
          where: { id: asset.id },
          data: { condition: input.condition, updatedAt: at },
        });
        await tx.provenanceEvent.create({
          data: {
            assetId: asset.id,
            type: "CONDITION_UPDATED",
            actorId: actor.userId,
            occurredAt: at,
            payload: {
              fromCondition: asset.condition,
              condition: input.condition,
              ...(input.note ? { note: input.note } : {}),
            },
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "asset.condition_updated",
            targetType: "asset",
            targetId: asset.wbId,
            metadata: { fromCondition: asset.condition, condition: input.condition },
          },
          actor.fp,
        );
        return updated;
      });
    },
  };
}

export type AssetService = ReturnType<typeof createAssetService>;
