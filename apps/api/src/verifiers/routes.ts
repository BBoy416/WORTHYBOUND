import { reviewActor } from "@worthybound/shared";
import {
  categoryPermissionChangeSchema,
  verifierApplicationSchema,
  verifierCategoryParamsSchema,
  verifierCategoryRequestSchema,
  verifierListQuerySchema,
  verifierParamsSchema,
  verifierStatusChangeSchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Actor } from "../assets/service.js";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { createVerifierService, type Reviewer } from "./service.js";
import {
  applicantVerifierSchema,
  publicVerifierSchema,
  reviewVerifierSchema,
  toApplicantVerifier,
  toReviewVerifier,
  toVerifierSummary,
  verifierSummarySchema,
} from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = { 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema };

const perUser = (limit: RateLimit) => ({
  rateLimit: {
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `user:${request.auth?.user.id ?? request.ip}`,
  },
});

export const verifierRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, requireRole, rateLimits } = ctx;
  const service = createVerifierService({ prisma, now });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });
  const reviewer = (request: FastifyRequest): Reviewer => ({
    ...actor(request),
    actor: reviewActor((request.auth as AuthContext).roles) as Reviewer["actor"],
  });
  const review = requireRole("VERIFIER_REVIEWER", "ADMIN");

  // ─── Applicants ─────────────────────────────────────────────────────────────

  app.post(
    "/verifier/application",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.apply),
      schema: {
        body: verifierApplicationSchema,
        response: { 201: applicantVerifierSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(toApplicantVerifier(await service.apply(request.body, actor(request)))),
  );

  app.get(
    "/verifier/me",
    {
      preHandler: authenticate,
      schema: { response: { 200: applicantVerifierSchema, ...errors } },
    },
    async (request) => toApplicantVerifier(await service.mine(actor(request))),
  );

  app.post(
    "/verifier/me/categories",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.write),
      schema: {
        body: verifierCategoryRequestSchema,
        response: { 201: applicantVerifierSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          toApplicantVerifier(await service.requestMoreCategories(request.body, actor(request))),
        ),
  );

  // ─── Reviewers ──────────────────────────────────────────────────────────────

  app.get(
    "/review/verifiers",
    {
      preHandler: review,
      schema: {
        querystring: verifierListQuerySchema,
        response: {
          200: z.object({
            items: z.array(verifierSummarySchema),
            nextCursor: z.string().nullable(),
          }),
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (request) => {
      const { items, nextCursor } = await service.list(request.query);
      return { items: items.map(toVerifierSummary), nextCursor };
    },
  );

  app.get(
    "/review/verifiers/:verifierId",
    {
      preHandler: review,
      schema: { params: verifierParamsSchema, response: { 200: reviewVerifierSchema, ...errors } },
    },
    async (request) => toReviewVerifier(await service.get(request.params.verifierId)),
  );

  app.post(
    "/review/verifiers/:verifierId/status",
    {
      preHandler: review,
      config: perUser(rateLimits.write),
      schema: {
        params: verifierParamsSchema,
        body: verifierStatusChangeSchema,
        response: { 200: reviewVerifierSchema, ...errors },
      },
    },
    async (request) =>
      toReviewVerifier(
        await service.changeStatus(request.params.verifierId, request.body, reviewer(request)),
      ),
  );

  app.post(
    "/review/verifiers/:verifierId/categories/:category",
    {
      preHandler: review,
      config: perUser(rateLimits.write),
      schema: {
        params: verifierCategoryParamsSchema,
        body: categoryPermissionChangeSchema,
        response: { 200: reviewVerifierSchema, ...errors },
      },
    },
    async (request) =>
      toReviewVerifier(
        await service.changeCategory(
          request.params.verifierId,
          request.params.category,
          request.body,
          reviewer(request),
        ),
      ),
  );

  // ─── Public ─────────────────────────────────────────────────────────────────

  /**
   * Public, no sign-in. Unknown IDs, applicants and rejected applicants all get the same 404.
   */
  app.get(
    "/verifiers/:verifierId",
    {
      config: {
        rateLimit: { max: rateLimits.public.max, timeWindow: rateLimits.public.timeWindowMs },
      },
      schema: { params: verifierParamsSchema, response: { 200: publicVerifierSchema } },
    },
    async (request) => service.publicProfile(request.params.verifierId),
  );
};
