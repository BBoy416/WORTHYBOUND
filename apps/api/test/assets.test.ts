import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  signIn,
  TEST_DATABASE_URL,
  testApp,
  TestWallet,
  type TestDatabase,
} from "./helpers.js";

const SERIAL = "AB-1234-XYZ";

describe.skipIf(!TEST_DATABASE_URL)("assets and passports", () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await testApp(db.prisma);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  interface Owner {
    wallet: TestWallet;
    token: string;
  }

  const owner = async (): Promise<Owner> => {
    const wallet = new TestWallet();
    return { wallet, token: await signIn(app, wallet) };
  };

  const call = (
    who: Owner | null,
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
      cookies: who ? { wb_session: who.token } : {},
    });

  /** Unique serial per test so tests do not block each other. */
  const serial = () => `SN-${randomUUID().slice(0, 13)}`;

  const register = (who: Owner, body: object = {}, headers?: Record<string, string>) =>
    call(
      who,
      "POST",
      "/assets",
      { category: "LUXURY_WATCH", brand: "Rolex", model: "Submariner", ...body },
      headers,
    );

  const registered = async (who: Owner, body: object = {}) => {
    const res = await register(who, { serialNumber: serial(), ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ wbId: string; serialNumber: string | null }>();
  };

  const published = async (who: Owner, body: object = {}) => {
    const { wbId } = await registered(who, body);
    const res = await call(who, "POST", `/assets/${wbId}/publish`);
    expect(res.statusCode, res.body).toBe(200);
    return wbId;
  };

  const assetRow = (wbId: string) => db.prisma.asset.findUniqueOrThrow({ where: { wbId } });

  const audits = async (action: string, actorWallet: string) =>
    db.prisma.auditLog.findMany({
      where: { action, actor: { walletAddress: actorWallet } },
      orderBy: { createdAt: "asc" },
    });

  describe("registration", () => {
    it("creates a private draft with its first custody period, history and audit entry", async () => {
      const alice = await owner();
      const res = await register(alice, {
        serialNumber: SERIAL,
        description: "Bought in Geneva, box and papers",
        publicDescription: "Stainless steel diver's watch",
        attributes: { dial: "black", year: 2019 },
        condition: "EXCELLENT",
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        category: "LUXURY_WATCH",
        brand: "Rolex",
        model: "Submariner",
        serialNumber: SERIAL,
        condition: "EXCELLENT",
        status: "DRAFT",
        tokenizationStatus: "NOT_TOKENIZED",
        verificationLevel: "UNVERIFIED",
        publishedAt: null,
        passportUrl: null,
        missingForPublish: [],
      });
      expect(body.wbId).toMatch(/^WB-[0-9A-F]{8}$/);
      expect(body).not.toHaveProperty("serialFingerprint");
      expect(body).not.toHaveProperty("currentTrustScore");

      const asset = await db.prisma.asset.findUniqueOrThrow({
        where: { wbId: body.wbId },
        include: { ownerships: true, statusEvents: true, provenanceEvents: true },
      });
      expect(asset.serialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.serialFingerprint).not.toContain(SERIAL);
      expect(asset.ownerships).toMatchObject([{ reason: "REGISTRATION", endedAt: null }]);
      expect(asset.statusEvents).toMatchObject([{ fromStatus: null, toStatus: "DRAFT" }]);
      expect(asset.provenanceEvents).toMatchObject([
        { sequence: 1, type: "REGISTERED", prevHash: null },
      ]);
      const [audit] = await audits("asset.registered", alice.wallet.address);
      expect(audit).toMatchObject({ targetId: body.wbId });
      expect(JSON.stringify(audit)).not.toContain(SERIAL);
    });

    it("requires sign-in", async () => {
      const res = await call(null, "POST", "/assets", { category: "OTHER" });
      expect(res.statusCode).toBe(401);
    });

    it.each([
      ["status", { status: "VERIFIED" }],
      ["owner", { ownerId: randomUUID() }],
      ["Trust Score", { currentTrustScore: 100 }],
      ["WorthyBound ID", { wbId: "WB-00000000" }],
      ["chain address", { chainAssetAddress: "x" }],
    ])("rejects a client-supplied %s", async (_name, extra) => {
      const res = await register(await owner(), extra);
      expect(res.statusCode).toBe(400);
    });
  });

  describe("duplicate items", () => {
    it("rejects the same item registered by someone else, without mentioning serials", async () => {
      const [alice, mallory] = [await owner(), await owner()];
      const sn = serial();
      const original = await registered(alice, { serialNumber: sn });

      const res = await register(mallory, {
        brand: "ROLEX",
        serialNumber: ` ${sn.toLowerCase().replaceAll("-", " ")} `,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({
        error: {
          code: "registration_rejected",
          message:
            "This item can't be registered. If you believe this is a mistake, contact support.",
        },
      });
      expect(res.body.toLowerCase()).not.toContain("serial");
      expect(res.body).not.toContain(original.wbId);

      expect(
        await db.prisma.asset.count({
          where: { owner: { walletAddress: mallory.wallet.address } },
        }),
      ).toBe(0);
      const [blocked] = await audits("asset.registration_blocked", mallory.wallet.address);
      expect(blocked?.metadata).toEqual({
        reason: "duplicate_serial",
        conflictingWbId: original.wbId,
      });
    });

    it("also rejects the owner registering the same item twice", async () => {
      const alice = await owner();
      const sn = serial();
      await registered(alice, { serialNumber: sn });
      expect((await register(alice, { serialNumber: sn })).statusCode).toBe(422);
    });

    it("allows the same serial for a different brand or category", async () => {
      const alice = await owner();
      const sn = serial();
      await registered(alice, { serialNumber: sn });
      await registered(alice, { serialNumber: sn, brand: "Omega" });
      await registered(alice, { serialNumber: sn, category: "JEWELRY" });
    });

    it("allows several items without a serial", async () => {
      const alice = await owner();
      await registered(alice, { serialNumber: undefined });
      await registered(alice, { serialNumber: undefined });
    });

    it("releases the serial when a draft is discarded", async () => {
      const [alice, bob] = [await owner(), await owner()];
      const sn = serial();
      const { wbId } = await registered(alice, { serialNumber: sn });
      const discard = await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REVOKED" });
      expect(discard.statusCode).toBe(200);
      await registered(bob, { serialNumber: sn });
    });

    it("keeps blocking an item reported stolen", async () => {
      const [alice, thief] = [await owner(), await owner()];
      const sn = serial();
      const wbId = await published(alice, { serialNumber: sn });
      await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REPORTED_STOLEN" });
      expect((await register(thief, { serialNumber: sn })).statusCode).toBe(422);
    });

    it("accepts only one of several simultaneous registrations of the same item", async () => {
      const users = await Promise.all(Array.from({ length: 6 }, owner));
      const sn = serial();
      const results = await Promise.all(users.map((u) => register(u, { serialNumber: sn })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422, 422, 422, 422, 422]);
    });

    it("rejects editing a draft to the serial of an existing item", async () => {
      const [alice, mallory] = [await owner(), await owner()];
      const sn = serial();
      await registered(alice, { serialNumber: sn });
      const { wbId } = await registered(mallory);
      const res = await call(mallory, "PATCH", `/assets/${wbId}`, { serialNumber: sn });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("registration_rejected");
      expect((await assetRow(wbId)).serialNumber).not.toBe(sn);
      expect(await audits("asset.update_blocked", mallory.wallet.address)).toHaveLength(1);
    });
  });

  describe("idempotency", () => {
    it("returns the original asset when a request is retried with the same key", async () => {
      const alice = await owner();
      const key = randomUUID();
      const body = { serialNumber: serial() };
      const first = await register(alice, body, { "idempotency-key": key });
      const retry = await register(alice, body, { "idempotency-key": key });
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(retry.json().wbId).toBe(first.json().wbId);
      expect(
        await db.prisma.asset.count({ where: { owner: { walletAddress: alice.wallet.address } } }),
      ).toBe(1);
    });

    it("creates one asset for simultaneous retries", async () => {
      const alice = await owner();
      const key = randomUUID();
      const body = { serialNumber: serial() };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => register(alice, body, { "idempotency-key": key })),
      );
      expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.json().wbId)).size).toBe(1);
    });

    it("rejects a reused key with a different request", async () => {
      const alice = await owner();
      const key = randomUUID();
      await register(alice, { serialNumber: serial() }, { "idempotency-key": key });
      const res = await register(alice, { serialNumber: serial() }, { "idempotency-key": key });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("idempotency_key_reused");
    });

    it("keeps keys separate per user", async () => {
      const [alice, bob] = [await owner(), await owner()];
      const key = randomUUID();
      const a = await register(alice, {}, { "idempotency-key": key });
      const b = await register(bob, {}, { "idempotency-key": key });
      expect(b.statusCode).toBe(201);
      expect(b.json().wbId).not.toBe(a.json().wbId);
    });

    it("rejects malformed keys", async () => {
      const res = await register(await owner(), {}, { "idempotency-key": "bad key" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("access", () => {
    it("hides other people's assets exactly like assets that do not exist", async () => {
      const [alice, mallory] = [await owner(), await owner()];
      const { wbId } = await registered(alice);
      const attempts: ["GET" | "POST" | "PATCH", string, object?][] = [
        ["GET", ""],
        ["PATCH", "", { model: "Daytona" }],
        ["POST", "/publish"],
        ["POST", "/status", { toStatus: "REPORTED_STOLEN" }],
        ["POST", "/condition", { condition: "POOR" }],
      ];
      for (const [method, suffix, payload] of attempts) {
        const theirs = await call(mallory, method, `/assets/${wbId}${suffix}`, payload);
        const missing = await call(mallory, method, `/assets/WB-00000000${suffix}`, payload);
        expect(theirs.statusCode, `${method} ${suffix}`).toBe(404);
        expect(theirs.body).toBe(missing.body);
      }
      expect((await assetRow(wbId)).model).toBe("Submariner");
    });

    it("lists only the caller's assets, newest first, with pagination", async () => {
      const [alice, bob] = [await owner(), await owner()];
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push((await registered(alice)).wbId);
      await registered(bob);
      const discarded = (await registered(alice)).wbId;
      await call(alice, "POST", `/assets/${discarded}/status`, { toStatus: "REVOKED" });

      const page1 = (await call(alice, "GET", "/assets?limit=2")).json();
      expect(page1.items.map((a: { wbId: string }) => a.wbId)).toEqual([ids[2], ids[1]]);
      const page2 = (await call(alice, "GET", `/assets?limit=2&cursor=${page1.nextCursor}`)).json();
      expect(page2.items.map((a: { wbId: string }) => a.wbId)).toEqual([ids[0]]);
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe("editing", () => {
    it("lets the owner change any field of a draft and updates the fingerprint", async () => {
      const alice = await owner();
      const { wbId } = await registered(alice);
      const before = await assetRow(wbId);
      const res = await call(alice, "PATCH", `/assets/${wbId}`, {
        brand: "Omega",
        model: "Speedmaster",
        serialNumber: serial(),
        condition: "GOOD",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ brand: "Omega", model: "Speedmaster", condition: "GOOD" });
      expect((await assetRow(wbId)).serialFingerprint).not.toBe(before.serialFingerprint);
      const [audit] = await audits("asset.updated", alice.wallet.address);
      expect((audit?.metadata as { fields: string[] }).fields.sort()).toEqual([
        "brand",
        "condition",
        "model",
        "serialNumber",
      ]);
    });

    it.each([
      ["category", { category: "JEWELRY" }],
      ["brand", { brand: "Omega" }],
      ["model", { model: "Daytona" }],
      ["serialNumber", { serialNumber: "OTHER-123" }],
    ])("locks %s once published", async (field, change) => {
      const alice = await owner();
      const wbId = await published(alice);
      const res = await call(alice, "PATCH", `/assets/${wbId}`, change);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toEqual({
        code: "field_locked",
        message: `These fields cannot be changed after publishing: ${field}`,
      });
    });

    it("records public description changes of a published asset in its history", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      const res = await call(alice, "PATCH", `/assets/${wbId}`, {
        publicDescription: "Serviced in 2026",
        description: "private note",
        attributes: { bracelet: "oyster" },
      });
      expect(res.statusCode).toBe(200);
      const events = await db.prisma.provenanceEvent.findMany({
        where: { asset: { wbId } },
        orderBy: { sequence: "asc" },
      });
      expect(events.map((e) => e.type)).toEqual([
        "REGISTERED",
        "STATUS_CHANGED",
        "DETAILS_UPDATED",
      ]);
      expect(events[2]?.payload).toEqual({ fields: ["publicDescription"] });
    });

    it("sends condition changes of a published asset to the condition endpoint", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      const res = await call(alice, "PATCH", `/assets/${wbId}`, { condition: "FAIR" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("use_condition_endpoint");
    });

    it("does nothing when nothing changes", async () => {
      const alice = await owner();
      const { wbId } = await registered(alice);
      const res = await call(alice, "PATCH", `/assets/${wbId}`, { brand: "Rolex" });
      expect(res.statusCode).toBe(200);
      expect(await audits("asset.updated", alice.wallet.address)).toHaveLength(0);
    });
  });

  describe("publishing", () => {
    it("requires brand and model", async () => {
      const alice = await owner();
      const { wbId } = await registered(alice, { brand: undefined, model: undefined });
      expect((await call(alice, "GET", `/assets/${wbId}`)).json().missingForPublish).toEqual([
        "brand",
        "model",
      ]);
      const res = await call(alice, "POST", `/assets/${wbId}/publish`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toEqual({
        code: "publish_requirements_missing",
        message: "Add brand and model before publishing",
      });
    });

    it("publishes the passport and records it", async () => {
      const alice = await owner();
      const { wbId } = await registered(alice);
      const res = await call(alice, "POST", `/assets/${wbId}/publish`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "ACTIVE",
        passportUrl: `https://worthybound.test/passport/${wbId}`,
      });
      expect(res.json().publishedAt).not.toBeNull();
      const asset = await db.prisma.asset.findUniqueOrThrow({
        where: { wbId },
        include: { statusEvents: { orderBy: { createdAt: "asc" } } },
      });
      expect(asset.statusEvents.map((e) => [e.fromStatus, e.toStatus])).toEqual([
        [null, "DRAFT"],
        ["DRAFT", "ACTIVE"],
      ]);
      expect(await audits("asset.published", alice.wallet.address)).toHaveLength(1);

      const again = await call(alice, "POST", `/assets/${wbId}/publish`);
      expect(again.statusCode).toBe(409);
    });
  });

  describe("status changes", () => {
    it("lets the owner report an asset lost and then recovered", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      const lost = await call(alice, "POST", `/assets/${wbId}/status`, {
        toStatus: "REPORTED_LOST",
        reason: "Left on a train",
      });
      expect(lost.statusCode).toBe(200);
      const found = await call(alice, "POST", `/assets/${wbId}/status`, {
        toStatus: "REVERIFICATION_REQUIRED",
      });
      expect(found.json().status).toBe("REVERIFICATION_REQUIRED");
      const events = await db.prisma.provenanceEvent.findMany({
        where: { asset: { wbId } },
        orderBy: { sequence: "asc" },
      });
      expect(events.map((e) => e.type)).toEqual([
        "REGISTERED",
        "STATUS_CHANGED",
        "REPORTED_LOST",
        "RECOVERED",
      ]);
    });

    it.each([
      [
        "clear a stolen report",
        "REPORTED_STOLEN",
        "REVERIFICATION_REQUIRED",
        "forbidden_transition",
      ],
      ["mark an asset verified", null, "VERIFIED", "forbidden_transition"],
      ["revoke a published asset", null, "REVOKED", "forbidden_transition"],
      ["start a transfer here", null, "TRANSFER_PENDING", "forbidden_transition"],
    ])("does not let the owner %s", async (_name, first, toStatus, code) => {
      const alice = await owner();
      const wbId = await published(alice);
      if (first) await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: first });
      const res = await call(alice, "POST", `/assets/${wbId}/status`, { toStatus });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe(code);
    });

    it("points drafts to the publish endpoint", async () => {
      const alice = await owner();
      const { wbId } = await registered(alice);
      const res = await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "ACTIVE" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain("/publish");
    });

    it("hides a discarded draft from its owner and the public", async () => {
      const alice = await owner();
      const { wbId } = await registered(alice);
      await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REVOKED" });
      expect((await call(alice, "GET", `/assets/${wbId}`)).statusCode).toBe(404);
      expect((await call(null, "GET", `/passport/${wbId}`)).statusCode).toBe(404);
      expect((await assetRow(wbId)).status).toBe("REVOKED");
    });
  });

  describe("condition", () => {
    it("records the owner-stated condition in the history", async () => {
      const alice = await owner();
      const wbId = await published(alice, { condition: "EXCELLENT" });
      const res = await call(alice, "POST", `/assets/${wbId}/condition`, {
        condition: "GOOD",
        note: "Scratch on the bezel",
      });
      expect(res.statusCode).toBe(200);
      const event = await db.prisma.provenanceEvent.findFirstOrThrow({
        where: { asset: { wbId }, type: "CONDITION_UPDATED" },
      });
      expect(event.payload).toEqual({
        fromCondition: "EXCELLENT",
        condition: "GOOD",
        note: "Scratch on the bezel",
      });
      const passport = (await call(null, "GET", `/passport/${wbId}`)).json().passport;
      expect(passport.condition).toEqual({ ownerStated: "GOOD", verified: null });
    });
  });

  describe("AI checks", () => {
    it("are shown as unavailable without a check engine and cannot be turned on or off", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      const url = `/assets/${wbId}/automated-checks`;
      expect((await call(alice, "GET", url)).json()).toEqual({ available: false });
      expect((await call(alice, "PUT", url, { enabled: true })).statusCode).toBe(404);
    });
  });

  describe("public passport", () => {
    it("is readable without signing in and shows no private data", async () => {
      const alice = await owner();
      const secretSerial = `PRIVATE-${serial()}`;
      const wbId = await published(alice, {
        serialNumber: secretSerial,
        description: "PRIVATE-NOTE kept in a safe",
        publicDescription: "Stainless steel diver's watch",
        attributes: { purchasePrice: "PRIVATE-PRICE" },
      });
      const res = await call(null, "GET", `/passport/${wbId.toLowerCase()}`);
      expect(res.statusCode).toBe(200);
      const { passport, url } = res.json();
      expect(url).toBe(`https://worthybound.test/passport/${wbId}`);
      expect(passport).toMatchObject({
        wbId,
        category: "LUXURY_WATCH",
        brand: "Rolex",
        model: "Submariner",
        description: "Stainless steel diver's watch",
        status: "ACTIVE",
        verificationLevel: "UNVERIFIED",
        trust: {
          score: 7,
          engineVersion: "1.3.0",
          weightsVersion: "weights-2026.4",
          disclaimer: expect.stringContaining("does not guarantee authenticity"),
        },
        custody: { transferCount: 0 },
        attestations: [],
        publicEvidence: [],
      });
      expect(passport.provenance.map((p: { type: string }) => p.type)).toEqual([
        "REGISTERED",
        "STATUS_CHANGED",
      ]);
      expect(res.body).not.toContain("PRIVATE");
      expect(res.body).not.toContain(alice.wallet.address);
      const asset = await assetRow(wbId);
      expect(res.body).not.toContain(asset.id);
      expect(res.body).not.toContain(asset.serialFingerprint as string);
    });

    it("has an intact hash chain", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      await call(alice, "POST", `/assets/${wbId}/condition`, { condition: "GOOD" });
      const { id } = await assetRow(wbId);
      const [row] = await db.prisma.$queryRaw<{ broken: number | null }[]>`
        SELECT wb_verify_provenance_chain(${id}::uuid) AS broken`;
      expect(row?.broken).toBeNull();
    });

    it("answers unknown IDs, drafts and malformed IDs the same way", async () => {
      const alice = await owner();
      const { wbId } = await registered(alice);
      const draft = await call(null, "GET", `/passport/${wbId}`);
      const unknown = await call(null, "GET", "/passport/WB-00000000");
      expect(draft.statusCode).toBe(404);
      expect(draft.body).toBe(unknown.body);
      expect((await call(null, "GET", "/passport/not-an-id")).statusCode).toBe(400);
    });

    it("stays visible for a stolen asset, showing the report", async () => {
      const alice = await owner();
      const wbId = await published(alice);
      await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REPORTED_STOLEN" });
      const passport = (await call(null, "GET", `/passport/${wbId}`)).json().passport;
      expect(passport.status).toBe("REPORTED_STOLEN");
      expect(passport.provenance.at(-1).type).toBe("REPORTED_STOLEN");
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("asset rate limits", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  const generous = { max: 1000, timeWindowMs: 60_000 };

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await testApp(db.prisma, {
      rateLimits: {
        auth: generous,
        register: { max: 2, timeWindowMs: 60_000 },
        write: generous,
        public: { max: 3, timeWindowMs: 60_000 },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("limits registrations per user, not per IP address", async () => {
    const register = (token: string) =>
      app.inject({
        method: "POST",
        url: "/assets",
        payload: { category: "OTHER" },
        cookies: { wb_session: token },
      });
    const alice = await signIn(app, new TestWallet());
    const bob = await signIn(app, new TestWallet());
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await register(alice)).statusCode);
    expect(codes).toEqual([201, 201, 429]);
    expect((await register(bob)).statusCode).toBe(201);
  });

  it("limits public passport lookups per IP address", async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await app.inject({ method: "GET", url: "/passport/WB-00000000" })).statusCode);
    }
    expect(codes).toEqual([404, 404, 404, 429]);
  });
});
