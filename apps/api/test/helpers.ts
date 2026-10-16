import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddressDecoder } from "@solana/addresses";
import type {
  CheckEngine,
  EvidenceCheckInput,
  EvidenceCheckOutcome,
  ItemMatchInput,
  ItemMatchOutcome,
  VerifierApplicationInput,
  VerifierReportOutcome,
} from "@worthybound/automated-checks";
import { createPrismaClient, type PrismaClient } from "@worthybound/database";
import {
  buildEscrowPaymentTransaction,
  buildTransferTransaction,
  type ChainRecordState,
  completeTransferTransaction,
  loadKeypairSigner,
  StaleChainUpdateError,
  TransferFailedError,
  type WorthyBoundOracle,
} from "@worthybound/solana";
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
 * Test app with an in-memory oracle, for tests that publish assets. Chain jobs run only when a
 * test calls `app.chainSync.runOnce()`.
 */
export async function testAppWithOracle(
  prisma: PrismaClient,
  options: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  const app = await testApp(prisma, { oracle: new FakeOracle(await oracleSigner()), ...options });
  app.chainSync!.kick = () => {};
  return app;
}

/**
 * A check engine that records its inputs and answers with `evidence`, `match` and `report`, which
 * tests may replace or make throw.
 */
export function fakeCheckEngine() {
  const engine = {
    id: "fake",
    evidenceCalls: [] as EvidenceCheckInput[],
    reportCalls: [] as VerifierApplicationInput[],
    matchCalls: [] as ItemMatchInput[],
    evidence: async (_input: EvidenceCheckInput): Promise<EvidenceCheckOutcome> => ({
      result: "PASSED",
      problems: [],
      summary: "Consistent with the description.",
      confidence: 0.9,
      documentNumber: null,
      model: "fake-model-1",
    }),
    match: async (_input: ItemMatchInput): Promise<ItemMatchOutcome> => ({
      result: "MATCH",
      summary: "The same scratches on the bezel.",
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
    compareItem(input: ItemMatchInput): Promise<ItemMatchOutcome> {
      engine.matchCalls.push(input);
      return engine.match(input);
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

export type Address = ChainRecordState["owner"];
type Signature = Awaited<ReturnType<WorthyBoundOracle["updateStatus"]>>;

type Call =
  | { kind: "register"; wbId: string; owner: string; uri: string; status: string; seq: bigint }
  | { kind: "status"; wbId: string; status: string; seq: bigint }
  | { kind: "trust"; wbId: string; score: number; level: string; seq: bigint }
  | {
      kind: "prepare";
      wbId: string;
      seller: string;
      buyer: string;
      status: string;
      seq: bigint;
      price: bigint;
    }
  | { kind: "transfer"; wbId: string; buyer: string }
  | { kind: "payment" | "payment_reset"; buyer: string; price: bigint }
  | { kind: "refund"; buyer: string; price: bigint }
  | { kind: "close"; accounts: string[] };

type Signer = Awaited<ReturnType<typeof loadKeypairSigner>>;

/** In-memory stand-in for the program: keeps records and rejects stale sequence numbers. */
export class FakeOracle implements WorthyBoundOracle {
  readonly records = new Map<string, ChainRecordState & { status: string; score?: number }>();
  readonly calls: Call[] = [];
  /** Prepared transfers by transaction, to apply when sent. */
  readonly #prepared = new Map<
    string,
    {
      wbId: string;
      seller: string;
      buyer: string;
      status: string;
      seq: bigint;
      nonceAccount: string;
      escrow: boolean;
      price: bigint;
    }
  >();
  /** Prepared payments into escrow by transaction. */
  readonly #payments = new Map<string, { buyer: string; escrow: string; price: bigint }>();
  /** Escrow nonce accounts whose nonce moved on with a refund; their transfer cannot run. */
  readonly #advanced = new Set<string>();
  failures = 0;
  /** Makes the next sent payment land and fail, as when the buyer spent the SOL meanwhile. */
  failNextPayment = false;
  /**
   * Payments are sent but never seen to confirm, as during an outage; they stay valid, and land
   * with `landLostPayments`, until their payment nonce is advanced.
   */
  losePayments = false;
  readonly #lost = new Set<string>();
  /** Lamports by wallet; wallets not listed hold 10 SOL. */
  readonly balances = new Map<string, bigint>();
  /** Lamports held in escrow, by nonce account. */
  readonly escrows = new Map<string, bigint>();
  /** Nonce accounts created and not yet closed. */
  readonly nonces = new Set<string>();
  #n = 0;

  constructor(readonly signer: Signer) {}

  get oracleAddress(): WorthyBoundOracle["oracleAddress"] {
    return this.signer.address;
  }

  #sign(): Signature {
    this.#n += 1;
    return `sig-${this.#n}-${randomUUID()}` as Signature;
  }

  #maybeFail() {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("RPC unavailable");
    }
  }

  async fetchRecord(wbId: string) {
    return this.records.get(wbId) ?? null;
  }

  async registerAsset(
    input: Parameters<WorthyBoundOracle["registerAsset"]>[0],
  ): ReturnType<WorthyBoundOracle["registerAsset"]> {
    this.#maybeFail();
    this.calls.push({ kind: "register", ...input, seq: input.statusSeq });
    this.records.set(input.wbId, {
      owner: input.owner as Address,
      status: input.status,
      statusSeq: input.statusSeq,
      trustSeq: 0n,
    });
    return this.#sign();
  }

  async updateStatus(
    input: Parameters<WorthyBoundOracle["updateStatus"]>[0],
  ): ReturnType<WorthyBoundOracle["updateStatus"]> {
    this.#maybeFail();
    const record = this.records.get(input.wbId);
    if (!record) throw new Error("AccountNotInitialized");
    if (input.statusSeq <= record.statusSeq) throw new StaleChainUpdateError();
    this.calls.push({ kind: "status", ...input, seq: input.statusSeq });
    Object.assign(record, { status: input.status, statusSeq: input.statusSeq });
    return this.#sign();
  }

  async commitTrustScore(
    input: Parameters<WorthyBoundOracle["commitTrustScore"]>[0],
  ): ReturnType<WorthyBoundOracle["commitTrustScore"]> {
    this.#maybeFail();
    const record = this.records.get(input.wbId);
    if (!record) throw new Error("AccountNotInitialized");
    if (input.trustSeq <= record.trustSeq) throw new StaleChainUpdateError();
    this.calls.push({
      kind: "trust",
      wbId: input.wbId,
      score: input.score,
      level: input.level,
      seq: input.trustSeq,
    });
    Object.assign(record, { score: input.score, trustSeq: input.trustSeq });
    return this.#sign();
  }

  async prepareTransfer(input: Parameters<WorthyBoundOracle["prepareTransfer"]>[0]) {
    this.#maybeFail();
    this.calls.push({
      kind: "prepare",
      wbId: input.wbId,
      seller: input.seller,
      buyer: input.buyer,
      status: input.statusAfter,
      seq: input.statusSeq,
      price: input.priceLamports,
    });
    const nonceAccount = new TestWallet().address as Address;
    const transaction = await buildTransferTransaction({
      ...input,
      oracle: this.oracleAddress,
      seller: input.seller as Address,
      buyer: input.buyer as Address,
      nonceAccount,
      nonce: new TestWallet().address,
    });
    this.#prepared.set(transaction, {
      ...input,
      status: input.statusAfter,
      seq: input.statusSeq,
      nonceAccount,
      escrow: input.escrow === true,
      price: input.priceLamports,
    });
    const paymentNonceAccount =
      input.escrow && input.priceLamports > 0n ? new TestWallet().address : null;
    this.nonces.add(nonceAccount);
    if (paymentNonceAccount) this.nonces.add(paymentNonceAccount);
    return { transaction, nonceAccount, paymentNonceAccount };
  }

  async prepareEscrowPayment(input: Parameters<WorthyBoundOracle["prepareEscrowPayment"]>[0]) {
    this.#maybeFail();
    const transaction = buildEscrowPaymentTransaction({
      ...input,
      oracle: this.oracleAddress,
      buyer: input.buyer as Address,
      escrowAccount: input.escrowAccount as Address,
      paymentNonceAccount: input.paymentNonceAccount as Address,
      nonce: new TestWallet().address,
    });
    this.#payments.set(transaction, {
      buyer: input.buyer,
      escrow: input.escrowAccount,
      price: input.priceLamports,
    });
    return transaction;
  }

  /** Lands the payments that were sent and are still valid. */
  landLostPayments() {
    for (const transaction of this.#lost) {
      const payment = this.#payments.get(transaction);
      if (!payment) continue;
      this.#payments.delete(transaction);
      this.#credit(payment.buyer, -payment.price);
      this.escrows.set(payment.escrow, (this.escrows.get(payment.escrow) ?? 0n) + payment.price);
      this.calls.push({ kind: "payment", buyer: payment.buyer, price: payment.price });
    }
    this.#lost.clear();
  }

  async resetEscrowPayment(
    input: Parameters<WorthyBoundOracle["resetEscrowPayment"]>[0],
  ): ReturnType<WorthyBoundOracle["resetEscrowPayment"]> {
    this.#maybeFail();
    // Advancing the payment nonce invalidates every payment prepared for this escrow.
    for (const [transaction, payment] of this.#payments) {
      if (payment.escrow === input.escrowAccount) this.#payments.delete(transaction);
    }
    this.calls.push({ kind: "payment_reset", buyer: input.buyer, price: input.priceLamports });
    if ((this.escrows.get(input.escrowAccount) ?? 0n) >= input.priceLamports) return { held: true };
    return { held: false, transaction: await this.prepareEscrowPayment(input) };
  }

  async refundEscrow(
    input: Parameters<WorthyBoundOracle["refundEscrow"]>[0],
  ): ReturnType<WorthyBoundOracle["refundEscrow"]> {
    this.#maybeFail();
    const held = this.escrows.get(input.escrowAccount) ?? 0n;
    if (held < input.priceLamports) return null;
    this.escrows.set(input.escrowAccount, held - input.priceLamports);
    this.#credit(input.buyer, input.priceLamports);
    this.#advanced.add(input.escrowAccount);
    this.calls.push({ kind: "refund", buyer: input.buyer, price: input.priceLamports });
    return this.#sign();
  }

  async closeNonceAccounts(
    accounts: string[],
  ): ReturnType<WorthyBoundOracle["closeNonceAccounts"]> {
    this.#maybeFail();
    const closing = accounts.filter(
      (a) => this.nonces.has(a) && (this.escrows.get(a) ?? 0n) === 0n,
    );
    if (closing.length === 0) return null;
    for (const a of closing) this.nonces.delete(a);
    this.calls.push({ kind: "close", accounts: closing });
    return this.#sign();
  }

  #credit(wallet: string, lamports: bigint) {
    this.balances.set(wallet, (this.balances.get(wallet) ?? 10_000_000_000n) + lamports);
  }

  async getBalance(address: string) {
    this.#maybeFail();
    return this.balances.get(address) ?? 10_000_000_000n;
  }

  async sendTransfer(
    input: Parameters<WorthyBoundOracle["sendTransfer"]>[0],
  ): ReturnType<WorthyBoundOracle["sendTransfer"]> {
    this.#maybeFail();
    // Throws unless the parties signed; the oracle signs last.
    await completeTransferTransaction(input.transaction, input.signatures, this.signer);
    const payment = this.#payments.get(input.transaction);
    if (payment && this.losePayments) {
      this.#lost.add(input.transaction);
      throw new Error("transaction confirmation timed out");
    }
    if (payment) {
      this.#payments.delete(input.transaction);
      if (this.failNextPayment) {
        this.failNextPayment = false;
        throw new TransferFailedError("insufficient lamports");
      }
      this.#credit(payment.buyer, -payment.price);
      this.escrows.set(payment.escrow, (this.escrows.get(payment.escrow) ?? 0n) + payment.price);
      this.calls.push({ kind: "payment", buyer: payment.buyer, price: payment.price });
      return this.#sign();
    }
    const prepared = this.#prepared.get(input.transaction);
    const record = prepared && this.records.get(prepared.wbId);
    if (!prepared || !record) throw new Error("AccountNotInitialized");
    if (record.status !== "TRANSFER_PENDING") throw new Error("NotTransferPending");
    if (record.owner !== prepared.seller) throw new Error("NotOwner");
    if (prepared.seq <= record.statusSeq) throw new Error("StaleUpdate");
    if (prepared.escrow) {
      const held = this.escrows.get(prepared.nonceAccount) ?? 0n;
      if (this.#advanced.has(prepared.nonceAccount) || held < prepared.price) {
        throw new TransferFailedError("nonce has advanced");
      }
      this.escrows.set(prepared.nonceAccount, held - prepared.price);
      this.#credit(prepared.seller, prepared.price);
    }
    this.calls.push({ kind: "transfer", wbId: prepared.wbId, buyer: prepared.buyer });
    Object.assign(record, {
      owner: prepared.buyer as Address,
      status: prepared.status,
      statusSeq: prepared.seq,
    });
    return this.#sign();
  }
}

/** A fresh oracle key, loaded the way the server loads its keypair file. */
export async function oracleSigner(): Promise<Signer> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const dir = await mkdtemp(join(tmpdir(), "wb-oracle-"));
  try {
    const path = join(dir, "oracle.json");
    await writeFile(path, JSON.stringify([...secret, ...pub]));
    return await loadKeypairSigner(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Records a public photo of the asset as its profile photo, which publishing requires, without
 * storing a file: for tests that publish without object storage. Recorded as a third party's, so
 * no automated check is queued for it.
 */
export async function addProfilePhoto(prisma: PrismaClient, wbId: string): Promise<string> {
  const asset = await prisma.asset.findUniqueOrThrow({ where: { wbId } });
  const id = randomUUID();
  await prisma.evidence.create({
    data: {
      id,
      assetId: asset.id,
      uploaderId: asset.ownerId,
      type: "PHOTO",
      source: "THIRD_PARTY",
      storageKey: `evidence/${asset.id}/${id}.jpg`,
      publicStorageKey: `public/${asset.id}/${id}`,
      sha256: randomBytes(32).toString("hex"),
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      visibility: "PUBLIC",
    },
  });
  await prisma.asset.update({ where: { id: asset.id }, data: { profileEvidenceId: id } });
  return id;
}
