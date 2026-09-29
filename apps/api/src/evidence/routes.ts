import { isPassportPublic } from "@worthybound/shared";
import {
  assetParamsSchema,
  evidenceParamsSchema,
  evidenceUploadParamsSchema,
  evidenceUploadSchema,
  evidenceReviewSchema,
  evidenceVisibilitySchema,
  requestEvidenceParamsSchema,
  verificationRequestParamsSchema,
  verifierEvidenceUploadSchema,
} from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { fingerprint } from "../audit.js";
import type { Actor } from "../assets/service.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { notFound } from "../errors.js";
import { createEvidenceService } from "./service.js";
import { ownerEvidenceSchema, toOwnerEvidence } from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = {
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  422: errorSchema,
};

const uploadFormSchema = z.object({
  uploadId: z.uuid(),
  /** Send the file as a multipart form POST: these fields first, then `file`. */
  form: z.object({ url: z.string(), fields: z.record(z.string(), z.string()) }),
  expiresAt: z.iso.datetime(),
});

const perUser = (limit: RateLimit) => ({
  rateLimit: {
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `user:${request.auth?.user.id ?? request.ip}`,
  },
});

export const evidenceRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, storage, now, authenticate, rateLimits } = ctx;
  const service = createEvidenceService({ prisma, storage, now, log: app.log });
  const actor = (request: FastifyRequest): Actor => ({
    userId: (request.auth as AuthContext).user.id,
    fp: fingerprint(config.SESSION_SECRET, request),
  });
  const write = { preHandler: authenticate, config: perUser(rateLimits.write) };

  app.post(
    "/assets/:wbId/evidence/uploads",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.upload),
      schema: {
        params: assetParamsSchema,
        body: evidenceUploadSchema,
        response: { 201: uploadFormSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { upload, form } = await service.requestUpload(
        request.params.wbId,
        request.body,
        actor(request),
      );
      return reply.code(201).send({
        uploadId: upload.id,
        form: { url: form.url, fields: form.fields },
        expiresAt: upload.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    "/evidence/uploads/:uploadId/complete",
    {
      ...write,
      schema: {
        params: evidenceUploadParamsSchema,
        response: { 200: ownerEvidenceSchema, 201: ownerEvidenceSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { evidence, wbId, replayed } = await service.complete(
        request.params.uploadId,
        actor(request),
      );
      return reply.code(replayed ? 200 : 201).send(toOwnerEvidence(evidence, wbId));
    },
  );

  app.get(
    "/assets/:wbId/evidence",
    {
      preHandler: authenticate,
      schema: {
        params: assetParamsSchema,
        response: { 200: z.object({ items: z.array(ownerEvidenceSchema) }), ...errors },
      },
    },
    async (request) => {
      const { asset, items } = await service.list(request.params.wbId, actor(request));
      return { items: items.map((e) => toOwnerEvidence(e, asset.wbId)) };
    },
  );

  app.post(
    "/assets/:wbId/evidence/:evidenceId/download",
    {
      ...write,
      schema: {
        params: evidenceParamsSchema,
        response: {
          200: z.object({ url: z.string(), expiresAt: z.iso.datetime() }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const link = await service.download(
        request.params.wbId,
        request.params.evidenceId,
        actor(request),
      );
      reply.header("cache-control", "no-store");
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    },
  );

  app.post(
    "/assets/:wbId/evidence/:evidenceId/visibility",
    {
      ...write,
      schema: {
        params: evidenceParamsSchema,
        body: evidenceVisibilitySchema,
        response: { 200: ownerEvidenceSchema, ...errors },
      },
    },
    async (request) => {
      const { evidence, wbId } = await service.changeVisibility(
        request.params.wbId,
        request.params.evidenceId,
        request.body,
        actor(request),
      );
      return toOwnerEvidence(evidence, wbId);
    },
  );

  // ─── The verifier assigned to a verification request ───────────────────────

  app.post(
    "/verifier/requests/:requestId/evidence/uploads",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.upload),
      schema: {
        params: verificationRequestParamsSchema,
        body: verifierEvidenceUploadSchema,
        response: { 201: uploadFormSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { upload, form } = await service.requestVerifierUpload(
        request.params.requestId,
        request.body,
        actor(request),
      );
      return reply.code(201).send({
        uploadId: upload.id,
        form: { url: form.url, fields: form.fields },
        expiresAt: upload.expiresAt.toISOString(),
      });
    },
  );

  app.get(
    "/verifier/requests/:requestId/evidence",
    {
      preHandler: authenticate,
      schema: {
        params: verificationRequestParamsSchema,
        response: { 200: z.object({ items: z.array(ownerEvidenceSchema) }), ...errors },
      },
    },
    async (request) => {
      const { asset, items } = await service.listForRequest(
        request.params.requestId,
        actor(request),
      );
      return { items: items.map((e) => toOwnerEvidence(e, asset.wbId)) };
    },
  );

  app.post(
    "/verifier/requests/:requestId/evidence/:evidenceId/download",
    {
      ...write,
      schema: {
        params: requestEvidenceParamsSchema,
        response: {
          200: z.object({ url: z.string(), expiresAt: z.iso.datetime() }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const link = await service.downloadForRequest(
        request.params.requestId,
        request.params.evidenceId,
        actor(request),
      );
      reply.header("cache-control", "no-store");
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    },
  );

  app.post(
    "/verifier/requests/:requestId/evidence/:evidenceId/review",
    {
      ...write,
      schema: {
        params: requestEvidenceParamsSchema,
        body: evidenceReviewSchema,
        response: { 200: ownerEvidenceSchema, ...errors },
      },
    },
    async (request) => {
      const { evidence, wbId } = await service.review(
        request.params.requestId,
        request.params.evidenceId,
        request.body,
        actor(request),
      );
      return toOwnerEvidence(evidence, wbId);
    },
  );

  /** Public, no sign-in: the metadata-free copy of a public photo on a published passport. */
  app.get(
    "/passport/:wbId/evidence/:evidenceId",
    {
      config: {
        rateLimit: { max: rateLimits.public.max, timeWindow: rateLimits.public.timeWindowMs },
      },
      schema: { params: evidenceParamsSchema },
    },
    async (request, reply) => {
      const photo = await service.publicPhoto(request.params.wbId, request.params.evidenceId);
      if (!photo || !isPassportPublic(photo.status)) {
        photo?.stream.destroy();
        throw notFound("Evidence");
      }
      return reply
        .header("content-type", photo.mimeType)
        .header(
          "content-disposition",
          `inline; filename="${request.params.evidenceId}.${photo.extension}"`,
        )
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "public, max-age=300")
        .send(photo.stream);
    },
  );
};
