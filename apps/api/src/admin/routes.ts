import { ROLES } from "@worthybound/shared";
import {
  roleAssignmentParamsSchema,
  roleGrantSchema,
  roleListQuerySchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Actor } from "../assets/service.js";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { createRoleService } from "./service.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = { 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema };

const roleAssignmentSchema = z.object({
  id: z.string(),
  walletAddress: z.string(),
  role: z.enum(ROLES),
  grantedById: z.string().nullable(),
  grantedAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});

const toRoleAssignment = (a: {
  id: string;
  role: (typeof ROLES)[number];
  grantedById: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  user: { walletAddress: string };
}) => ({
  id: a.id,
  walletAddress: a.user.walletAddress,
  role: a.role,
  grantedById: a.grantedById,
  grantedAt: a.grantedAt.toISOString(),
  revokedAt: a.revokedAt?.toISOString() ?? null,
});

export const adminRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, requireRole, rateLimits } = ctx;
  const service = createRoleService({ prisma, now });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });
  const admin = requireRole("ADMIN");
  const write = {
    preHandler: admin,
    config: {
      rateLimit: {
        max: rateLimits.write.max,
        timeWindow: rateLimits.write.timeWindowMs,
        hook: "preHandler" as const,
        keyGenerator: (request: FastifyRequest) => `user:${request.auth?.user.id ?? request.ip}`,
      },
    },
  };

  app.get(
    "/admin/roles",
    {
      preHandler: admin,
      schema: {
        querystring: roleListQuerySchema,
        response: {
          200: z.object({ items: z.array(roleAssignmentSchema) }),
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (request) => ({
      items: (await service.list(request.query.role)).map(toRoleAssignment),
    }),
  );

  app.post(
    "/admin/roles",
    {
      ...write,
      schema: { body: roleGrantSchema, response: { 201: roleAssignmentSchema, ...errors } },
    },
    async (request, reply) =>
      reply.code(201).send(toRoleAssignment(await service.grant(request.body, actor(request)))),
  );

  app.delete(
    "/admin/roles/:assignmentId",
    {
      ...write,
      schema: {
        params: roleAssignmentParamsSchema,
        response: { 200: roleAssignmentSchema, ...errors },
      },
    },
    async (request) =>
      toRoleAssignment(await service.revoke(request.params.assignmentId, actor(request))),
  );
};
