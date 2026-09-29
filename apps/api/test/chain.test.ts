import { randomUUID } from "node:crypto";
import {
  chainAddresses,
  type ChainRecordState,
  StaleChainUpdateError,
  type WorthyBoundOracle,
} from "@worthybound/solana";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHAIN_ATTEMPTS } from "../src/chain/sync.js";
import { recordKyc } from "../src/cli/kyc-record.js";
import {
  type Clock,
  createTestDatabase,
  signIn,
  TEST_DATABASE_URL,
  testApp,
  testClock,
  TestWallet,
  type TestDatabase,
} from "./helpers.js";

type Address = ChainRecordState["owner"];
type Signature = Awaited<ReturnType<WorthyBoundOracle["updateStatus"]>>;

type Call =
  | { kind: "register"; wbId: string; owner: string; uri: string; status: string; seq: bigint }
  | { kind: "status"; wbId: string; status: string; seq: bigint }
  | { kind: "trust"; wbId: string; score: number; level: string; seq: bigint };

/** In-memory stand-in for the program: keeps records and rejects stale sequence numbers. */
class FakeOracle implements WorthyBoundOracle {
  readonly oracleAddress = "Orac1e1111111111111111111111111111111111111" as Address;
  readonly records = new Map<string, ChainRecordState & { status: string; score?: number }>();
  readonly calls: Call[] = [];
  failures = 0;
  #n = 0;

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

  async registerAsset(input: Parameters<WorthyBoundOracle["registerAsset"]>[0]) {
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

  async updateStatus(input: Parameters<WorthyBoundOracle["updateStatus"]>[0]) {
    this.#maybeFail();
    const record = this.records.get(input.wbId);
    if (!record) throw new Error("AccountNotInitialized");
    if (input.statusSeq <= record.statusSeq) throw new StaleChainUpdateError();
    this.calls.push({ kind: "status", ...input, seq: input.statusSeq });
    Object.assign(record, { status: input.status, statusSeq: input.statusSeq });
    return this.#sign();
  }

  async commitTrustScore(input: Parameters<WorthyBoundOracle["commitTrustScore"]>[0]) {
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
}

describe.skipIf(!TEST_DATABASE_URL)("tokenization and chain sync", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let offline: FastifyInstance;
  let oracle: FakeOracle;
  let clock: Clock;
  let kick: () => void;

  beforeAll(async () => {
    db = await createTestDatabase();
    oracle = new FakeOracle();
    clock = testClock();
    app = await testApp(db.prisma, { oracle, now: clock.now });
    offline = await testApp(db.prisma);
    // Jobs run when a test calls runOnce, so tests control the order.
    const sync = app.chainSync!;
    kick = sync.kick.bind(sync);
    sync.kick = () => {};
  });

  afterAll(async () => {
    await app?.close();
    await offline?.close();
    await db?.drop();
  });

  beforeEach(() => {
    oracle.calls.length = 0;
    oracle.failures = 0;
  });

  interface Owner {
    wallet: TestWallet;
    token: string;
  }

  const owner = async ({ kyc = true } = {}): Promise<Owner> => {
    const wallet = new TestWallet();
    const token = await signIn(app, wallet);
    if (kyc) {
      await recordKyc(db.prisma, {
        walletAddress: wallet.address,
        provider: "acme-kyc",
        reference: `case-${randomUUID()}`,
        status: "VERIFIED",
      });
    }
    return { wallet, token };
  };

  const call = (who: Owner | null, method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      cookies: who ? { wb_session: who.token } : {},
    });

  const draft = async (who: Owner) => {
    const res = await call(who, "POST", "/assets", {
      category: "LUXURY_WATCH",
      brand: "Rolex",
      model: "Submariner",
      serialNumber: `SN-${randomUUID().slice(0, 13)}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ wbId: string }>().wbId;
  };

  const published = async (who: Owner) => {
    const wbId = await draft(who);
    expect((await call(who, "POST", `/assets/${wbId}/publish`)).statusCode).toBe(200);
    return wbId;
  };

  const tokenized = async (who: Owner) => {
    const wbId = await published(who);
    expect((await call(who, "POST", `/assets/${wbId}/tokenize`)).statusCode).toBe(202);
    await app.chainSync?.runOnce();
    expect((await assetRow(wbId)).tokenizationStatus).toBe("TOKENIZED");
    oracle.calls.length = 0;
    return wbId;
  };

  const assetRow = (wbId: string) => db.prisma.asset.findUniqueOrThrow({ where: { wbId } });
  const jobs = async (wbId: string) => {
    const { id } = await assetRow(wbId);
    return db.prisma.chainTransaction.findMany({
      where: { entityId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  };
  const statusSeq = async (wbId: string) =>
    BigInt(await db.prisma.assetStatusEvent.count({ where: { asset: { wbId } } }));

  describe("POST /assets/:wbId/tokenize", () => {
    it("is unavailable without an oracle key", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      const res = await offline.inject({
        method: "POST",
        url: `/assets/${wbId}/tokenize`,
        cookies: { wb_session: alice.token },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("tokenization_unavailable");
    });

    it("needs a published asset, a verified identity and the owner", async () => {
      const alice = await owner();
      const unpublished = await draft(alice);
      const res = await call(alice, "POST", `/assets/${unpublished}/tokenize`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("not_tokenizable");

      const bob = await owner({ kyc: false });
      const bobs = await published(bob);
      const noKyc = await call(bob, "POST", `/assets/${bobs}/tokenize`);
      expect(noKyc.statusCode).toBe(403);
      expect(noKyc.json().error.code).toBe("identity_verification_required");

      expect((await call(alice, "POST", `/assets/${bobs}/tokenize`)).statusCode).toBe(404);
      expect((await call(null, "POST", `/assets/${bobs}/tokenize`)).statusCode).toBe(401);
      expect(await jobs(bobs)).toEqual([]);
    });

    it("refuses lost or stolen assets", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REPORTED_STOLEN" });
      const res = await call(alice, "POST", `/assets/${wbId}/tokenize`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("not_tokenizable");
    });

    it("mints a frozen token to the owner's wallet and mirrors status and Trust Score", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      const { record, coreAsset } = await chainAddresses(wbId);

      const res = await call(alice, "POST", `/assets/${wbId}/tokenize`);
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toMatchObject({
        tokenizationStatus: "PENDING",
        chainAssetAddress: coreAsset,
        chainRecordAddress: record,
      });
      // Repeating the request while pending changes nothing.
      expect((await call(alice, "POST", `/assets/${wbId}/tokenize`)).statusCode).toBe(202);
      const pending = (await call(null, "GET", `/passport/${wbId}`)).json().passport;
      expect(pending.tokenization).toEqual({
        status: "PENDING",
        chainAssetAddress: null,
        chainRecordAddress: null,
      });

      await app.chainSync?.runOnce();

      const asset = await assetRow(wbId);
      expect(asset.tokenizationStatus).toBe("TOKENIZED");
      expect(oracle.calls).toEqual([
        {
          kind: "register",
          wbId,
          owner: alice.wallet.address,
          uri: `http://127.0.0.1:4000/metadata/${wbId}`,
          status: "ACTIVE",
          statusSeq: await statusSeq(wbId),
          seq: await statusSeq(wbId),
        },
        expect.objectContaining({ kind: "trust", wbId, score: asset.currentTrustScore, seq: 1n }),
      ]);
      // The status job queued after registration was already covered by it.
      expect((await jobs(wbId)).map((j) => [j.kind, j.status])).toEqual([
        ["REGISTER_ASSET", "CONFIRMED"],
        ["UPDATE_ASSET_STATUS", "SUPERSEDED"],
        ["COMMIT_TRUST_SCORE", "CONFIRMED"],
      ]);

      const passport = (await call(null, "GET", `/passport/${wbId}`)).json().passport;
      expect(passport.tokenization).toEqual({
        status: "TOKENIZED",
        chainAssetAddress: coreAsset,
        chainRecordAddress: record,
      });
      expect(passport.chainTransactions.map((t: { kind: string }) => t.kind).sort()).toEqual([
        "COMMIT_TRUST_SCORE",
        "REGISTER_ASSET",
      ]);
      const provenance = await db.prisma.provenanceEvent.findFirstOrThrow({
        where: { assetId: asset.id, type: "TOKENIZED" },
      });
      expect(provenance.payload).toMatchObject({ cluster: "devnet", record, coreAsset });

      const again = await call(alice, "POST", `/assets/${wbId}/tokenize`);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe("already_tokenized");
    });

    it("starts registration right after the request", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      const sync = app.chainSync!;
      sync.kick = kick;
      try {
        expect((await call(alice, "POST", `/assets/${wbId}/tokenize`)).statusCode).toBe(202);
        await vi.waitFor(async () =>
          expect((await assetRow(wbId)).tokenizationStatus).toBe("TOKENIZED"),
        );
      } finally {
        sync.kick = () => {};
      }
    });

    it("mirrors later status changes with increasing sequence numbers", async () => {
      const alice = await owner();
      const wbId = await tokenized(alice);

      await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REPORTED_LOST" });
      await app.chainSync?.runOnce();
      const seq = await statusSeq(wbId);
      expect(oracle.calls).toContainEqual({
        kind: "status",
        wbId,
        status: "REPORTED_LOST",
        statusSeq: seq,
        seq,
      });
      expect(oracle.records.get(wbId)).toMatchObject({ status: "REPORTED_LOST", statusSeq: seq });

      // Nothing changed, so nothing new is queued or sent.
      oracle.calls.length = 0;
      await app.chainSync?.runOnce();
      expect(oracle.calls).toEqual([]);
    });

    it("queues changes made while pending and sends them after registration", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      await call(alice, "POST", `/assets/${wbId}/tokenize`);
      await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REPORTED_LOST" });

      await app.chainSync?.runOnce();
      expect((await assetRow(wbId)).tokenizationStatus).toBe("FAILED");
      expect(oracle.calls).toEqual([]);
      const [register] = await jobs(wbId);
      expect(register).toMatchObject({
        kind: "REGISTER_ASSET",
        status: "FAILED",
        attempts: MAX_CHAIN_ATTEMPTS,
        lastError: "asset_not_tokenizable: status REPORTED_LOST",
      });

      // Once the item is found again it can be tokenized; the latest state is registered.
      await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REVERIFICATION_REQUIRED" });
      expect((await call(alice, "POST", `/assets/${wbId}/tokenize`)).statusCode).toBe(202);
      await app.chainSync?.runOnce();
      expect((await assetRow(wbId)).tokenizationStatus).toBe("TOKENIZED");
      expect(oracle.records.get(wbId)).toMatchObject({
        status: "REVERIFICATION_REQUIRED",
        statusSeq: await statusSeq(wbId),
      });
      expect(oracle.calls.filter((c) => c.kind === "status")).toEqual([]);
    });

    it("retries failed jobs with a delay and gives up after the last attempt", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      await call(alice, "POST", `/assets/${wbId}/tokenize`);

      oracle.failures = 1;
      await app.chainSync?.runOnce();
      expect((await jobs(wbId))[0]).toMatchObject({
        status: "FAILED",
        attempts: 1,
        lastError: "RPC unavailable",
      });
      expect((await assetRow(wbId)).tokenizationStatus).toBe("PENDING");

      // Not due yet.
      await app.chainSync?.runOnce();
      expect((await jobs(wbId))[0]?.attempts).toBe(1);

      clock.advance(10 * 60_000);
      await app.chainSync?.runOnce();
      expect((await assetRow(wbId)).tokenizationStatus).toBe("TOKENIZED");
      expect((await jobs(wbId))[0]).toMatchObject({
        status: "CONFIRMED",
        attempts: 2,
        lastError: null,
      });

      const bobWbId = await published(alice);
      await call(alice, "POST", `/assets/${bobWbId}/tokenize`);
      oracle.failures = MAX_CHAIN_ATTEMPTS;
      for (let i = 0; i < MAX_CHAIN_ATTEMPTS; i++) {
        await app.chainSync?.runOnce();
        clock.advance(10 * 60_000);
      }
      expect((await jobs(bobWbId))[0]).toMatchObject({
        status: "FAILED",
        attempts: MAX_CHAIN_ATTEMPTS,
      });
      expect((await assetRow(bobWbId)).tokenizationStatus).toBe("FAILED");

      // The owner can try again.
      expect((await call(alice, "POST", `/assets/${bobWbId}/tokenize`)).statusCode).toBe(202);
      await app.chainSync?.runOnce();
      expect((await assetRow(bobWbId)).tokenizationStatus).toBe("TOKENIZED");
    });
  });

  describe("GET /metadata/:wbId", () => {
    it("serves token metadata from the public passport only", async () => {
      const alice = await owner();
      const wbId = await tokenized(alice);
      const res = await call(null, "GET", `/metadata/${wbId}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      const body = res.json();
      expect(body).toMatchObject({
        name: `WorthyBound ${wbId}`,
        external_url: `https://worthybound.test/passport/${wbId}`,
      });
      expect(body.description).toContain("A token is not proof of authenticity.");
      expect(body.attributes).toEqual(
        expect.arrayContaining([
          { trait_type: "WB ID", value: wbId },
          { trait_type: "Brand", value: "Rolex" },
          { trait_type: "Status", value: "Active" },
        ]),
      );
      const { serialNumber } = await assetRow(wbId);
      expect(JSON.stringify(body)).not.toContain(serialNumber);
      expect(JSON.stringify(body)).not.toContain(alice.wallet.address);
    });

    it("has no metadata for drafts or unknown IDs", async () => {
      const alice = await owner();
      expect((await call(null, "GET", `/metadata/${await draft(alice)}`)).statusCode).toBe(404);
      expect((await call(null, "GET", "/metadata/WB-00000000")).statusCode).toBe(404);
    });
  });
});
