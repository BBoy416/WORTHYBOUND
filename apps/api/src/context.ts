import type { PrismaClient, Role } from "@worthybound/database";
import type { preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "./config.js";

export interface AppContext {
  config: Config;
  prisma: PrismaClient;
  now: () => Date;
  authenticate: preHandlerAsyncHookHandler;
  requireRole: (...roles: Role[]) => preHandlerAsyncHookHandler;
  rateLimit: { max: number; timeWindowMs: number };
}
