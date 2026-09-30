import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { CheckEngine } from "@worthybound/automated-checks";
import type { PrismaClient } from "@worthybound/database";
import type { WorthyBoundOracle } from "@worthybound/solana";
import type { Storage } from "@worthybound/storage";
import Fastify, { type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { adminRoutes } from "./admin/routes.js";
import { assetRoutes } from "./assets/routes.js";
import { createAuthenticate, createRequireRole } from "./auth/guard.js";
import { authRoutes } from "./auth/routes.js";
import { type ChainSync, createChainSync } from "./chain/sync.js";
import { checkRoutes } from "./checks/routes.js";
import { type AutomatedChecks, createAutomatedChecks } from "./checks/worker.js";
import type { Config } from "./config.js";
import { type AppContext, DEFAULT_RATE_LIMITS, type RateLimits } from "./context.js";
import { ApiError } from "./errors.js";
import { evidenceRoutes } from "./evidence/routes.js";
import { metadataRoutes } from "./passport/metadata.js";
import { passportRoutes } from "./passport/routes.js";
import { purchaseCheckRoutes } from "./purchase-checks/routes.js";
import { templateRoutes } from "./templates/routes.js";
import { captureRoutes } from "./capture/routes.js";
import { completeTransfer } from "./transfers/service.js";
import { transferRoutes } from "./transfers/routes.js";
import { verificationRoutes } from "./verification/routes.js";
import { verifierRoutes } from "./verifiers/routes.js";
import { registerWebApp } from "./web.js";

export interface BuildAppOptions {
  config: Config;
  prisma: PrismaClient;
  storage: Storage;
  /** Clock, replaceable in tests. */
  now?: () => Date;
  /** Overrides of the default rate limits. */
  rateLimits?: Partial<RateLimits>;
  /** Registers extra routes with the same context (used by tests). */
  register?: (app: FastifyInstance, ctx: AppContext) => Promise<void> | void;
  /** Signs chain transactions; without it, tokenization and transfers are unavailable. */
  oracle?: WorthyBoundOracle;
  /** Runs AI checks and reports; without it, they are unavailable. */
  checkEngine?: CheckEngine;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Chain job worker; `server.ts` starts it. Null without an oracle. */
    chainSync: ChainSync | null;
    /** AI check worker; `server.ts` starts it. Null without a check engine. */
    automatedChecks: AutomatedChecks | null;
  }
}

/** Origin that presigned upload URLs point to (path-style with an endpoint, as in storage). */
export function storageOrigin(config: Config): string {
  return config.S3_ENDPOINT
    ? new URL(config.S3_ENDPOINT).origin
    : `https://${config.S3_BUCKET_EVIDENCE_PRIVATE}.s3.${config.S3_REGION}.amazonaws.com`;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, prisma, storage } = options;
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
      },
    },
    bodyLimit: 64 * 1024,
    // Behind a reverse proxy (Render), client IPs come from X-Forwarded-For.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // JSON only: plain-text bodies are what cross-site HTML forms can send.
  app.removeContentTypeParser("text/plain");
  app.decorateRequest("auth", null);

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          issues: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 429 && !(error instanceof ApiError)) {
      return reply
        .code(429)
        .send({ error: { code: "rate_limited", message: "Too many requests, try again later" } });
    }
    if (status >= 500 && !(error instanceof ApiError)) {
      request.log.error({ err: error }, "request failed");
      return reply
        .code(500)
        .send({ error: { code: "internal_error", message: "Internal server error" } });
    }
    const { code, message } = error as { code?: string; message?: string };
    return reply
      .code(status)
      .send({ error: { code: code ?? "bad_request", message: message ?? "Bad request" } });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        // The web app uploads evidence straight to storage with presigned URLs.
        "connect-src": ["'self'", storageOrigin(config)],
        "img-src": ["'self'", "data:", "blob:"],
        "upgrade-insecure-requests": config.NODE_ENV === "production" ? [] : null,
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  const authenticate = createAuthenticate(prisma, now);
  const chainSync = options.oracle
    ? createChainSync({
        prisma,
        oracle: options.oracle,
        now,
        log: app.log,
        metadataUrl: (wbId) => `${config.apiPublicUrl}/metadata/${wbId}`,
        completeTransfer,
      })
    : null;
  app.decorate("chainSync", chainSync);
  const automatedChecks = options.checkEngine
    ? createAutomatedChecks({ prisma, storage, engine: options.checkEngine, now, log: app.log })
    : null;
  app.decorate("automatedChecks", automatedChecks);
  app.addHook("onClose", async () => {
    await chainSync?.stop();
    await automatedChecks?.stop();
  });
  const ctx: AppContext = {
    config,
    prisma,
    storage,
    now,
    authenticate,
    requireRole: createRequireRole(authenticate),
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...options.rateLimits },
    chainSync,
    oracle: options.oracle ?? null,
    automatedChecks,
  };

  app.get("/health", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ok" };
    } catch (error) {
      app.log.error({ err: error }, "database health check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  await app.register(authRoutes, ctx);
  await app.register(assetRoutes, ctx);
  await app.register(evidenceRoutes, ctx);
  await app.register(passportRoutes, ctx);
  await app.register(metadataRoutes, ctx);
  await app.register(verifierRoutes, ctx);
  await app.register(adminRoutes, ctx);
  await app.register(templateRoutes, ctx);
  await app.register(verificationRoutes, ctx);
  await app.register(checkRoutes, ctx);
  await app.register(transferRoutes, ctx);
  await app.register(captureRoutes, ctx);
  await app.register(purchaseCheckRoutes, ctx);
  if (config.WEB_DIST_DIR) await registerWebApp(app, config.WEB_DIST_DIR);
  if (options.register) await options.register(app, ctx);
  return app;
}
