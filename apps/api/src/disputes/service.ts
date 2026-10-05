import {
  type AssetStatus,
  type Dispute,
  type DisputeStatus,
  isDatabaseError,
  type Prisma,
  type PrismaClient,
} from "@worthybound/database";
import {
  ASSET_LIFECYCLE,
  ATTESTATION_LIFECYCLE,
  assertTransition,
  DISPUTE_LIFECYCLE,
  type DisputeActor,
  type Lifecycle,
  REQUEST_CANCELLING_ASSET_STATUSES,
} from "@worthybound/shared";
import type {
  OpenDisputeInput,
  ResolveDisputeInput,
  ReviewDisputeInput,
} from "@worthybound/validation";
import type { Actor } from "../assets/service.js";
import { writeAudit } from "../audit.js";
import { ApiError, fromDomainError, notFound } from "../errors.js";
import { cancelOpenTransfer, lockAsset } from "../transfers/service.js";
import { recordTrust } from "../trust/record.js";
import { closeRequestsAsSystem } from "../verification/requests.js";
import { adminDisputeInclude, disputeInclude, OPEN_DISPUTE_STATUSES } from "./view.js";

type Tx = Prisma.TransactionClient;

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown) =>
  isDatabaseError(error, UNIQUE_VIOLATION) || (error as { code?: string })?.code === "P2002";

/** Statuses an asset can be put on hold from; the asset returns to one of them afterwards. */
const HOLDABLE_STATUSES: readonly AssetStatus[] = [
  "ACTIVE",
  "VERIFIED",
  "REVERIFICATION_REQUIRED",
  "TRANSFER_PENDING",
];

function transition<S extends string, A extends string>(
  lifecycle: Lifecycle<S, A>,
  from: S,
  to: S,
  actor: A,
) {
  try {
    assertTransition(lifecycle, from, to, actor);
  } catch (error) {
    throw fromDomainError(error);
  }
}

/** Records an asset status change made by a dispute decision, with its provenance event. */
async function changeAssetStatus(
  tx: Tx,
  assetId: string,
  from: AssetStatus,
  to: AssetStatus,
  reason: string,
  actorId: string,
  at: Date,
) {
  transition(ASSET_LIFECYCLE, from, to, "ADMIN");
  await tx.asset.update({ where: { id: assetId }, data: { status: to, updatedAt: at } });
  await tx.assetStatusEvent.create({
    data: { assetId, fromStatus: from, toStatus: to, reason, actorId, createdAt: at },
  });
  await tx.provenanceEvent.create({
    data: {
      assetId,
      type: to === "REVERIFICATION_REQUIRED" ? "REVERIFICATION_REQUIRED" : "STATUS_CHANGED",
      actorId,
      occurredAt: at,
      payload: { fromStatus: from, toStatus: to },
    },
  });
}

/** Locks the dispute's asset and returns the dispute as it is now. */
async function lockDispute(tx: Tx, id: string): Promise<Dispute> {
  const found = await tx.dispute.findUnique({ where: { id }, select: { assetId: true } });
  if (!found) throw notFound("Dispute");
  await lockAsset(tx, found.assetId);
  return tx.dispute.findUniqueOrThrow({ where: { id } });
}

export interface DisputeServiceOptions {
  prisma: PrismaClient;
  now: () => Date;
}

/**
 * Disputes about an asset, one of its attestations or one of its evidence items (ADR 0017).
 * Anyone with a verified identity can open one; administrators review and decide.
 */
export function createDisputeService({ prisma, now }: DisputeServiceOptions) {
  const load = (id: string) =>
    prisma.dispute.findUniqueOrThrow({ where: { id }, include: disputeInclude });
  const loadAdmin = (id: string) =>
    prisma.dispute.findUniqueOrThrow({ where: { id }, include: adminDisputeInclude });

  async function close(
    tx: Tx,
    dispute: Dispute,
    to: Extract<DisputeStatus, "UPHELD" | "REJECTED" | "WITHDRAWN">,
    by: DisputeActor,
    actor: Actor,
    at: Date,
    resolution: string | null,
  ) {
    transition(DISPUTE_LIFECYCLE, dispute.status, to, by);
    await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: to,
        resolvedAt: at,
        resolvedById: by === "ADMIN" ? actor.userId : null,
        resolution,
        updatedAt: at,
      },
    });
    await tx.provenanceEvent.create({
      data: {
        assetId: dispute.assetId,
        type: "DISPUTE_RESOLVED",
        actorId: actor.userId,
        occurredAt: at,
        payload: { disputeId: dispute.id, outcome: to },
      },
    });
    await writeAudit(
      tx,
      {
        actorId: actor.userId,
        action: "dispute.closed",
        targetType: "dispute",
        targetId: dispute.id,
        metadata: { fromStatus: dispute.status, toStatus: to },
      },
      actor.fp,
    );
  }

  return {
    /**
     * Opens a dispute. The asset must be published and not revoked; an attestation must still
     * count (active, expired or already disputed); evidence must be public, or the caller's own
     * asset's. One open dispute per person and target.
     */
    async open(input: OpenDisputeInput, actor: Actor) {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { identityStatus: true },
      });
      if (user.identityStatus !== "VERIFIED") {
        throw new ApiError(
          403,
          "identity_verification_required",
          "Verify your identity before opening a dispute",
        );
      }
      const at = now();
      const id = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${input.assetId} FOR UPDATE`;
        const asset = await tx.asset.findUnique({
          where: { wbId: input.assetId },
          select: { id: true, ownerId: true, status: true, publishedAt: true },
        });
        if (!asset?.publishedAt) throw notFound("Asset");
        if (asset.status === "REVOKED") {
          throw new ApiError(409, "not_disputable", "This passport has been revoked");
        }
        let verifierId: string | null = null;
        if (input.attestationId) {
          const attestation = await tx.attestation.findFirst({
            where: { id: input.attestationId, assetId: asset.id },
            select: { status: true, verifierId: true },
          });
          if (!attestation) throw notFound("Attestation");
          if (!["ACTIVE", "EXPIRED", "DISPUTED"].includes(attestation.status)) {
            throw new ApiError(
              409,
              "not_disputable",
              "This attestation has been revoked or replaced and no longer counts",
            );
          }
          verifierId = attestation.verifierId;
        }
        if (input.evidenceId) {
          const evidence = await tx.evidence.findFirst({
            where: {
              id: input.evidenceId,
              assetId: asset.id,
              reviewStatus: { not: "REJECTED" },
              ...(asset.ownerId === actor.userId ? {} : { visibility: "PUBLIC" }),
            },
            select: { id: true },
          });
          if (!evidence) throw notFound("Evidence");
        }
        let dispute: Dispute;
        try {
          dispute = await tx.dispute.create({
            data: {
              assetId: asset.id,
              attestationId: input.attestationId ?? null,
              evidenceId: input.evidenceId ?? null,
              openedById: actor.userId,
              reason: input.reason,
              details: input.details ?? null,
              createdAt: at,
            },
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          throw new ApiError(
            409,
            "dispute_open",
            "You already have an open dispute about this; wait for the decision",
          );
        }
        if (verifierId) {
          await tx.verifier.update({
            where: { id: verifierId },
            data: { disputeCount: { increment: 1 } },
          });
        }
        const target = input.attestationId
          ? "ATTESTATION"
          : input.evidenceId
            ? "EVIDENCE"
            : "ASSET";
        await tx.provenanceEvent.create({
          data: {
            assetId: asset.id,
            type: "DISPUTE_OPENED",
            actorId: actor.userId,
            occurredAt: at,
            payload: { disputeId: dispute.id, target },
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "dispute.opened",
            targetType: "dispute",
            targetId: dispute.id,
            metadata: { wbId: input.assetId, target },
          },
          actor.fp,
        );
        await recordTrust(tx, asset.id, at);
        return dispute.id;
      });
      return load(id);
    },

    async listMine(actor: Actor) {
      return prisma.dispute.findMany({
        where: { openedById: actor.userId },
        include: disputeInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
      });
    },

    /** The opener withdraws, until an administrator starts the review. */
    async withdraw(id: string, actor: Actor) {
      const found = await prisma.dispute.findUnique({
        where: { id },
        select: { openedById: true },
      });
      if (!found || found.openedById !== actor.userId) throw notFound("Dispute");
      await prisma.$transaction(async (tx) => {
        const dispute = await lockDispute(tx, id);
        const at = now();
        await close(tx, dispute, "WITHDRAWN", "OPENER", actor, at, null);
        await recordTrust(tx, dispute.assetId, at);
      });
      return load(id);
    },

    async list(status: DisputeStatus | undefined) {
      return prisma.dispute.findMany({
        where: status ? { status } : { status: { in: [...OPEN_DISPUTE_STATUSES] } },
        include: adminDisputeInclude,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 100,
      });
    },

    /**
     * Starts the review. A disputed attestation stops counting until the decision; with
     * `holdAsset` the asset becomes DISPUTED, which blocks transfers and cancels an open one.
     */
    async review(id: string, input: ReviewDisputeInput, actor: Actor) {
      await prisma.$transaction(async (tx) => {
        const dispute = await lockDispute(tx, id);
        if (dispute.openedById === actor.userId) {
          throw new ApiError(409, "self_review", "Another administrator must review your dispute");
        }
        transition(DISPUTE_LIFECYCLE, dispute.status, "UNDER_REVIEW", "ADMIN");
        const at = now();
        if (dispute.attestationId) {
          const attestation = await tx.attestation.findUniqueOrThrow({
            where: { id: dispute.attestationId },
            select: { status: true },
          });
          if (attestation.status === "ACTIVE" || attestation.status === "EXPIRED") {
            transition(ATTESTATION_LIFECYCLE, attestation.status, "DISPUTED", "ADMIN");
            await tx.attestation.update({
              where: { id: dispute.attestationId },
              data: { status: "DISPUTED", updatedAt: at },
            });
            await tx.attestationStatusEvent.create({
              data: {
                attestationId: dispute.attestationId,
                fromStatus: attestation.status,
                toStatus: "DISPUTED",
                reason: "dispute_under_review",
                actorId: actor.userId,
                createdAt: at,
              },
            });
          }
        }
        let assetStatusBefore: AssetStatus | null = null;
        if (input.holdAsset) {
          const asset = await tx.asset.findUniqueOrThrow({
            where: { id: dispute.assetId },
            select: { status: true },
          });
          if (asset.status === "DISPUTED") {
            throw new ApiError(
              409,
              "asset_already_held",
              "Another dispute already holds this asset",
            );
          }
          if (!HOLDABLE_STATUSES.includes(asset.status)) {
            throw new ApiError(
              409,
              "cannot_hold_asset",
              `An asset that is ${asset.status} cannot be put on hold`,
            );
          }
          await changeAssetStatus(
            tx,
            dispute.assetId,
            asset.status,
            "DISPUTED",
            "dispute_under_review",
            actor.userId,
            at,
          );
          if (asset.status === "TRANSFER_PENDING") {
            await cancelOpenTransfer(tx, dispute.assetId, "asset_disputed", at);
          }
          assetStatusBefore = asset.status;
        }
        await tx.dispute.update({
          where: { id },
          data: {
            status: "UNDER_REVIEW",
            reviewedById: actor.userId,
            reviewedAt: at,
            holdsAsset: assetStatusBefore !== null,
            assetStatusBefore,
            updatedAt: at,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "dispute.review_started",
            targetType: "dispute",
            targetId: id,
            metadata: { holdAsset: assetStatusBefore !== null },
          },
          actor.fp,
        );
        await recordTrust(tx, dispute.assetId, at);
      });
      return loadAdmin(id);
    },

    /**
     * Decides the dispute. Upheld: a disputed attestation is revoked, and disputed evidence stops
     * counting. Rejected: a disputed attestation counts again. An asset this dispute holds
     * returns to `assetStatus`, by default ACTIVE (or REVERIFICATION_REQUIRED if it was).
     */
    async resolve(id: string, input: ResolveDisputeInput, actor: Actor) {
      await prisma.$transaction(async (tx) => {
        const dispute = await lockDispute(tx, id);
        if (dispute.openedById === actor.userId) {
          throw new ApiError(409, "self_review", "Another administrator must decide your dispute");
        }
        const at = now();
        await close(tx, dispute, input.outcome, "ADMIN", actor, at, input.resolution);

        if (dispute.attestationId) {
          const attestation = await tx.attestation.findUniqueOrThrow({
            where: { id: dispute.attestationId },
            select: { status: true, claimType: true, expiresAt: true, verifierId: true },
          });
          const othersUnderReview = await tx.dispute.count({
            where: { attestationId: dispute.attestationId, status: "UNDER_REVIEW" },
          });
          let to: "REVOKED" | "ACTIVE" | "EXPIRED" | null = null;
          if (input.outcome === "UPHELD" && attestation.status !== "REVOKED") {
            to = "REVOKED";
          } else if (attestation.status === "DISPUTED" && othersUnderReview === 0) {
            to = attestation.expiresAt && attestation.expiresAt <= at ? "EXPIRED" : "ACTIVE";
          }
          if (to) {
            transition(
              ATTESTATION_LIFECYCLE,
              attestation.status,
              to,
              to === "EXPIRED" ? "SYSTEM" : "ADMIN",
            );
            await tx.attestation.update({
              where: { id: dispute.attestationId },
              data: { status: to, updatedAt: at },
            });
            await tx.attestationStatusEvent.create({
              data: {
                attestationId: dispute.attestationId,
                fromStatus: attestation.status,
                toStatus: to,
                reason: `dispute_${input.outcome.toLowerCase()}`,
                actorId: actor.userId,
                createdAt: at,
              },
            });
          }
          if (to === "REVOKED") {
            await tx.provenanceEvent.create({
              data: {
                assetId: dispute.assetId,
                type: "ATTESTATION_REVOKED",
                actorId: actor.userId,
                occurredAt: at,
                payload: { attestationId: dispute.attestationId, claimType: attestation.claimType },
              },
            });
          }
          if (input.outcome === "UPHELD") {
            await tx.verifier.update({
              where: { id: attestation.verifierId },
              data: {
                upheldDisputeCount: { increment: 1 },
                ...(to === "REVOKED" ? { revokedAttestationCount: { increment: 1 } } : {}),
              },
            });
          }
        }

        const asset = await tx.asset.findUniqueOrThrow({
          where: { id: dispute.assetId },
          select: { status: true },
        });
        const releases = dispute.holdsAsset && asset.status === "DISPUTED";
        if (input.assetStatus && !releases) {
          throw new ApiError(
            422,
            "asset_not_held",
            "This dispute does not hold the asset, so its status cannot be set here",
          );
        }
        if (releases) {
          const to =
            input.assetStatus ??
            (dispute.assetStatusBefore === "REVERIFICATION_REQUIRED"
              ? "REVERIFICATION_REQUIRED"
              : "ACTIVE");
          await changeAssetStatus(
            tx,
            dispute.assetId,
            "DISPUTED",
            to,
            `dispute_${input.outcome.toLowerCase()}`,
            actor.userId,
            at,
          );
          if (REQUEST_CANCELLING_ASSET_STATUSES.includes(to)) {
            await closeRequestsAsSystem(
              tx,
              { assetId: dispute.assetId },
              "CANCELLED",
              "asset_unavailable",
              at,
            );
          }
        }
        await recordTrust(tx, dispute.assetId, at);
      });
      return loadAdmin(id);
    },
  };
}

export type DisputeService = ReturnType<typeof createDisputeService>;
