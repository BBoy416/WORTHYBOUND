import {
  disputeListQuerySchema,
  disputeParamsSchema,
  openDisputeSchema,
  resolveDisputeSchema,
  reviewDisputeSchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Actor } from "../assets/service.js";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { createDisputeService } from "./service.js";
import { adminDisputeSchema, disputeSchema, toAdminDispute, toDispute } from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = {
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  422: errorSchema,
};

const perUser = (limit: RateLimit) => ({
  rateLimit: {
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `user:${request.auth?.user.id ?? request.ip}`,
  },
});

/** Disputes about an asset, an attestation or an evidence item (ADR 0017). */
export const disputeRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, requireRole, rateLimits } = ctx;
  const service = createDisputeService({ prisma, now });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });
  const admin = requireRole("ADMIN");

  app.get(
    "/disputes",
    {
      preHandler: authenticate,
      schema: { response: { 200: z.object({ items: z.array(disputeSchema) }), ...errors } },
    },
    async (request) => ({ items: (await service.listMine(actor(request))).map(toDispute) }),
  );

  app.post(
    "/disputes",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.apply),
      schema: { body: openDisputeSchema, response: { 201: disputeSchema, ...errors } },
    },
    async (request, reply) =>
      reply.code(201).send(toDispute(await service.open(request.body, actor(request)))),
  );

  app.post(
    "/disputes/:disputeId/withdraw",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.write),
      schema: { params: disputeParamsSchema, response: { 200: disputeSchema, ...errors } },
    },
    async (request) => toDispute(await service.withdraw(request.params.disputeId, actor(request))),
  );

  app.get(
    "/admin/disputes",
    {
      preHandler: admin,
      schema: {
        querystring: disputeListQuerySchema,
        response: { 200: z.object({ items: z.array(adminDisputeSchema) }), ...errors },
      },
    },
    async (request) => ({
      items: (await service.list(request.query.status)).map(toAdminDispute),
    }),
  );

  app.post(
    "/admin/disputes/:disputeId/review",
    {
      preHandler: admin,
      config: perUser(rateLimits.write),
      schema: {
        params: disputeParamsSchema,
        body: reviewDisputeSchema,
        response: { 200: adminDisputeSchema, ...errors },
      },
    },
    async (request) =>
      toAdminDispute(await service.review(request.params.disputeId, request.body, actor(request))),
  );

  app.post(
    "/admin/disputes/:disputeId/resolution",
    {
      preHandler: admin,
      config: perUser(rateLimits.write),
      schema: {
        params: disputeParamsSchema,
        body: resolveDisputeSchema,
        response: { 200: adminDisputeSchema, ...errors },
      },
    },
    async (request) =>
      toAdminDispute(await service.resolve(request.params.disputeId, request.body, actor(request))),
  );
};
