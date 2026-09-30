import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAddressDecoder } from "@solana/addresses";
import type {
  CheckEngine,
  EvidenceCheckInput,
  EvidenceCheckOutcome,
  VerifierApplicationInput,
  VerifierReportOutcome,
} from "@worthybound/automated-checks";
import { createPrismaClient, type PrismaClient } from "@worthybound/database";
import { createStorage, type Storage } from "@worthybound/storage";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { SignInInput } from "../src/auth/siws.js";
import { loadConfig, type Config } from "../src/config.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
export const TEST_STORAGE_AVAILABLE = Boolean(
  S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY,
);

if (!TEST_STORAGE_AVAILABLE && process.env.CI) {
  throw new Error("S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set in CI");
}

/** A throwaway bucket, set up like the real one. Call `deleteBucket()` when done. */
export async function createTestStorage(): Promise<Storage> {
  const storage = createStorage({
    endpoint: S3_ENDPOINT as string,
    region: S3_REGION ?? "us-east-1",
    accessKeyId: S3_ACCESS_KEY_ID as string,
    secretAccessKey: S3_SECRET_ACCESS_KEY as string,
    bucket: `wb-test-${randomBytes(6).toString("hex")}`,
  });
  await storage.setup({ stagingPrefix: "staging/", corsOrigins: ["https://worthybound.test"] });
  return storage;
}

if (!TEST_DATABASE_URL && process.env.CI) {
  throw new Error("TEST_DATABASE_URL must be set in CI");
}

const databasePackage = fileURLToPath(new URL("../../../packages/database", import.meta.url));

export interface TestDatabase {
  prisma: PrismaClient;
  url: string;
  drop(): Promise<void>;
}

/** Creates an isolated database with all migrations applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const name = `wb_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: databasePackage,
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "pipe",
  });

  const prisma = createPrismaClient(url.toString());
  return {
    prisma,
    url: url.toString(),
    async drop() {
      await prisma.$disconnect();
      const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export const testConfig = (overrides: Record<string, string> = {}): Config =>
  loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgresql://unused@127.0.0.1/unused",
    AUTH_DOMAIN: "worthybound.test",
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    SERIAL_FINGERPRINT_KEY: "test-serial-fingerprint-key-at-least-32-chars",
    SOLANA_CLUSTER: "devnet",
    S3_ACCESS_KEY_ID: "unused",
    S3_SECRET_ACCESS_KEY: "unused-secret",
    ...overrides,
  });

/** A Solana wallet that signs like Phantom or Solflare: Ed25519 over the message bytes. */
export class TestWallet {
  readonly address: string;
  readonly #privateKey: KeyObject;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const x = publicKey.export({ format: "jwk" }).x as string;
    this.address = getAddressDecoder().decode(Buffer.from(x, "base64url"));
    this.#privateKey = privateKey;
  }

  sign(message: Uint8Array | string): Buffer {
    return sign(null, Buffer.from(message), this.#privateKey);
  }
}

export interface Clock {
  now: () => Date;
  advance(ms: number): void;
}

export function testClock(): Clock {
  let current = new Date();
  return {
    now: () => current,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

export function testApp(
  prisma: PrismaClient,
  options: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({
    config: testConfig(),
    prisma,
    rateLimits: {
      auth: { max: 1000, timeWindowMs: 60_000 },
      register: { max: 1000, timeWindowMs: 60_000 },
      write: { max: 1000, timeWindowMs: 60_000 },
      upload: { max: 1000, timeWindowMs: 60_000 },
      apply: { max: 1000, timeWindowMs: 60_000 },
      public: { max: 1000, timeWindowMs: 60_000 },
      checks: { max: 1000, timeWindowMs: 60_000 },
    },
    // Tests that do not touch evidence never reach this address.
    storage: createStorage({
      endpoint: "http://127.0.0.1:9",
      region: "us-east-1",
      accessKeyId: "unused",
      secretAccessKey: "unused-secret",
      bucket: "unused",
    }),
    ...options,
  });
}

/**
 * A check engine that records its inputs and answers with `evidence` and `report`, which tests
 * may replace or make throw.
 */
export function fakeCheckEngine() {
  const engine = {
    id: "fake",
    evidenceCalls: [] as EvidenceCheckInput[],
    reportCalls: [] as VerifierApplicationInput[],
    evidence: async (_input: EvidenceCheckInput): Promise<EvidenceCheckOutcome> => ({
      result: "PASSED",
      problems: [],
      summary: "Consistent with the description.",
      confidence: 0.9,
      model: "fake-model-1",
    }),
    report: async (_input: VerifierApplicationInput): Promise<VerifierReportOutcome> => ({
      recommendation: "NEEDS_MORE_INFORMATION",
      summary: "An established laboratory.",
      strengths: ["Specialised in watches"],
      concerns: ["No certifications named"],
      questions: ["Ask for a sample report"],
      sources: ["https://lab.example/about"],
      model: "fake-model-1",
    }),
    checkEvidence(input: EvidenceCheckInput): Promise<EvidenceCheckOutcome> {
      engine.evidenceCalls.push(input);
      return engine.evidence(input);
    },
    reportOnVerifier(input: VerifierApplicationInput): Promise<VerifierReportOutcome> {
      engine.reportCalls.push(input);
      return engine.report(input);
    },
  } satisfies CheckEngine & Record<string, unknown>;
  return engine;
}

export async function requestNonce(app: FastifyInstance, address: string) {
  const res = await app.inject({ method: "POST", url: "/auth/nonce", payload: { address } });
  if (res.statusCode !== 200) throw new Error(`nonce request failed: ${res.statusCode}`);
  return res.json<{ input: SignInInput; message: string; expiresAt: string }>();
}

export const verifyPayload = (address: string, message: string, signature: Uint8Array) => ({
  address,
  message: Buffer.from(message).toString("base64"),
  signature: Buffer.from(signature).toString("base64"),
});

/** Full sign-in; returns the session token from the cookie. */
export async function signIn(app: FastifyInstance, wallet: TestWallet): Promise<string> {
  const { message } = await requestNonce(app, wallet.address);
  const res = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: verifyPayload(wallet.address, message, wallet.sign(message)),
  });
  const cookie = res.cookies.find((c) => c.name === "wb_session");
  if (res.statusCode !== 200 || !cookie) throw new Error(`sign-in failed: ${res.statusCode}`);
  return cookie.value;
}
