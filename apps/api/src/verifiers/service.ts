import {
  type AssetCategory,
  type CategoryPermissionStatus,
  isDatabaseError,
  type Prisma,
  type PrismaClient,
  type VerifierCategoryPermission,
} from "@worthybound/database";
import {
  assertTransition,
  CATEGORY_PERMISSION_LIFECYCLE,
  type Lifecycle,
  reapplyAvailableAt,
  toPublicVerifier,
  VERIFIER_LIFECYCLE,
  type PublicVerifier,
} from "@worthybound/shared";
import type {
  CategoryPermissionChangeInput,
  VerifierApplicationInput,
  VerifierCategoryRequestInput,
  VerifierListQuery,
  VerifierStatusChangeInput,
} from "@worthybound/validation";
import { writeAudit } from "../audit.js";
import type { Actor } from "../assets/service.js";
import { ApiError, fromDomainError, notFound } from "../errors.js";
import { recordTrustForAssets } from "../trust/record.js";
import { releaseVerifierRequests } from "../verification/requests.js";
import {
  lastRejectedAt,
  verifierInclude,
  type VerifierRecord,
  verifierSummaryInclude,
  type VerifierSummaryRecord,
} from "./view.js";

type Tx = Prisma.TransactionClient;

/** A signed-in verifier reviewer or administrator, as a lifecycle actor. */
export interface Reviewer extends Actor {
  actor: "ADMIN" | "REVIEWER";
}

export interface VerifierServiceOptions {
  prisma: PrismaClient;
  now: () => Date;
}

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown) =>
  isDatabaseError(error, UNIQUE_VIOLATION) || (error as { code?: string })?.code === "P2002";

const applicationExists = () =>
  new ApiError(409, "application_exists", "You have already applied to become a verifier");

function transition<S extends string, A extends string>(
  lifecycle: Lifecycle<S, A>,
  from: S,
  to: S,
  actor: A,
): void {
  try {
    assertTransition(lifecycle, from, to, actor);
  } catch (error) {
    throw fromDomainError(error);
  }
}

export function createVerifierService({ prisma, now }: VerifierServiceOptions) {
  const load = (db: Tx | PrismaClient, where: Prisma.VerifierWhereUniqueInput) =>
    db.verifier.findUnique({ where, include: verifierInclude });

  /** Locks the verifier row for the rest of the transaction. */
  async function lock(tx: Tx, id: string): Promise<VerifierRecord> {
    await tx.$queryRaw`SELECT 1 FROM "verifiers" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const verifier = await load(tx, { id });
    if (!verifier) throw notFound("Verifier");
    return verifier;
  }

  async function lockOwn(tx: Tx, actor: Actor): Promise<VerifierRecord | null> {
    await tx.$queryRaw`SELECT 1 FROM "verifiers" WHERE "userId" = ${actor.userId}::uuid FOR UPDATE`;
    return load(tx, { userId: actor.userId });
  }

  async function lockForReview(tx: Tx, id: string, reviewer: Reviewer) {
    const verifier = await lock(tx, id);
    if (verifier.userId === reviewer.userId) {
      throw new ApiError(403, "self_review", "You cannot review your own verifier record");
    }
    return verifier;
  }

  async function requestCategories(
    tx: Tx,
    verifierId: string,
    categories: readonly AssetCategory[],
    actor: Actor,
    at: Date,
  ) {
    for (const category of categories) {
      const permission = await tx.verifierCategoryPermission.create({
        data: { verifierId, category, createdAt: at, updatedAt: at },
      });
      await tx.verifierCategoryPermissionEvent.create({
        data: {
          permissionId: permission.id,
          toStatus: "PENDING",
          actorId: actor.userId,
          createdAt: at,
        },
      });
    }
  }

  async function setPermissionStatus(
    tx: Tx,
    permission: VerifierCategoryPermission,
    to: CategoryPermissionStatus,
    reason: string | null,
    actor: Actor,
    at: Date,
  ) {
    await tx.verifierCategoryPermission.update({
      where: { id: permission.id },
      data: {
        status: to,
        reason,
        ...(to === "APPROVED" ? { approvedById: actor.userId, approvedAt: at } : {}),
        ...(to === "REVOKED" ? { revokedAt: at } : {}),
        updatedAt: at,
      },
    });
    await tx.verifierCategoryPermissionEvent.create({
      data: {
        permissionId: permission.id,
        fromStatus: permission.status,
        toStatus: to,
        reason,
        actorId: actor.userId,
        createdAt: at,
      },
    });
  }

  /** Grants or revokes the VERIFIER role so it follows the verifier's approval. */
  async function syncVerifierRole(
    tx: Tx,
    userId: string,
    grant: boolean,
    reviewer: Reviewer,
    at: Date,
  ) {
    const changed = grant
      ? await tx.roleAssignment.createMany({
          data: [{ userId, role: "VERIFIER", grantedById: reviewer.userId, grantedAt: at }],
          skipDuplicates: true,
        })
      : await tx.roleAssignment.updateMany({
          where: { userId, role: "VERIFIER", revokedAt: null },
          data: { revokedAt: at },
        });
    if (changed.count === 0) return;
    await writeAudit(
      tx,
      {
        actorId: reviewer.userId,
        action: grant ? "role.granted" : "role.revoked",
        targetType: "user",
        targetId: userId,
        metadata: { role: "VERIFIER", via: "verifier_review" },
      },
      reviewer.fp,
    );
  }

  return {
    /** Applies, or applies again after a rejection once the waiting period has passed. */
    async apply(input: VerifierApplicationInput, actor: Actor): Promise<VerifierRecord> {
      const profile = {
        entityType: input.entityType,
        businessName: input.businessName ?? null,
        website: input.website ?? null,
        bio: input.bio ?? null,
      };
      try {
        return await prisma.$transaction(async (tx) => {
          const at = now();
          const existing = await lockOwn(tx, actor);
          if (existing && existing.status !== "REJECTED") throw applicationExists();

          let verifierId: string;
          if (existing) {
            const rejectedAt = lastRejectedAt(existing);
            const availableAt = rejectedAt && reapplyAvailableAt(rejectedAt);
            if (availableAt && at < availableAt) {
              throw new ApiError(
                409,
                "reapply_too_soon",
                `You can apply again after ${availableAt.toISOString()}`,
              );
            }
            transition(VERIFIER_LIFECYCLE, existing.status, "APPLIED", "APPLICANT");
            await tx.verifier.update({
              where: { id: existing.id },
              data: { ...profile, status: "APPLIED", updatedAt: at },
            });
            verifierId = existing.id;
          } else {
            const created = await tx.verifier.create({
              data: { ...profile, userId: actor.userId, createdAt: at, updatedAt: at },
            });
            verifierId = created.id;
          }
          await tx.verifierStatusEvent.create({
            data: {
              verifierId,
              fromStatus: existing?.status ?? null,
              toStatus: "APPLIED",
              actorId: actor.userId,
              createdAt: at,
            },
          });
          await requestCategories(tx, verifierId, input.categories, actor, at);
          await writeAudit(
            tx,
            {
              actorId: actor.userId,
              action: existing ? "verifier.reapplied" : "verifier.applied",
              targetType: "verifier",
              targetId: verifierId,
              metadata: { entityType: input.entityType, categories: input.categories },
            },
            actor.fp,
          );
          return (await load(tx, { id: verifierId })) as VerifierRecord;
        });
      } catch (error) {
        // A concurrent first application by the same user won.
        if (isUniqueViolation(error)) throw applicationExists();
        throw error;
      }
    },

    async mine(actor: Actor): Promise<VerifierRecord> {
      const verifier = await load(prisma, { userId: actor.userId });
      if (!verifier) throw notFound("Verifier application");
      return verifier;
    },

    async requestMoreCategories(
      input: VerifierCategoryRequestInput,
      actor: Actor,
    ): Promise<VerifierRecord> {
      return prisma.$transaction(async (tx) => {
        const verifier = await lockOwn(tx, actor);
        if (!verifier) throw notFound("Verifier application");
        if (verifier.status !== "APPROVED") {
          throw new ApiError(
            409,
            "verifier_not_approved",
            "Only approved verifiers can request more categories",
          );
        }
        const open = verifier.categoryPermissions
          .filter((p) => p.status !== "REVOKED" && input.categories.includes(p.category))
          .map((p) => p.category);
        if (open.length > 0) {
          throw new ApiError(
            409,
            "category_already_requested",
            `Already requested or approved: ${open.join(", ")}`,
          );
        }
        const at = now();
        await requestCategories(tx, verifier.id, input.categories, actor, at);
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "verifier.categories_requested",
            targetType: "verifier",
            targetId: verifier.id,
            metadata: { categories: input.categories },
          },
          actor.fp,
        );
        return (await load(tx, { id: verifier.id })) as VerifierRecord;
      });
    },

    /** Review queue, oldest first. */
    async list(query: VerifierListQuery) {
      const items: VerifierSummaryRecord[] = await prisma.verifier.findMany({
        where: query.status ? { status: query.status } : {},
        include: verifierSummaryInclude,
        orderBy: { id: "asc" },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
      const page = items.slice(0, query.limit);
      return {
        items: page,
        nextCursor: items.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      };
    },

    async get(id: string): Promise<VerifierRecord> {
      const verifier = await load(prisma, { id });
      if (!verifier) throw notFound("Verifier");
      return verifier;
    },

    /**
     * Follows the verifier lifecycle. Approval requires a verified identity and grants the
     * VERIFIER role; rejection revokes the requested categories; revocation revokes every
     * category and the role.
     */
    async changeStatus(
      id: string,
      input: VerifierStatusChangeInput,
      reviewer: Reviewer,
    ): Promise<VerifierRecord> {
      return prisma.$transaction(async (tx) => {
        const verifier = await lockForReview(tx, id, reviewer);
        const from = verifier.status;
        const to = input.status;
        transition(VERIFIER_LIFECYCLE, from, to, reviewer.actor);
        if (to === "APPROVED" && verifier.user.identityStatus !== "VERIFIED") {
          throw new ApiError(
            409,
            "identity_not_verified",
            "The verifier's identity must be verified (KYC) before approval",
          );
        }
        const at = now();
        const reason = input.reason ?? null;
        await tx.verifier.update({
          where: { id },
          data: {
            status: to,
            ...(to === "APPROVED" && verifier.approvedAt === null
              ? { approvedById: reviewer.userId, approvedAt: at }
              : {}),
            updatedAt: at,
          },
        });
        await tx.verifierStatusEvent.create({
          data: {
            verifierId: id,
            fromStatus: from,
            toStatus: to,
            reason,
            actorId: reviewer.userId,
            createdAt: at,
          },
        });
        if (to === "REJECTED" || to === "REVOKED") {
          for (const permission of verifier.categoryPermissions) {
            if (permission.status === "REVOKED") continue;
            transition(CATEGORY_PERMISSION_LIFECYCLE, permission.status, "REVOKED", reviewer.actor);
            await setPermissionStatus(tx, permission, "REVOKED", reason, reviewer, at);
          }
        }
        if (to === "APPROVED") await syncVerifierRole(tx, verifier.userId, true, reviewer, at);
        if (to === "REVOKED") await syncVerifierRole(tx, verifier.userId, false, reviewer, at);
        if (to === "SUSPENDED" || to === "REVOKED") {
          await releaseVerifierRequests(
            tx,
            id,
            to === "SUSPENDED" ? "verifier_suspended" : "verifier_revoked",
            at,
          );
        }
        await writeAudit(
          tx,
          {
            actorId: reviewer.userId,
            action: "verifier.status_changed",
            targetType: "verifier",
            targetId: id,
            metadata: { fromStatus: from, toStatus: to },
          },
          reviewer.fp,
        );
        const attested = await tx.attestation.findMany({
          where: { verifierId: id },
          distinct: ["assetId"],
          select: { assetId: true },
        });
        await recordTrustForAssets(
          tx,
          attested.map((a) => a.assetId),
          at,
        );
        return (await load(tx, { id })) as VerifierRecord;
      });
    },

    /** Decides one category. Categories are approved only for approved (or suspended) verifiers. */
    async changeCategory(
      id: string,
      category: AssetCategory,
      input: CategoryPermissionChangeInput,
      reviewer: Reviewer,
    ): Promise<VerifierRecord> {
      return prisma.$transaction(async (tx) => {
        const verifier = await lockForReview(tx, id, reviewer);
        const permission = verifier.categoryPermissions.find(
          (p) => p.category === category && p.status !== "REVOKED",
        );
        if (!permission) throw notFound("Category permission");
        const to = input.status;
        transition(CATEGORY_PERMISSION_LIFECYCLE, permission.status, to, reviewer.actor);
        if (
          to === "APPROVED" &&
          verifier.status !== "APPROVED" &&
          verifier.status !== "SUSPENDED"
        ) {
          throw new ApiError(
            409,
            "verifier_not_approved",
            "Approve the verifier before approving categories",
          );
        }
        const at = now();
        await setPermissionStatus(tx, permission, to, input.reason ?? null, reviewer, at);
        if (to === "SUSPENDED" || to === "REVOKED") {
          await releaseVerifierRequests(tx, id, "category_permission_withdrawn", at, {
            asset: { category },
          });
        }
        await tx.verifier.update({ where: { id }, data: { updatedAt: at } });
        await writeAudit(
          tx,
          {
            actorId: reviewer.userId,
            action: "verifier.category_changed",
            targetType: "verifier",
            targetId: id,
            metadata: { category, fromStatus: permission.status, toStatus: to },
          },
          reviewer.fp,
        );
        return (await load(tx, { id })) as VerifierRecord;
      });
    },

    /** Public profile; verifiers that were never approved have none. */
    async publicProfile(id: string): Promise<PublicVerifier> {
      const source = await prisma.verifier.findUnique({
        where: { id },
        select: {
          id: true,
          entityType: true,
          businessName: true,
          website: true,
          status: true,
          approvedAt: true,
          categoryPermissions: { select: { category: true, status: true } },
        },
      });
      const profile = source && toPublicVerifier(source);
      if (!profile) throw notFound("Verifier");
      return profile;
    },
  };
}

export type VerifierService = ReturnType<typeof createVerifierService>;
