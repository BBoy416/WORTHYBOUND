import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddressEncoder } from "@solana/addresses";
import {
  buildTransferTransaction,
  chainAddresses,
  type ChainRecordState,
  completeTransferTransaction,
  loadKeypairSigner,
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
  | { kind: "transfer"; wbId: string; buyer: string };

type Signer = Awaited<ReturnType<typeof loadKeypairSigner>>;

/** In-memory stand-in for the program: keeps records and rejects stale sequence numbers. */
class FakeOracle implements WorthyBoundOracle {
  readonly records = new Map<string, ChainRecordState & { status: string; score?: number }>();
  readonly calls: Call[] = [];
  /** Prepared transfers by transaction, to apply when sent. */
  readonly #prepared = new Map<
    string,
    { wbId: string; seller: string; buyer: string; status: string; seq: bigint }
  >();
  failures = 0;
  /** Lamports by wallet; wallets not listed hold 10 SOL. */
  readonly balances = new Map<string, bigint>();
  #n = 0;

  constructor(readonly signer: Signer) {}

  get oracleAddress() {
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
    this.#prepared.set(transaction, { ...input, status: input.statusAfter, seq: input.statusSeq });
    return { transaction, nonceAccount };
  }

  async getBalance(address: string) {
    this.#maybeFail();
    return this.balances.get(address) ?? 10_000_000_000n;
  }

  async sendTransfer(input: Parameters<WorthyBoundOracle["sendTransfer"]>[0]) {
    this.#maybeFail();
    // Throws unless seller and buyer signed; the oracle signs last.
    await completeTransferTransaction(input.transaction, input.signatures, this.signer);
    const prepared = this.#prepared.get(input.transaction);
    const record = prepared && this.records.get(prepared.wbId);
    if (!prepared || !record) throw new Error("AccountNotInitialized");
    if (record.status !== "TRANSFER_PENDING") throw new Error("NotTransferPending");
    if (record.owner !== prepared.seller) throw new Error("NotOwner");
    if (prepared.seq <= record.statusSeq) throw new Error("StaleUpdate");
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
async function oracleSigner(): Promise<Signer> {
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

/** Signs a base64 wire transaction with the wallet, as a browser wallet does. */
function walletSign(wallet: TestWallet, transaction: string): string {
  const bytes = Buffer.from(transaction, "base64");
  const signatures = bytes[0] as number;
  const message = bytes.subarray(1 + 64 * signatures);
  const key = Buffer.from(getAddressEncoder().encode(wallet.address as Address));
  // Legacy message: 3 header bytes, the number of account keys, then the keys; signers first.
  const index = [...Array(signatures).keys()].find((i) =>
    message.subarray(4 + 32 * i, 36 + 32 * i).equals(key),
  );
  if (index === undefined) throw new Error("wallet is not a signer");
  wallet.sign(message).copy(bytes, 1 + 64 * index);
  return bytes.toString("base64");
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
    oracle = new FakeOracle(await oracleSigner());
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
    oracle.balances.clear();
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

  describe("transfers", () => {
    interface TransferView {
      id: string;
      role: string;
      status: string;
      closedReason: string | null;
      transaction: string | null;
      signedBySeller: boolean;
      signedByBuyer: boolean;
      awaitingYourSignature: boolean;
      chain: { status: string; signature: string | null } | null;
    }

    const start = async (from: Owner, wbId: string, to: Owner, expect201 = true) => {
      const res = await call(from, "POST", "/transfers", {
        assetId: wbId,
        toWalletAddress: to.wallet.address,
      });
      if (expect201) expect(res.statusCode, res.body).toBe(201);
      return res;
    };
    const act = async (who: Owner, id: string, action: string, payload?: object) => {
      const res = await call(who, "POST", `/transfers/${id}/${action}`, payload);
      return { status: res.statusCode, body: res.json(), transfer: res.json<TransferView>() };
    };
    const sign = (who: Owner, t: TransferView) =>
      act(who, t.id, "signature", {
        signedTransaction: walletSign(who.wallet, t.transaction as string),
      });
    const statusReasons = async (wbId: string) =>
      (
        await db.prisma.assetStatusEvent.findMany({
          where: { asset: { wbId } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      ).map((e) => [e.toStatus, e.reason]);

    it("hands a tokenized asset to a buyer with a verified identity once both have signed", async () => {
      const alice = await owner();
      const bob = await owner();
      const wbId = await tokenized(alice);

      const started = (await start(alice, wbId, bob)).json<TransferView>();
      expect(started).toMatchObject({ role: "SENDER", status: "PENDING", transaction: null });
      expect((await assetRow(wbId)).status).toBe("TRANSFER_PENDING");
      await app.chainSync?.runOnce();
      expect(oracle.records.get(wbId)).toMatchObject({ status: "TRANSFER_PENDING" });

      const incoming = (await call(bob, "GET", "/transfers")).json<{ items: TransferView[] }>();
      expect(incoming.items).toEqual([
        expect.objectContaining({ id: started.id, role: "RECIPIENT", status: "PENDING" }),
      ]);

      const accepted = await act(bob, started.id, "accept");
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.transfer).toMatchObject({ status: "ACCEPTED", awaitingYourSignature: true });
      expect(accepted.transfer.transaction).toEqual(expect.any(String));
      const seq = await statusSeq(wbId);
      expect(oracle.calls).toContainEqual({
        kind: "prepare",
        wbId,
        seller: alice.wallet.address,
        buyer: bob.wallet.address,
        status: "ACTIVE",
        seq: seq + 1n,
        price: 0n,
      });
      // Accepting again changes nothing.
      expect((await act(bob, started.id, "accept")).transfer.transaction).toBe(
        accepted.transfer.transaction,
      );

      const buyerSigned = await sign(bob, accepted.transfer);
      expect(buyerSigned.status, JSON.stringify(buyerSigned.body)).toBe(200);
      expect(buyerSigned.transfer).toMatchObject({
        signedByBuyer: true,
        signedBySeller: false,
        awaitingYourSignature: false,
        chain: null,
      });
      const forSeller = (await call(alice, "GET", `/transfers/${started.id}`)).json<TransferView>();
      expect(forSeller.awaitingYourSignature).toBe(true);
      const sellerSigned = await sign(alice, forSeller);
      expect(sellerSigned.transfer.chain).toEqual({ status: "PENDING", signature: null });

      await app.chainSync?.runOnce();
      const done = (await call(bob, "GET", `/transfers/${started.id}`)).json<TransferView>();
      expect(done).toMatchObject({ status: "COMPLETED", chain: { status: "CONFIRMED" } });
      expect(oracle.records.get(wbId)).toMatchObject({
        owner: bob.wallet.address,
        status: "ACTIVE",
        statusSeq: seq + 1n,
      });

      const asset = await assetRow(wbId);
      const bobUser = await db.prisma.user.findUniqueOrThrow({
        where: { walletAddress: bob.wallet.address },
      });
      expect(asset).toMatchObject({ ownerId: bobUser.id, status: "ACTIVE" });
      expect((await statusReasons(wbId)).slice(-2)).toEqual([
        ["TRANSFER_PENDING", "transfer_requested"],
        ["ACTIVE", "transfer_completed"],
      ]);
      const ownerships = await db.prisma.ownership.findMany({
        where: { assetId: asset.id },
        orderBy: { startedAt: "asc" },
      });
      expect(ownerships.map((o) => [o.reason, o.endedAt === null])).toEqual([
        ["REGISTRATION", false],
        ["TRANSFER", true],
      ]);
      expect(ownerships[0]?.endedAt?.getTime()).toBe(ownerships[1]?.startedAt.getTime());
      expect(
        await db.prisma.provenanceEvent.count({
          where: { assetId: asset.id, type: "TRANSFER_COMPLETED" },
        }),
      ).toBe(1);
      expect((await call(alice, "GET", `/assets/${wbId}`)).statusCode).toBe(404);
      expect((await call(bob, "GET", `/assets/${wbId}`)).statusCode).toBe(200);

      const passport = (await call(null, "GET", `/passport/${wbId}`)).json().passport;
      expect(passport.custody.transferCount).toBe(1);
      expect(passport.chainTransactions.map((t: { kind: string }) => t.kind)).toContain(
        "TRANSFER_ASSET",
      );
      expect(JSON.stringify(passport)).not.toContain(bob.wallet.address);
    });

    it("puts the agreed price in the transaction and checks the buyer can pay before signing", async () => {
      const alice = await owner();
      const bob = await owner();
      const wbId = await tokenized(alice);
      const res = await call(alice, "POST", "/transfers", {
        assetId: wbId,
        toWalletAddress: bob.wallet.address,
        priceLamports: "2500000000",
      });
      expect(res.statusCode, res.body).toBe(201);
      const started = res.json<TransferView & { priceLamports: string }>();
      expect(started.priceLamports).toBe("2500000000");
      const incoming = (await call(bob, "GET", `/transfers/${started.id}`)).json();
      expect(incoming.priceLamports).toBe("2500000000");

      const { transfer } = await act(bob, started.id, "accept");
      expect(oracle.calls).toContainEqual(
        expect.objectContaining({ kind: "prepare", price: 2_500_000_000n }),
      );

      oracle.balances.set(bob.wallet.address, 2_499_999_999n);
      const poor = await sign(bob, transfer);
      expect(poor.status).toBe(422);
      expect(poor.body.error.code).toBe("insufficient_funds");
      oracle.failures = 1;
      expect((await sign(bob, transfer)).body.error.code).toBe("chain_unavailable");
      oracle.balances.set(bob.wallet.address, 2_500_000_000n);
      expect((await sign(bob, transfer)).transfer.signedByBuyer).toBe(true);
      // The seller receives the price and is not asked to hold any.
      oracle.balances.set(alice.wallet.address, 0n);
      expect((await sign(alice, transfer)).transfer.signedBySeller).toBe(true);

      const audit = await db.prisma.auditLog.findFirstOrThrow({
        where: { targetId: started.id, action: "transfer.requested" },
      });
      expect(audit.metadata).toMatchObject({ priceLamports: "2500000000" });
      await expect(
        db.prisma.transferRequest.update({
          where: { id: started.id },
          data: { priceLamports: 1n },
        }),
      ).rejects.toThrow(/transfer price cannot change/);
    });

    it("needs a tokenized asset and a signed-in recipient with a verified identity", async () => {
      const alice = await owner();
      const bob = await owner();
      const unverified = await owner({ kyc: false });

      const notTokenized = await start(alice, await published(alice), bob, false);
      expect(notTokenized.statusCode).toBe(409);
      expect(notTokenized.json().error.code).toBe("not_transferable");

      const wbId = await tokenized(alice);
      const stranger = await call(alice, "POST", "/transfers", {
        assetId: wbId,
        toWalletAddress: new TestWallet().address,
      });
      expect(stranger.statusCode).toBe(422);
      expect(stranger.json().error.code).toBe("recipient_not_found");
      const noKyc = await start(alice, wbId, unverified, false);
      expect(noKyc.json().error.code).toBe("recipient_identity_not_verified");
      expect((await start(alice, wbId, alice, false)).json().error.code).toBe("same_owner");
      expect((await start(bob, wbId, alice, false)).statusCode).toBe(404);
      const offlineStart = await offline.inject({
        method: "POST",
        url: "/transfers",
        payload: { assetId: wbId, toWalletAddress: bob.wallet.address },
        cookies: { wb_session: alice.token },
      });
      expect(offlineStart.statusCode).toBe(503);
      expect((await assetRow(wbId)).status).toBe("ACTIVE");

      const { id } = (await start(alice, wbId, bob)).json<TransferView>();
      expect((await start(alice, wbId, bob, false)).json().error.code).toBe("transfer_open");
      expect((await call(unverified, "GET", `/transfers/${id}`)).statusCode).toBe(404);
      expect((await act(alice, id, "accept")).status).toBe(404);

      oracle.failures = 1;
      const unreachable = await act(bob, id, "accept");
      expect(unreachable.status).toBe(503);
      expect(unreachable.body.error.code).toBe("chain_unavailable");
      expect((await act(bob, id, "accept")).transfer.status).toBe("ACCEPTED");
    });

    it("accepts only the parties' signatures of the prepared transaction", async () => {
      const alice = await owner();
      const bob = await owner();
      const wbId = await tokenized(alice);
      const { id } = (await start(alice, wbId, bob)).json<TransferView>();
      expect(
        (await act(alice, id, "signature", { signedTransaction: "AQID" })).body.error.code,
      ).toBe("not_ready_to_sign");
      const { transfer } = await act(bob, id, "accept");

      const wrongWallet = await act(bob, id, "signature", {
        signedTransaction: walletSign(alice.wallet, transfer.transaction as string),
      });
      expect(wrongWallet.status).toBe(422);
      expect(wrongWallet.body.error.code).toBe("invalid_signature");
      const unsigned = await act(bob, id, "signature", {
        signedTransaction: transfer.transaction as string,
      });
      expect(unsigned.body.error.message).toBe("The transaction is not signed by your wallet");
      const changed = Buffer.from(walletSign(bob.wallet, transfer.transaction as string), "base64");
      changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
      const tampered = await act(bob, id, "signature", {
        signedTransaction: changed.toString("base64"),
      });
      expect(tampered.body.error.message).toBe(
        "The wallet changed the transaction; sign it without changes",
      );
      expect((await sign(bob, transfer)).transfer.signedByBuyer).toBe(true);
    });

    it("returns the asset to its status when the transfer is rejected, cancelled or expires", async () => {
      const alice = await owner();
      const bob = await owner();
      const wbId = await tokenized(alice);

      const first = (await start(alice, wbId, bob)).json<TransferView>();
      expect((await act(bob, first.id, "cancel")).body.error.code).toBe("forbidden_transition");
      expect((await act(bob, first.id, "reject")).transfer).toMatchObject({
        status: "REJECTED",
        closedReason: "rejected",
      });
      expect((await assetRow(wbId)).status).toBe("ACTIVE");

      const second = (await start(alice, wbId, bob)).json<TransferView>();
      await act(bob, second.id, "accept");
      expect((await act(alice, second.id, "cancel")).transfer).toMatchObject({
        status: "CANCELLED",
        closedReason: "cancelled_by_sender",
        transaction: null,
      });
      expect((await assetRow(wbId)).status).toBe("ACTIVE");

      const third = (await start(alice, wbId, bob)).json<TransferView>();
      clock.advance(73 * 60 * 60_000);
      const list = (await call(alice, "GET", "/transfers")).json<{ items: TransferView[] }>();
      expect(list.items.find((t) => t.id === third.id)).toMatchObject({
        status: "EXPIRED",
        closedReason: "expired",
      });
      expect((await assetRow(wbId)).status).toBe("ACTIVE");
      expect((await statusReasons(wbId)).slice(-6).map(([, reason]) => reason)).toEqual([
        "transfer_requested",
        "transfer_rejected",
        "transfer_requested",
        "transfer_cancelled",
        "transfer_requested",
        "transfer_expired",
      ]);

      await app.chainSync?.runOnce();
      expect(oracle.records.get(wbId)).toMatchObject({
        status: "ACTIVE",
        statusSeq: await statusSeq(wbId),
      });
    });

    it("is cancelled when the owner reports the item stolen", async () => {
      const alice = await owner();
      const bob = await owner();
      const wbId = await tokenized(alice);
      const { id } = (await start(alice, wbId, bob)).json<TransferView>();
      const res = await call(alice, "POST", `/assets/${wbId}/status`, {
        toStatus: "REPORTED_STOLEN",
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await call(bob, "GET", `/transfers/${id}`)).json()).toMatchObject({
        status: "CANCELLED",
        closedReason: "asset_reported_stolen",
      });
      expect((await assetRow(wbId)).status).toBe("REPORTED_STOLEN");
    });

    it("cannot be cancelled while the signed transaction is being sent, unless sending gave up", async () => {
      const alice = await owner();
      const bob = await owner();
      const wbId = await tokenized(alice);
      const { id } = (await start(alice, wbId, bob)).json<TransferView>();
      await app.chainSync?.runOnce();
      const { transfer } = await act(bob, id, "accept");
      await sign(bob, transfer);
      await sign(alice, transfer);
      expect((await act(alice, id, "cancel")).body.error.code).toBe("transfer_in_progress");

      oracle.failures = MAX_CHAIN_ATTEMPTS;
      for (let i = 0; i < MAX_CHAIN_ATTEMPTS; i++) {
        await app.chainSync?.runOnce();
        clock.advance(10 * 60_000);
      }
      expect((await call(alice, "GET", `/transfers/${id}`)).json()).toMatchObject({
        status: "ACCEPTED",
        chain: { status: "FAILED" },
      });
      expect((await act(bob, id, "cancel")).transfer).toMatchObject({
        status: "CANCELLED",
        closedReason: "cancelled_by_recipient",
      });
      expect(oracle.records.get(wbId)?.owner).toBe(alice.wallet.address);
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
