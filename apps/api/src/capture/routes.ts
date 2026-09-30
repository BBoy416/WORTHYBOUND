import { assetParamsSchema } from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Actor } from "../assets/service.js";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { createCaptureService } from "./service.js";
import { captureSessionSchema, toCaptureSession } from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = { 401: errorSchema, 404: errorSchema, 409: errorSchema, 429: errorSchema };

const perUser = (limit: RateLimit) => ({
  rateLimit: {
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `user:${request.auth?.user.id ?? request.ip}`,
  },
});

/**
 * Guided capture (ADR 0013). Shots are uploaded through the evidence upload endpoints with
 * `captureSessionId` and `captureShot`.
 */
export const captureRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, rateLimits } = ctx;
  const service = createCaptureService({ prisma, now });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });

  app.get(
    "/assets/:wbId/capture-sessions",
    {
      preHandler: authenticate,
      schema: {
        params: assetParamsSchema,
        response: { 200: z.object({ items: z.array(captureSessionSchema) }), ...errors },
      },
    },
    async (request) => {
      const sessions = await service.list(request.params.wbId, actor(request));
      const at = now();
      return { items: sessions.map((s) => toCaptureSession(s, at)) };
    },
  );

  /** Starts a session, or returns the open one (200). */
  app.post(
    "/assets/:wbId/capture-sessions",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.write),
      schema: {
        params: assetParamsSchema,
        response: { 200: captureSessionSchema, 201: captureSessionSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { session, created } = await service.start(request.params.wbId, actor(request));
      return reply.code(created ? 201 : 200).send(toCaptureSession(session, now()));
    },
  );
};
