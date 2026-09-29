import {
  assetParamsSchema,
  attestationDraftSchema,
  attestationParamsSchema,
  attestationRevokeSchema,
  attestationSubmissionSchema,
  verificationRequestParamsSchema,
  verificationRequestSchema,
  verifierRequestListQuerySchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Actor } from "../assets/service.js";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { createVerificationService } from "./service.js";
import {
  ownerRequestSchema,
  toOwnerRequest,
  toVerifierAttestation,
  toVerifierRequest,
  verifierAttestationSchema,
  verifierRequestSchema,
} from "./view.js";

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

export const verificationRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, rateLimits } = ctx;
  const service = createVerificationService({ prisma, config, now });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });
  const write = { preHandler: authenticate, config: perUser(rateLimits.write) };
  const requestAction = {
    ...write,
    schema: {
      params: verificationRequestParamsSchema,
      response: { 200: verifierRequestSchema, ...errors },
    },
  };

  // ─── Owner ──────────────────────────────────────────────────────────────────

  app.get(
    "/assets/:wbId/verification-requests",
    {
      preHandler: authenticate,
      schema: {
        params: assetParamsSchema,
        response: { 200: z.object({ items: z.array(ownerRequestSchema) }), ...errors },
      },
    },
    async (request) => ({
      items: (await service.listForAsset(request.params.wbId, actor(request))).map(toOwnerRequest),
    }),
  );

  app.post(
    "/assets/:wbId/verification-requests",
    {
      ...write,
      schema: {
        params: assetParamsSchema,
        body: verificationRequestSchema,
        response: { 201: ownerRequestSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          toOwnerRequest(await service.open(request.params.wbId, request.body, actor(request))),
        ),
  );

  app.post(
    "/verification-requests/:requestId/cancel",
    {
      ...write,
      schema: {
        params: verificationRequestParamsSchema,
        response: { 200: ownerRequestSchema, ...errors },
      },
    },
    async (request) =>
      toOwnerRequest(await service.cancel(request.params.requestId, actor(request))),
  );

  // ─── Verifier ───────────────────────────────────────────────────────────────

  app.get(
    "/verifier/requests",
    {
      preHandler: authenticate,
      schema: {
        querystring: verifierRequestListQuerySchema,
        response: {
          200: z.object({
            items: z.array(verifierRequestSchema),
            nextCursor: z.uuid().nullable(),
          }),
          ...errors,
        },
      },
    },
    async (request) => {
      const { items, nextCursor, verifierId } = await service.queue(request.query, actor(request));
      return { items: items.map((r) => toVerifierRequest(r, verifierId)), nextCursor };
    },
  );

  app.get(
    "/verifier/requests/:requestId",
    {
      preHandler: authenticate,
      schema: {
        params: verificationRequestParamsSchema,
        response: { 200: verifierRequestSchema, ...errors },
      },
    },
    async (request) => {
      const found = await service.get(request.params.requestId, actor(request));
      return toVerifierRequest(found.request, found.verifierId);
    },
  );

  app.post("/verifier/requests/:requestId/claim", requestAction, async (request) => {
    const result = await service.claim(request.params.requestId, actor(request));
    return toVerifierRequest(result.request, result.verifierId);
  });

  app.post("/verifier/requests/:requestId/release", requestAction, async (request) => {
    const result = await service.release(request.params.requestId, actor(request));
    return toVerifierRequest(result.request, result.verifierId);
  });

  app.post("/verifier/requests/:requestId/complete", requestAction, async (request) => {
    const result = await service.complete(request.params.requestId, actor(request));
    return toVerifierRequest(result.request, result.verifierId);
  });

  /** Returns the exact text to sign with the wallet (`signMessage`); nothing is stored. */
  app.post(
    "/verifier/requests/:requestId/attestations/message",
    {
      ...write,
      schema: {
        params: verificationRequestParamsSchema,
        body: attestationDraftSchema,
        response: {
          200: z.object({ message: z.string(), verifierAddress: z.string() }),
          ...errors,
        },
      },
    },
    async (request) =>
      service.attestationMessage(request.params.requestId, request.body, actor(request)),
  );

  app.post(
    "/verifier/requests/:requestId/attestations",
    {
      ...write,
      schema: {
        params: verificationRequestParamsSchema,
        body: attestationSubmissionSchema,
        response: { 201: verifierAttestationSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          toVerifierAttestation(
            await service.attest(request.params.requestId, request.body, actor(request)),
          ),
        ),
  );

  app.post(
    "/attestations/:attestationId/revoke",
    {
      ...write,
      schema: {
        params: attestationParamsSchema,
        body: attestationRevokeSchema,
        response: { 200: verifierAttestationSchema, ...errors },
      },
    },
    async (request) =>
      toVerifierAttestation(
        await service.revoke(request.params.attestationId, request.body, actor(request)),
      ),
  );
};
