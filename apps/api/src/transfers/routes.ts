import {
  escrowDisputeSchema,
  resolveEscrowSchema,
  shipmentSchema,
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
import { captureSessionSchema, toCaptureSession } from "../capture/view.js";
import type { AppContext, RateLimit } from "../context.js";
import { createTransferService } from "./service.js";
import { adminTransferSchema, toAdminTransfer, toTransfer, transferSchema } from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = {
  401: errorSchema,
  403: errorSchema,
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

/** Controlled transfers between WorthyBound users (ADR 0002), shipped ones in escrow (ADR 0014). */
export const transferRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, requireRole, rateLimits, oracle, chainSync } = ctx;
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

  /** The buyer's signed payment into escrow, once both parties signed the transfer. */
  app.post(
    "/transfers/:transferId/payment",
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
      const paid = await service.pay(request.params.transferId, request.body, a);
      if (paid.queued) chainSync?.kick();
      return toTransfer(paid, a.userId);
    },
  );

  /**
   * Starts the seller's capture session of the item and the sealed package before shipping, or
   * returns the open one (200). Shots are uploaded as for any capture session.
   */
  app.post(
    "/transfers/:transferId/shipment-session",
    {
      ...write,
      schema: {
        params: transferParamsSchema,
        response: { 200: captureSessionSchema, 201: captureSessionSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { session, created } = await service.startShipmentSession(
        request.params.transferId,
        actor(request),
      );
      return reply.code(created ? 201 : 200).send(toCaptureSession(session, now()));
    },
  );

  app.post(
    "/transfers/:transferId/shipment",
    {
      ...write,
      schema: {
        params: transferParamsSchema,
        body: shipmentSchema,
        response: { 200: transferSchema, ...errors },
      },
    },
    async (request) => {
      const a = actor(request);
      return toTransfer(await service.ship(request.params.transferId, request.body, a), a.userId);
    },
  );

  app.post("/transfers/:transferId/delivered", action, async (request) => {
    const a = actor(request);
    return toTransfer(await service.delivered(request.params.transferId, a), a.userId);
  });

  app.post("/transfers/:transferId/extend", action, async (request) => {
    const a = actor(request);
    return toTransfer(await service.extendDelivery(request.params.transferId, a), a.userId);
  });

  app.post(
    "/transfers/:transferId/dispute",
    {
      ...write,
      schema: {
        params: transferParamsSchema,
        body: escrowDisputeSchema,
        response: { 200: transferSchema, ...errors },
      },
    },
    async (request) => {
      const a = actor(request);
      return toTransfer(
        await service.dispute(request.params.transferId, request.body, a),
        a.userId,
      );
    },
  );

  /** Disputed escrows waiting for a decision, oldest first. */
  app.get(
    "/admin/transfers/disputes",
    {
      preHandler: requireRole("ADMIN"),
      schema: { response: { 200: z.object({ items: z.array(adminTransferSchema) }), ...errors } },
    },
    async () => ({ items: (await service.disputes()).map(toAdminTransfer) }),
  );

  app.post(
    "/admin/transfers/:transferId/resolution",
    {
      preHandler: requireRole("ADMIN"),
      config: perUser(rateLimits.write),
      schema: {
        params: transferParamsSchema,
        body: resolveEscrowSchema,
        response: { 200: adminTransferSchema, ...errors },
      },
    },
    async (request) => {
      const resolved = await service.resolve(
        request.params.transferId,
        request.body,
        actor(request),
      );
      chainSync?.kick();
      return toAdminTransfer(resolved);
    },
  );
};
