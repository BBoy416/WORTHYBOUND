import {
  assetParamsSchema,
  ownerConfirmationSchema,
  purchaseCheckParamsSchema,
  purchaseCheckPhotoParamsSchema,
  remoteCheckParamsSchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Actor } from "../assets/service.js";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { captureSessionSchema, toCaptureSession } from "../capture/view.js";
import { ApiError } from "../errors.js";
import { createPurchaseCheckService, MAX_CHECK_PHOTO_BYTES } from "./service.js";
import {
  type CheckRecord,
  purchaseCheckSchema,
  type RecordedPhoto,
  remoteRequestSchema,
  toPurchaseCheck,
  toRemoteRequest,
} from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = {
  401: errorSchema,
  404: errorSchema,
  409: errorSchema,
  422: errorSchema,
  429: errorSchema,
};

const perUser = (limit: RateLimit) => ({
  rateLimit: {
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `user:${request.auth?.user.id ?? request.ip}`,
  },
});

/** Checks before buying, in person and remotely (ADR 0014). */
export const purchaseCheckRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, storage, now, authenticate, rateLimits, automatedChecks } = ctx;
  const service = createPurchaseCheckService({
    prisma,
    storage,
    now,
    log: app.log,
    checks: automatedChecks,
  });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });
  const write = { preHandler: authenticate, config: perUser(rateLimits.write) };
  const view = ({ check, recorded }: { check: CheckRecord; recorded: RecordedPhoto[] }) =>
    toPurchaseCheck(check, recorded, now());

  // Photos are sent as the image itself; only this plugin's routes accept image bodies.
  app.addContentTypeParser(
    ["image/jpeg", "image/png", "image/webp"],
    { parseAs: "buffer", bodyLimit: MAX_CHECK_PHOTO_BYTES },
    (_request, body, done) => done(null, body),
  );

  /** Starts a check, or returns the buyer's open one (200). */
  app.post(
    "/assets/:wbId/purchase-checks",
    {
      ...write,
      schema: {
        params: assetParamsSchema,
        response: { 200: purchaseCheckSchema, 201: purchaseCheckSchema, ...errors },
      },
    },
    async (request, reply) => {
      const started = await service.start(request.params.wbId, actor(request));
      return reply.code(started.created ? 201 : 200).send(view(started));
    },
  );

  /** Requests a remote check, or returns the buyer's open one (200). */
  app.post(
    "/assets/:wbId/remote-checks",
    {
      ...write,
      schema: {
        params: assetParamsSchema,
        response: { 200: purchaseCheckSchema, 201: purchaseCheckSchema, ...errors },
      },
    },
    async (request, reply) => {
      const started = await service.startRemote(request.params.wbId, actor(request));
      return reply.code(started.created ? 201 : 200).send(view(started));
    },
  );

  app.get(
    "/purchase-checks/:checkId",
    {
      preHandler: authenticate,
      schema: {
        params: purchaseCheckParamsSchema,
        response: { 200: purchaseCheckSchema, ...errors },
      },
    },
    async (request) => view(await service.get(request.params.checkId, actor(request))),
  );

  app.post(
    "/purchase-checks/:checkId/owner-code",
    {
      ...write,
      schema: {
        params: purchaseCheckParamsSchema,
        response: { 200: purchaseCheckSchema, ...errors },
      },
    },
    async (request) => view(await service.newOwnerCode(request.params.checkId, actor(request))),
  );

  app.post(
    "/purchase-checks/:checkId/photos/:shot",
    {
      ...write,
      bodyLimit: MAX_CHECK_PHOTO_BYTES,
      schema: {
        params: purchaseCheckPhotoParamsSchema,
        response: { 200: purchaseCheckSchema, ...errors },
      },
    },
    async (request) => {
      if (!Buffer.isBuffer(request.body)) {
        throw new ApiError(422, "not_a_photo", "Send a JPEG, PNG or WebP photo");
      }
      const { checkId, shot } = request.params;
      return view(await service.addPhoto(checkId, shot, request.body, actor(request)));
    },
  );

  app.get(
    "/purchase-checks/:checkId/photos/:shot",
    { preHandler: authenticate, schema: { params: purchaseCheckPhotoParamsSchema } },
    async (request, reply) => {
      const { checkId, shot } = request.params;
      const stream = await service.photo(checkId, shot, actor(request));
      return reply
        .header("content-type", "image/jpeg")
        .header("cache-control", "private, no-store")
        .send(stream);
    },
  );

  /** A 5-minute link to the seller's video for a remote check. */
  app.post(
    "/purchase-checks/:checkId/video",
    {
      ...write,
      schema: {
        params: purchaseCheckParamsSchema,
        response: {
          200: z.object({ url: z.string(), expiresAt: z.iso.datetime() }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const link = await service.video(request.params.checkId, actor(request));
      reply.header("cache-control", "no-store");
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    },
  );

  /** The owner's open remote checks of an asset, to film the item for. */
  app.get(
    "/assets/:wbId/remote-checks",
    {
      preHandler: authenticate,
      schema: {
        params: assetParamsSchema,
        response: { 200: z.object({ items: z.array(remoteRequestSchema) }), ...errors },
      },
    },
    async (request) => {
      const checks = await service.remoteRequests(request.params.wbId, actor(request));
      const at = now();
      return { items: checks.map((c) => toRemoteRequest(c, at)) };
    },
  );

  /**
   * Starts the capture session in which the owner films the item for a remote check, or returns
   * the open one (200). Shots are uploaded as for any capture session.
   */
  app.post(
    "/assets/:wbId/remote-checks/:checkId/capture-session",
    {
      ...write,
      schema: {
        params: remoteCheckParamsSchema,
        response: { 200: captureSessionSchema, 201: captureSessionSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { wbId, checkId } = request.params;
      const { session, created } = await service.startRemoteSession(wbId, checkId, actor(request));
      return reply.code(created ? 201 : 200).send(toCaptureSession(session, now()));
    },
  );

  /** The owner signs a buyer's code to confirm they own the item. */
  app.post(
    "/assets/:wbId/owner-confirmations",
    {
      ...write,
      schema: {
        params: assetParamsSchema,
        body: ownerConfirmationSchema,
        response: {
          200: z.object({ confirmed: z.literal(true), confirmedAt: z.iso.datetime() }),
          ...errors,
        },
      },
    },
    async (request) => service.confirmOwner(request.params.wbId, request.body, actor(request)),
  );
};
