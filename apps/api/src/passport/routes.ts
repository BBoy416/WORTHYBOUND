import { passportUrl, toPublicPassport } from "@worthybound/shared";
import { assetParamsSchema } from "@worthybound/validation";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { AppContext } from "../context.js";
import { notFound } from "../errors.js";
import { loadPassportSource } from "./load.js";

export const passportRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, rateLimits } = ctx;

  /**
   * Public, no sign-in. Unknown IDs, drafts and discarded drafts all get the same 404, so the
   * endpoint cannot be used to find out which IDs exist.
   */
  app.get(
    "/passport/:wbId",
    {
      config: {
        rateLimit: { max: rateLimits.public.max, timeWindow: rateLimits.public.timeWindowMs },
      },
      schema: { params: assetParamsSchema },
    },
    async (request) => {
      const source = await loadPassportSource(prisma, request.params.wbId);
      const passport = source && toPublicPassport(source);
      if (!passport) throw notFound("Passport");
      return { passport, url: passportUrl(config.publicWebUrl, passport.wbId) };
    },
  );
};
