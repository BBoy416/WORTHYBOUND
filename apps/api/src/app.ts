import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@worthybound/database";
import Fastify, { type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { createAuthenticate, createRequireRole } from "./auth/guard.js";
import { authRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import type { AppContext } from "./context.js";

export interface BuildAppOptions {
  config: Config;
  prisma: PrismaClient;
  /** Clock, replaceable in tests. */
  now?: () => Date;
  /** Per-IP limit for the sign-in endpoints. */
  rateLimit?: { max: number; timeWindowMs: number };
  /** Registers extra routes with the same context (used by tests). */
  register?: (app: FastifyInstance, ctx: AppContext) => Promise<void> | void;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, prisma } = options;
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
    if (status === 429) {
      return reply
        .code(429)
        .send({ error: { code: "rate_limited", message: "Too many requests, try again later" } });
    }
    if (status >= 500) {
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

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  const authenticate = createAuthenticate(prisma, now);
  const ctx: AppContext = {
    config,
    prisma,
    now,
    authenticate,
    requireRole: createRequireRole(authenticate),
    rateLimit: options.rateLimit ?? { max: 10, timeWindowMs: 60_000 },
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
  if (options.register) await options.register(app, ctx);
  return app;
}
