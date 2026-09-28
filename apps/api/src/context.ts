import type { PrismaClient, Role } from "@worthybound/database";
import type { preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "./config.js";

export interface AppContext {
  config: Config;
  prisma: PrismaClient;
  now: () => Date;
  authenticate: preHandlerAsyncHookHandler;
  requireRole: (...roles: Role[]) => preHandlerAsyncHookHandler;
  rateLimits: RateLimits;
}

export interface RateLimit {
  max: number;
  timeWindowMs: number;
}

export interface RateLimits {
  /** Sign-in endpoints, per IP address. */
  auth: RateLimit;
  /** Asset registrations, per user. Kept low: each attempt can reveal whether an item exists. */
  register: RateLimit;
  /** Other asset changes, per user. */
  write: RateLimit;
  /** Public passports, per IP address. */
  public: RateLimit;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  auth: { max: 10, timeWindowMs: 60_000 },
  register: { max: 20, timeWindowMs: 60 * 60_000 },
  write: { max: 60, timeWindowMs: 60_000 },
  public: { max: 120, timeWindowMs: 60_000 },
};
