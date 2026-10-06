import { passportUrl, toPublicPassport, TRUST_SCORE_DISCLAIMER } from "@worthybound/shared";
import { assetParamsSchema } from "@worthybound/validation";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { AppContext } from "../context.js";
import { notFound } from "../errors.js";
import { loadPassportSource } from "./load.js";

const humanize = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");

/**
 * Token metadata (Metaplex JSON schema) for the URI stored in each Core asset. Built from the
 * public passport, so it shows nothing the passport does not.
 */
export const metadataRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, rateLimits } = ctx;

  app.get(
    "/metadata/:wbId",
    {
      config: {
        rateLimit: { max: rateLimits.public.max, timeWindow: rateLimits.public.timeWindowMs },
      },
      schema: { params: assetParamsSchema },
    },
    async (request, reply) => {
      const source = await loadPassportSource(prisma, request.params.wbId);
      const passport = source && toPublicPassport(source);
      if (!passport) throw notFound("Metadata");

      const photo = passport.publicEvidence.find((e) => e.mimeType.startsWith("image/"));
      const image = photo ? `${config.apiPublicUrl}${photo.path}` : undefined;
      const title = [passport.brand, passport.model].filter(Boolean).join(" ");
      // Wallets and explorers fetch this from other origins.
      reply.header("access-control-allow-origin", "*");
      reply.header("cross-origin-resource-policy", "cross-origin");
      reply.header("cache-control", "public, max-age=300");
      return {
        name: `WorthyBound ${passport.wbId}`,
        description: [
          title ? `${title}. ` : "",
          "Digital passport of a physical asset on WorthyBound. The token is frozen and moves only ",
          "through WorthyBound. A token alone is not proof of authenticity. Independent in-person ",
          "verification is the strongest proof WorthyBound records. ",
          TRUST_SCORE_DISCLAIMER,
        ].join(""),
        external_url: passportUrl(config.publicWebUrl, passport.wbId),
        ...(image ? { image } : {}),
        attributes: [
          { trait_type: "WB ID", value: passport.wbId },
          { trait_type: "Category", value: humanize(passport.category) },
          ...(passport.brand ? [{ trait_type: "Brand", value: passport.brand }] : []),
          ...(passport.model ? [{ trait_type: "Model", value: passport.model }] : []),
          { trait_type: "Status", value: humanize(passport.status) },
          { trait_type: "Verification level", value: humanize(passport.verificationLevel) },
          ...(passport.trust ? [{ trait_type: "Trust Score", value: passport.trust.score }] : []),
        ],
        properties: {
          category: "image",
          files: image ? [{ uri: image, type: photo?.mimeType }] : [],
        },
      };
    },
  );
};
