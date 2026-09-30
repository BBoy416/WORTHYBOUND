import { assetParamsSchema, automatedCheckListQuerySchema } from "@worthybound/validation";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AuthContext } from "../auth/guard.js";
import type { AppContext } from "../context.js";
import { notFound } from "../errors.js";
import { adminCheckInclude, adminCheckSchema, toAdminCheck } from "./view.js";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const errors = { 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema };

const availabilitySchema = z.object({
  /** Whether AI checks run (an engine is configured). */
  available: z.boolean(),
});

/**
 * AI checks of owner uploads (ADR 0013). They run on every owner upload of an asset that is not
 * revoked, whenever an engine is configured.
 */
export const checkRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { prisma, authenticate, requireRole, automatedChecks } = ctx;

  async function ownedAsset(wbId: string, userId: string) {
    const asset = await prisma.asset.findUnique({ where: { wbId } });
    const discarded = asset?.status === "REVOKED" && asset.publishedAt === null;
    if (!asset || asset.ownerId !== userId || discarded) throw notFound("Asset");
    return asset;
  }

  app.get(
    "/assets/:wbId/automated-checks",
    {
      preHandler: authenticate,
      schema: { params: assetParamsSchema, response: { 200: availabilitySchema, ...errors } },
    },
    async (request) => {
      await ownedAsset(request.params.wbId, (request.auth as AuthContext).user.id);
      return { available: automatedChecks !== null };
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
        include: adminCheckInclude,
      });
      return { items: checks.map(toAdminCheck) };
    },
  );

  /** Checks across all assets, newest first, optionally only one result. */
  app.get(
    "/admin/automated-checks",
    {
      preHandler: requireRole("ADMIN"),
      schema: {
        querystring: automatedCheckListQuerySchema,
        response: {
          200: z.object({ items: z.array(adminCheckSchema), nextCursor: z.uuid().nullable() }),
          ...errors,
        },
      },
    },
    async (request) => {
      const { result, limit, cursor } = request.query;
      const checks = await prisma.automatedCheck.findMany({
        where: result ? { result } : {},
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: adminCheckInclude,
      });
      const page = checks.slice(0, limit);
      return {
        items: page.map(toAdminCheck),
        nextCursor: checks.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
};
