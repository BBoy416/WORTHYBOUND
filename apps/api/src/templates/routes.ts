import {
  templateCreateSchema,
  templateListQuerySchema,
  templateParamsSchema,
  templateRequirementsSchema,
  templateVersionParamsSchema,
  templateVersionStatusSchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Actor } from "../assets/service.js";
import { fingerprint } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { createTemplateService } from "./service.js";
import {
  adminTemplateSchema,
  adminTemplateVersionSchema,
  publishedTemplateSchema,
  toAdminTemplate,
  toAdminTemplateVersion,
  toPublishedTemplate,
} from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = { 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema };

export const templateRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, requireRole, rateLimits } = ctx;
  const service = createTemplateService({ prisma, now });
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

  /** Public, no sign-in: templates owners can request verification against. */
  app.get(
    "/templates",
    {
      config: {
        rateLimit: { max: rateLimits.public.max, timeWindow: rateLimits.public.timeWindowMs },
      },
      schema: {
        querystring: templateListQuerySchema,
        response: { 200: z.object({ items: z.array(publishedTemplateSchema) }) },
      },
    },
    async (request) => ({
      items: (await service.published(request.query.category)).map(toPublishedTemplate),
    }),
  );

  app.get(
    "/admin/templates",
    {
      preHandler: admin,
      schema: {
        response: {
          200: z.object({ items: z.array(adminTemplateSchema) }),
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async () => ({ items: (await service.list()).map(toAdminTemplate) }),
  );

  app.post(
    "/admin/templates",
    {
      ...write,
      schema: { body: templateCreateSchema, response: { 201: adminTemplateSchema, ...errors } },
    },
    async (request, reply) =>
      reply.code(201).send(toAdminTemplate(await service.create(request.body, actor(request)))),
  );

  app.post(
    "/admin/templates/:templateId/versions",
    {
      ...write,
      schema: {
        params: templateParamsSchema,
        body: templateRequirementsSchema,
        response: { 201: adminTemplateVersionSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          toAdminTemplateVersion(
            await service.createVersion(request.params.templateId, request.body, actor(request)),
          ),
        ),
  );

  app.post(
    "/admin/template-versions/:versionId/status",
    {
      ...write,
      schema: {
        params: templateVersionParamsSchema,
        body: templateVersionStatusSchema,
        response: { 200: adminTemplateVersionSchema, ...errors },
      },
    },
    async (request) =>
      toAdminTemplateVersion(
        await service.changeVersionStatus(request.params.versionId, request.body, actor(request)),
      ),
  );
};
