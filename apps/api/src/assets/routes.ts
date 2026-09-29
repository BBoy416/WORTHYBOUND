import {
  assetConditionRequestSchema,
  assetParamsSchema,
  assetStatusRequestSchema,
  idempotencyKeySchema,
  registerAssetSchema,
  updateDraftAssetSchema,
  wbIdSchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { ApiError } from "../errors.js";
import { type Actor, createAssetService } from "./service.js";
import { ownerAssetSchema, ownerTrustSchema, toOwnerAsset, toOwnerTrust } from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = {
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  422: errorSchema,
};

/** Per signed-in user; runs after authentication so the user is known. */
const perUser = (limit: RateLimit) => ({
  rateLimit: {
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `user:${request.auth?.user.id ?? request.ip}`,
  },
});

export const assetRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, rateLimits, chainSync } = ctx;
  const service = createAssetService({
    prisma,
    now,
    serialFingerprintKey: config.SERIAL_FINGERPRINT_KEY,
  });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });
  const view = (asset: Parameters<typeof toOwnerAsset>[0]) =>
    toOwnerAsset(asset, config.publicWebUrl);
  const write = { preHandler: authenticate, config: perUser(rateLimits.write) };

  app.post(
    "/assets",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.register),
      schema: {
        body: registerAssetSchema,
        headers: z.object({ "idempotency-key": idempotencyKeySchema.optional() }),
        response: { 201: ownerAssetSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { asset, replayed } = await service.register(
        request.body,
        actor(request),
        request.headers["idempotency-key"],
      );
      if (replayed) reply.header("idempotent-replayed", "true");
      return reply.code(201).send(view(asset));
    },
  );

  app.get(
    "/assets",
    {
      preHandler: authenticate,
      schema: {
        querystring: z.strictObject({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: wbIdSchema.optional(),
        }),
        response: {
          200: z.object({ items: z.array(ownerAssetSchema), nextCursor: z.string().nullable() }),
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const { items, nextCursor } = await service.list(
        actor(request),
        request.query.limit,
        request.query.cursor,
      );
      return { items: items.map(view), nextCursor };
    },
  );

  app.get(
    "/assets/:wbId",
    {
      preHandler: authenticate,
      schema: { params: assetParamsSchema, response: { 200: ownerAssetSchema, ...errors } },
    },
    async (request) => view(await service.get(request.params.wbId, actor(request))),
  );

  app.get(
    "/assets/:wbId/trust",
    {
      preHandler: authenticate,
      schema: {
        params: assetParamsSchema,
        response: { 200: ownerTrustSchema.nullable(), ...errors },
      },
    },
    async (request) => toOwnerTrust(await service.trust(request.params.wbId, actor(request))),
  );

  app.patch(
    "/assets/:wbId",
    {
      ...write,
      schema: {
        params: assetParamsSchema,
        body: updateDraftAssetSchema,
        response: { 200: ownerAssetSchema, ...errors },
      },
    },
    async (request) =>
      view(await service.update(request.params.wbId, request.body, actor(request))),
  );

  app.post(
    "/assets/:wbId/publish",
    {
      ...write,
      schema: { params: assetParamsSchema, response: { 200: ownerAssetSchema, ...errors } },
    },
    async (request) => view(await service.publish(request.params.wbId, actor(request))),
  );

  app.post(
    "/assets/:wbId/status",
    {
      ...write,
      schema: {
        params: assetParamsSchema,
        body: assetStatusRequestSchema,
        response: { 200: ownerAssetSchema, ...errors },
      },
    },
    async (request) =>
      view(await service.changeStatus(request.params.wbId, request.body, actor(request))),
  );

  /** Accepted: registration runs in the background; poll the asset's `tokenizationStatus`. */
  app.post(
    "/assets/:wbId/tokenize",
    {
      ...write,
      schema: {
        params: assetParamsSchema,
        response: { 202: ownerAssetSchema, 503: errorSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (!chainSync) {
        throw new ApiError(503, "tokenization_unavailable", "Tokenization is not available");
      }
      const asset = await service.tokenize(request.params.wbId, actor(request));
      chainSync.kick();
      return reply.code(202).send(view(asset));
    },
  );

  app.post(
    "/assets/:wbId/condition",
    {
      ...write,
      schema: {
        params: assetParamsSchema,
        body: assetConditionRequestSchema,
        response: { 200: ownerAssetSchema, ...errors },
      },
    },
    async (request) =>
      view(await service.updateCondition(request.params.wbId, request.body, actor(request))),
  );
};
