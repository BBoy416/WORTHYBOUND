import type { PrismaClient, Role } from "@worthybound/database";
import type { WorthyBoundOracle } from "@worthybound/solana";
import type { Storage } from "@worthybound/storage";
import type { preHandlerAsyncHookHandler } from "fastify";
import type { ChainSync } from "./chain/sync.js";
import type { AutomatedChecks } from "./checks/worker.js";
import type { Config } from "./config.js";

export interface AppContext {
  config: Config;
  prisma: PrismaClient;
  storage: Storage;
  now: () => Date;
  authenticate: preHandlerAsyncHookHandler;
  requireRole: (...roles: Role[]) => preHandlerAsyncHookHandler;
  rateLimits: RateLimits;
  /** Null when no oracle key is configured; tokenization and transfers are then unavailable. */
  chainSync: ChainSync | null;
  oracle: WorthyBoundOracle | null;
  /** Null when no check engine (OpenAI key) is configured; AI checks are then unavailable. */
  automatedChecks: AutomatedChecks | null;
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
  /** Evidence upload requests, per user. */
  upload: RateLimit;
  /** Verifier applications, per user. */
  apply: RateLimit;
  /** Requests to run AI checks or reports, per user. Each one costs a call to the service. */
  checks: RateLimit;
  /** Public passports, per IP address. */
  public: RateLimit;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  auth: { max: 10, timeWindowMs: 60_000 },
  register: { max: 20, timeWindowMs: 60 * 60_000 },
  write: { max: 60, timeWindowMs: 60_000 },
  upload: { max: 30, timeWindowMs: 60 * 60_000 },
  apply: { max: 5, timeWindowMs: 60 * 60_000 },
  checks: { max: 10, timeWindowMs: 24 * 60 * 60_000 },
  public: { max: 120, timeWindowMs: 60_000 },
};
