import type { PrismaClient } from "@worthybound/database";
import { API_MANAGED_ROLES, type ApiManagedRole } from "@worthybound/shared";
import type { RoleGrantInput } from "@worthybound/validation";
import { writeAudit } from "../audit.js";
import type { Actor } from "../assets/service.js";
import { ApiError, notFound } from "../errors.js";

export interface RoleServiceOptions {
  prisma: PrismaClient;
  now: () => Date;
}

const assignmentSelect = {
  id: true,
  role: true,
  grantedById: true,
  grantedAt: true,
  revokedAt: true,
  user: { select: { walletAddress: true } },
} as const;

const isManaged = (role: string): role is ApiManagedRole =>
  (API_MANAGED_ROLES as readonly string[]).includes(role);

/**
 * Roles administrators grant through the API (VERIFIER_REVIEWER). ADMIN is granted only with the
 * CLI and VERIFIER follows the verifier's approval, so neither can be changed here.
 */
export function createRoleService({ prisma, now }: RoleServiceOptions) {
  return {
    async list(role: ApiManagedRole) {
      return prisma.roleAssignment.findMany({
        where: { role, revokedAt: null },
        orderBy: { grantedAt: "asc" },
        select: assignmentSelect,
      });
    },

    /** The user must have signed in at least once. */
    async grant(input: RoleGrantInput, actor: Actor) {
      return prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { walletAddress: input.walletAddress } });
        if (!user) throw notFound("User");
        if (user.id === actor.userId) {
          throw new ApiError(409, "self_grant", "You cannot grant roles to yourself");
        }
        const at = now();
        const created = await tx.roleAssignment.createMany({
          data: [{ userId: user.id, role: input.role, grantedById: actor.userId, grantedAt: at }],
          skipDuplicates: true,
        });
        if (created.count === 0) {
          throw new ApiError(409, "role_already_granted", `The user already has ${input.role}`);
        }
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "role.granted",
            targetType: "user",
            targetId: user.id,
            metadata: { role: input.role, via: "api" },
          },
          actor.fp,
        );
        return tx.roleAssignment.findFirstOrThrow({
          where: { userId: user.id, role: input.role, revokedAt: null },
          select: assignmentSelect,
        });
      });
    },

    async revoke(assignmentId: string, actor: Actor) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "role_assignments" WHERE "id" = ${assignmentId}::uuid FOR UPDATE`;
        const assignment = await tx.roleAssignment.findUnique({ where: { id: assignmentId } });
        if (!assignment) throw notFound("Role assignment");
        if (!isManaged(assignment.role)) {
          throw new ApiError(
            409,
            "role_not_managed",
            `${assignment.role} cannot be changed through the API`,
          );
        }
        if (assignment.revokedAt) {
          throw new ApiError(409, "role_already_revoked", "This role was already revoked");
        }
        const at = now();
        await tx.roleAssignment.update({ where: { id: assignmentId }, data: { revokedAt: at } });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "role.revoked",
            targetType: "user",
            targetId: assignment.userId,
            metadata: { role: assignment.role, via: "api" },
          },
          actor.fp,
        );
        return tx.roleAssignment.findUniqueOrThrow({
          where: { id: assignmentId },
          select: assignmentSelect,
        });
      });
    },
  };
}
