import { assetParamsSchema, automatedChecksConsentSchema } from "@worthybound/validation";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { fingerprint, writeAudit } from "../audit.js";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext, RateLimit } from "../context.js";
import { ApiError, notFound } from "../errors.js";
import { enqueueEvidenceChecks } from "./queue.js";
import { adminCheckSchema, toAdminCheck } from "./view.js";

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

const consentSchema = z.object({
  /** Whether AI checks can run (an engine is configured). */
  available: z.boolean(),
  /** The current owner consented; their photos and documents are sent to the check service. */
  enabled: z.boolean(),
  enabledAt: z.iso.datetime().nullable(),
});

/**
 * AI checks of owner uploads (ADR 0013). They run only with the current owner's consent, given
 * per asset; a new owner has to consent again. Results already recorded stay when consent is
 * withdrawn, so that failed checks cannot be removed by withdrawing it.
 */
export const checkRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, requireRole, rateLimits, automatedChecks } = ctx;

  async function ownedAsset(wbId: string, userId: string) {
    const asset = await prisma.asset.findUnique({ where: { wbId } });
    const discarded = asset?.status === "REVOKED" && asset.publishedAt === null;
    if (!asset || asset.ownerId !== userId || discarded) throw notFound("Asset");
    return asset;
  }

  const consentView = (asset: {
    ownerId: string;
    automatedChecksConsentById: string | null;
    automatedChecksConsentAt: Date | null;
  }) => {
    const enabled = asset.automatedChecksConsentById === asset.ownerId;
    return {
      available: automatedChecks !== null,
      enabled,
      enabledAt: enabled ? (asset.automatedChecksConsentAt?.toISOString() ?? null) : null,
    };
  };

  app.get(
    "/assets/:wbId/automated-checks",
    {
      preHandler: authenticate,
      schema: { params: assetParamsSchema, response: { 200: consentSchema, ...errors } },
    },
    async (request) =>
      consentView(await ownedAsset(request.params.wbId, (request.auth as AuthContext).user.id)),
  );

  app.put(
    "/assets/:wbId/automated-checks",
    {
      preHandler: authenticate,
      config: perUser(rateLimits.checks),
      schema: {
        params: assetParamsSchema,
        body: automatedChecksConsentSchema,
        response: { 200: consentSchema, 503: errorSchema, ...errors },
      },
    },
    async (request) => {
      const userId = (request.auth as AuthContext).user.id;
      const { enabled } = request.body;
      if (enabled && !automatedChecks) {
        throw new ApiError(503, "ai_checks_unavailable", "AI checks are not available");
      }
      const { asset, queued } = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${request.params.wbId} FOR UPDATE`;
        const current = await ownedAsset(request.params.wbId, userId);
        if (enabled && current.status === "REVOKED") {
          throw new ApiError(409, "asset_revoked", "A revoked asset cannot be checked");
        }
        if (consentView(current).enabled === enabled) return { asset: current, queued: 0 };
        const at = now();
        const updated = await tx.asset.update({
          where: { id: current.id },
          data: enabled
            ? { automatedChecksConsentById: userId, automatedChecksConsentAt: at }
            : { automatedChecksConsentById: null, automatedChecksConsentAt: null },
        });
        let count = 0;
        if (enabled) {
          count = await enqueueEvidenceChecks(tx, current.id, userId, at);
        } else {
          const evidence = await tx.evidence.findMany({
            where: { assetId: current.id },
            select: { id: true },
          });
          await tx.automatedJob.deleteMany({
            where: {
              kind: "EVIDENCE_CHECK",
              status: "PENDING",
              entityId: { in: evidence.map((e) => e.id) },
            },
          });
        }
        await writeAudit(
          tx,
          {
            actorId: userId,
            action: enabled ? "asset.automated_checks_enabled" : "asset.automated_checks_disabled",
            targetType: "asset",
            targetId: current.wbId,
            ...(enabled ? { metadata: { queued: count } } : {}),
          },
          fingerprint(config.SESSION_SECRET, request),
        );
        return { asset: updated, queued: count };
      });
      if (queued > 0) automatedChecks?.kick();
      return consentView(asset);
    },
  );

  /** Every check of the asset's evidence with the detection details, newest first. */
  app.get(
    "/admin/assets/:wbId/automated-checks",
    {
      preHandler: requireRole("ADMIN"),
      schema: {
        params: assetParamsSchema,
        response: { 200: z.object({ items: z.array(adminCheckSchema) }), ...errors },
      },
    },
    async (request) => {
      const asset = await prisma.asset.findUnique({
        where: { wbId: request.params.wbId },
        select: { id: true },
      });
      if (!asset) throw notFound("Asset");
      const checks = await prisma.automatedCheck.findMany({
        where: { assetId: asset.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return { items: checks.map(toAdminCheck) };
    },
  );
};
