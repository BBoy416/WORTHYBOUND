import {
  transferParamsSchema,
  transferRequestSchema,
  transferSignatureSchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Actor } from "../assets/service.js";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { createTransferService } from "./service.js";
import { toTransfer, transferSchema } from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = {
  401: errorSchema,
  404: errorSchema,
  409: errorSchema,
  422: errorSchema,
  503: errorSchema,
};

const perUser = (limit: RateLimit) => ({
  rateLimit: {
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `user:${request.auth?.user.id ?? request.ip}`,
  },
});

/** Controlled transfers between WorthyBound users (ADR 0002). */
export const transferRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, rateLimits, oracle, chainSync } = ctx;
  const service = createTransferService({ prisma, now, oracle, log: app.log });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });
  const write = { preHandler: authenticate, config: perUser(rateLimits.write) };
  const action = {
    ...write,
    schema: { params: transferParamsSchema, response: { 200: transferSchema, ...errors } },
  };

  app.get(
    "/transfers",
    {
      preHandler: authenticate,
      schema: { response: { 200: z.object({ items: z.array(transferSchema) }), ...errors } },
    },
    async (request) => {
      const a = actor(request);
      return { items: (await service.list(a)).map((t) => toTransfer(t, a.userId)) };
    },
  );

  app.get(
    "/transfers/:transferId",
    {
      preHandler: authenticate,
      schema: { params: transferParamsSchema, response: { 200: transferSchema, ...errors } },
    },
    async (request) => {
      const a = actor(request);
      return toTransfer(await service.get(request.params.transferId, a), a.userId);
    },
  );

  app.post(
    "/transfers",
    {
      ...write,
      schema: { body: transferRequestSchema, response: { 201: transferSchema, ...errors } },
    },
    async (request, reply) => {
      const a = actor(request);
      const started = await service.start(request.body, a);
      chainSync?.kick();
      return reply.code(201).send(toTransfer(started, a.userId));
    },
  );

  app.post("/transfers/:transferId/accept", action, async (request) => {
    const a = actor(request);
    return toTransfer(await service.accept(request.params.transferId, a), a.userId);
  });

  app.post("/transfers/:transferId/reject", action, async (request) => {
    const a = actor(request);
    const rejected = await service.reject(request.params.transferId, a);
    chainSync?.kick();
    return toTransfer(rejected, a.userId);
  });

  app.post("/transfers/:transferId/cancel", action, async (request) => {
    const a = actor(request);
    const cancelled = await service.cancel(request.params.transferId, a);
    chainSync?.kick();
    return toTransfer(cancelled, a.userId);
  });

  app.post(
    "/transfers/:transferId/signature",
    {
      ...write,
      schema: {
        params: transferParamsSchema,
        body: transferSignatureSchema,
        response: { 200: transferSchema, ...errors },
      },
    },
    async (request) => {
      const a = actor(request);
      const signed = await service.sign(request.params.transferId, request.body, a);
      if (signed.queued) chainSync?.kick();
      return toTransfer(signed, a.userId);
    },
  );
};
