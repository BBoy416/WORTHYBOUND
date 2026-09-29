import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Storage } from "@worthybound/storage";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantAdmin } from "../src/cli/admin-grant.js";
import { recordKyc } from "../src/cli/kyc-record.js";
import {
  type Clock,
  createTestDatabase,
  createTestStorage,
  signIn,
  TEST_DATABASE_URL,
  TEST_STORAGE_AVAILABLE,
  testApp,
  testClock,
  TestWallet,
  type TestDatabase,
} from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes: Uint8Array) => {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let text = "";
  for (; value > 0n; value /= 58n) text = BASE58[Number(value % 58n)] + text;
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
};

const pdf = (text: string = randomUUID()) => Buffer.from(`%PDF-1.7\n% ${text}\n%%EOF\n`);

interface Person {
  wallet: TestWallet;
  token: string;
  id: string;
}

type Response = Awaited<ReturnType<FastifyInstance["inject"]>>;
type Call = (
  who: Person | null,
  method: "GET" | "POST",
  url: string,
  payload?: object,
) => Promise<Response>;

/** Shared set-up: people, verifiers, templates, assets and signed attestations. */
function fixtures(get: () => { app: FastifyInstance; db: TestDatabase; clock: Clock }) {
  const person = async (): Promise<Person> => {
    const { app, db } = get();
    const wallet = new TestWallet();
    const token = await signIn(app, wallet);
    const user = await db.prisma.user.findUniqueOrThrow({
      where: { walletAddress: wallet.address },
    });
    return { wallet, token, id: user.id };
  };

  const call: Call = (who, method, url, payload) =>
    get().app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      cookies: who ? { wb_session: who.token } : {},
    });

  const expectOk = async (promise: Promise<Response>, status = 200) => {
    const res = await promise;
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  };

  const errorCode = async (promise: Promise<Response>, status: number) => {
    const res = await promise;
    expect(res.statusCode, res.body).toBe(status);
    return res.json().error.code as string;
  };

  const kyc = (who: Person, status: "VERIFIED" | "EXPIRED" = "VERIFIED") =>
    recordKyc(
      get().db.prisma,
      { walletAddress: who.wallet.address, provider: "test-kyc", reference: randomUUID(), status },
      get().clock.now,
    );

  const newAdmin = async () => {
    const p = await person();
    await grantAdmin(get().db.prisma, p.wallet.address);
    return p;
  };

  /** An approved verifier with a verified identity and the given categories. */
  const verifier = async (
    reviewer: Person,
    categories: string[] = ["LUXURY_WATCH"],
    entityType = "LABORATORY",
  ) => {
    const p = await person();
    const { id } = await expectOk(
      call(p, "POST", "/verifier/application", {
        entityType,
        ...(entityType === "INDIVIDUAL" ? {} : { businessName: "Geneva Watch Lab" }),
        categories,
      }),
      201,
    );
    await kyc(p);
    await expectOk(
      call(reviewer, "POST", `/review/verifiers/${id}/status`, { status: "UNDER_REVIEW" }),
    );
    await expectOk(
      call(reviewer, "POST", `/review/verifiers/${id}/status`, { status: "APPROVED" }),
    );
    for (const category of categories) {
      await expectOk(
        call(reviewer, "POST", `/review/verifiers/${id}/categories/${category}`, {
          status: "APPROVED",
        }),
      );
    }
    return { ...p, verifierId: id as string };
  };

  const requirements = {
    requiredClaims: ["AUTHENTICATION", "CONDITION"],
    requiredEvidence: [{ type: "PHOTO", minCount: 1 }],
    allowedMethods: ["IN_PERSON", "LABORATORY"],
    minVerifiers: 1,
  };

  /** A template created by `creator` and published by `publisher`; returns the version ID. */
  const template = async (
    creator: Person,
    publisher: Person,
    category = "LUXURY_WATCH",
    reqs: object = requirements,
  ) => {
    const t = await expectOk(
      call(creator, "POST", "/admin/templates", {
        code: `watch-${randomBytes(4).toString("hex")}`,
        category,
        name: "Luxury watch standard",
      }),
      201,
    );
    const v = await expectOk(call(creator, "POST", `/admin/templates/${t.id}/versions`, reqs), 201);
    await expectOk(
      call(publisher, "POST", `/admin/template-versions/${v.id}/status`, { status: "PUBLISHED" }),
    );
    return { templateId: t.id as string, versionId: v.id as string };
  };

  /** A published asset of the owner. */
  const asset = async (owner: Person, category = "LUXURY_WATCH") => {
    const { wbId } = await expectOk(
      call(owner, "POST", "/assets", {
        category,
        brand: "Rolex",
        model: "Datejust",
        serialNumber: `SER-${randomBytes(4).toString("hex")}`,
        description: "PRIVATE owner notes",
        condition: "EXCELLENT",
      }),
      201,
    );
    await expectOk(call(owner, "POST", `/assets/${wbId}/publish`));
    return wbId as string;
  };

  const openRequest = async (owner: Person, wbId: string, versionId: string) =>
    expectOk(
      call(owner, "POST", `/assets/${wbId}/verification-requests`, {
        templateVersionId: versionId,
      }),
      201,
    );

  const claim = (v: Person, requestId: string) =>
    call(v, "POST", `/verifier/requests/${requestId}/claim`);

  const draft = (fields: object = {}) => ({
    claimType: "AUTHENTICATION",
    result: "CONFIRMED",
    method: "IN_PERSON",
    assuranceLevel: "HIGH",
    notes: "PRIVATE verifier notes",
    issuedAt: get().clock.now().toISOString(),
    evidence: [],
    nonce: randomBytes(16).toString("hex"),
    ...fields,
  });

  /** Asks for the message, signs it with `signer` (the verifier's wallet by default) and submits. */
  const attest = async (
    v: Person,
    requestId: string,
    fields: object = {},
    options: { signer?: TestWallet; tamper?: (message: string) => string } = {},
  ) => {
    const body = draft(fields);
    const prepared = await call(
      v,
      "POST",
      `/verifier/requests/${requestId}/attestations/message`,
      body,
    );
    if (prepared.statusCode !== 200) return prepared;
    const { message } = prepared.json<{ message: string }>();
    const signed = options.tamper ? options.tamper(message) : message;
    const signature = base58((options.signer ?? v.wallet).sign(signed));
    return call(v, "POST", `/verifier/requests/${requestId}/attestations`, {
      ...body,
      signature,
    });
  };

  return {
    person,
    call,
    expectOk,
    errorCode,
    kyc,
    newAdmin,
    verifier,
    template,
    asset,
    openRequest,
    claim,
    draft,
    attest,
    requirements,
  };
}

describe.skipIf(!TEST_DATABASE_URL)("verification", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let clock: Clock;
  let adminA: Person;
  let adminB: Person;
  const f = fixtures(() => ({ app, db, clock }));
  const { call, expectOk, errorCode } = f;

  beforeAll(async () => {
    db = await createTestDatabase();
    clock = testClock();
    app = await testApp(db.prisma, { now: clock.now });
    adminA = await f.newAdmin();
    adminB = await f.newAdmin();
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const audits = (action: string) =>
    db.prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

  describe("templates", () => {
    it("is published by a second administrator and listed publicly", async () => {
      const t = await expectOk(
        call(adminA, "POST", "/admin/templates", {
          code: `watch-${randomBytes(4).toString("hex")}`,
          category: "LUXURY_WATCH",
          name: "Luxury watch standard",
        }),
        201,
      );
      const v = await expectOk(
        call(adminA, "POST", `/admin/templates/${t.id}/versions`, f.requirements),
        201,
      );
      expect(v).toMatchObject({ version: 1, status: "DRAFT", createdById: adminA.id });

      const publish = (who: Person) =>
        call(who, "POST", `/admin/template-versions/${v.id}/status`, { status: "PUBLISHED" });
      expect(await errorCode(publish(adminA), 403)).toBe("four_eyes");
      expect(await expectOk(publish(adminB))).toMatchObject({
        status: "PUBLISHED",
        publishedById: adminB.id,
      });
      expect(await errorCode(publish(adminB), 409)).toBe("invalid_transition");

      const list = await expectOk(call(null, "GET", "/templates?category=LUXURY_WATCH"));
      expect(list.items).toContainEqual(
        expect.objectContaining({
          templateVersionId: v.id,
          code: t.code,
          requiredClaims: ["AUTHENTICATION", "CONDITION"],
          requiredEvidence: [{ type: "PHOTO", minCount: 1 }],
        }),
      );
      expect((await audits("template.version_published")).map((a) => a.targetId)).toContain(v.id);
    });

    it("retires the previous version and cancels its open requests when a new one is published", async () => {
      const { templateId, versionId } = await f.template(adminA, adminB);
      const owner = await f.person();
      const request = await f.openRequest(owner, await f.asset(owner), versionId);

      const v2 = await expectOk(
        call(adminB, "POST", `/admin/templates/${templateId}/versions`, {
          ...f.requirements,
          minVerifiers: 2,
        }),
        201,
      );
      expect(v2.version).toBe(2);
      await expectOk(
        call(adminA, "POST", `/admin/template-versions/${v2.id}/status`, { status: "PUBLISHED" }),
      );
      const versions = await db.prisma.verificationTemplateVersion.findMany({
        where: { templateId },
        orderBy: { version: "asc" },
      });
      expect(versions.map((v) => v.status)).toEqual(["RETIRED", "PUBLISHED"]);
      expect(
        await db.prisma.verificationRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({ status: "CANCELLED", closedReason: "template_retired" });
    });

    it("is managed by administrators only and validates requirements", async () => {
      const someone = await f.person();
      expect(await errorCode(call(someone, "GET", "/admin/templates"), 403)).toBe("forbidden");
      const body = { code: "watch-basic", category: "LUXURY_WATCH", name: "Basic" };
      expect(await errorCode(call(someone, "POST", "/admin/templates", body), 403)).toBe(
        "forbidden",
      );
      const t = await expectOk(call(adminA, "POST", "/admin/templates", body), 201);
      expect(await errorCode(call(adminA, "POST", "/admin/templates", body), 409)).toBe(
        "template_code_taken",
      );
      expect(
        await errorCode(
          call(adminA, "POST", `/admin/templates/${t.id}/versions`, {
            ...f.requirements,
            requiredClaims: [],
          }),
          400,
        ),
      ).toBe("invalid_request");
    });
  });

  describe("verification requests", () => {
    it("is opened by the owner for a published asset against a template for its category", async () => {
      const { versionId } = await f.template(adminA, adminB);
      const jewellery = await f.template(adminA, adminB, "JEWELRY");
      const owner = await f.person();
      const wbId = await f.asset(owner);

      const request = await f.openRequest(owner, wbId, versionId);
      expect(request).toMatchObject({
        wbId,
        status: "OPEN",
        verifier: null,
        template: { templateVersionId: versionId, requiredClaims: ["AUTHENTICATION", "CONDITION"] },
        history: [{ fromStatus: null, toStatus: "OPEN" }],
      });
      const open = (who: Person, id: string, templateVersionId: string) =>
        call(who, "POST", `/assets/${id}/verification-requests`, { templateVersionId });
      expect(await errorCode(open(owner, wbId, versionId), 409)).toBe("request_exists");
      expect(await errorCode(open(owner, wbId, jewellery.versionId), 422)).toBe(
        "template_unavailable",
      );
      expect(await errorCode(open(owner, wbId, randomUUID()), 422)).toBe("template_unavailable");
      expect(await errorCode(open(await f.person(), wbId, versionId), 404)).toBe("not_found");

      const { wbId: draftId } = await expectOk(
        call(owner, "POST", "/assets", { category: "LUXURY_WATCH" }),
        201,
      );
      expect(await errorCode(open(owner, draftId, versionId), 409)).toBe("asset_not_verifiable");

      const list = await expectOk(call(owner, "GET", `/assets/${wbId}/verification-requests`));
      expect(list.items.map((r: { id: string }) => r.id)).toEqual([request.id]);
    });

    it("shows open requests to eligible verifiers without the owner or private details", async () => {
      const { versionId } = await f.template(adminA, adminB);
      const owner = await f.person();
      const wbId = await f.asset(owner);
      const request = await f.openRequest(owner, wbId, versionId);
      const watchLab = await f.verifier(adminA);
      const jeweller = await f.verifier(adminA, ["JEWELRY"]);

      const queue = await expectOk(call(watchLab, "GET", "/verifier/requests"));
      const item = queue.items.find((r: { id: string }) => r.id === request.id);
      expect(item).toMatchObject({
        assignedToYou: false,
        asset: { wbId, brand: "Rolex", serialNumber: null, attributes: null },
      });
      const body = JSON.stringify(queue);
      expect(body).not.toContain(owner.wallet.address);
      expect(body).not.toContain(owner.id);
      expect(body).not.toContain("PRIVATE");

      const other = await expectOk(call(jeweller, "GET", "/verifier/requests"));
      expect(other.items.map((r: { id: string }) => r.id)).not.toContain(request.id);
      expect(await errorCode(call(jeweller, "GET", `/verifier/requests/${request.id}`), 404)).toBe(
        "not_found",
      );
      expect(await errorCode(call(owner, "GET", "/verifier/requests"), 403)).toBe(
        "verifier_not_approved",
      );
    });

    it("does not offer verifiers their own assets", async () => {
      const { versionId } = await f.template(adminA, adminB);
      const v = await f.verifier(adminA);
      const request = await f.openRequest(v, await f.asset(v), versionId);
      const queue = await expectOk(call(v, "GET", "/verifier/requests"));
      expect(queue.items.map((r: { id: string }) => r.id)).not.toContain(request.id);
      expect(await errorCode(f.claim(v, request.id), 404)).toBe("not_found");
    });

    it("is claimed by one verifier, who then sees the serial, and can be released or cancelled", async () => {
      const { versionId } = await f.template(adminA, adminB);
      const owner = await f.person();
      const wbId = await f.asset(owner);
      const request = await f.openRequest(owner, wbId, versionId);
      const [first, second] = [await f.verifier(adminA), await f.verifier(adminA)];

      const claimed = await expectOk(f.claim(first, request.id));
      expect(claimed).toMatchObject({ status: "ASSIGNED", assignedToYou: true });
      expect(claimed.asset.serialNumber).toMatch(/^SER-/);
      expect(await errorCode(f.claim(second, request.id), 409)).toBe("request_not_open");
      expect(await errorCode(call(second, "GET", `/verifier/requests/${request.id}`), 404)).toBe(
        "not_found",
      );

      const mine = await expectOk(call(first, "GET", "/verifier/requests?scope=mine"));
      expect(mine.items.map((r: { id: string }) => r.id)).toEqual([request.id]);

      const ownerView = await expectOk(call(owner, "GET", `/assets/${wbId}/verification-requests`));
      expect(ownerView.items[0].verifier).toMatchObject({
        id: first.verifierId,
        publicName: "Geneva Watch Lab",
      });
      expect(JSON.stringify(ownerView)).not.toContain(first.wallet.address);

      expect(
        await errorCode(call(second, "POST", `/verifier/requests/${request.id}/release`), 404),
      ).toBe("not_found");
      expect(
        await expectOk(call(first, "POST", `/verifier/requests/${request.id}/release`)),
      ).toMatchObject({ status: "OPEN", assignedToYou: false });
      await expectOk(f.claim(second, request.id));

      expect(
        await errorCode(call(first, "POST", `/verification-requests/${request.id}/cancel`), 404),
      ).toBe("not_found");
      const cancelled = await expectOk(
        call(owner, "POST", `/verification-requests/${request.id}/cancel`),
      );
      expect(cancelled).toMatchObject({ status: "CANCELLED", closedReason: "cancelled_by_owner" });
      expect(cancelled.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
        "OPEN",
        "ASSIGNED",
        "OPEN",
        "ASSIGNED",
        "CANCELLED",
      ]);
      expect(
        await errorCode(call(owner, "POST", `/verification-requests/${request.id}/cancel`), 409),
      ).toBe("invalid_transition");
    });

    it("is released when the verifier is suspended or their identity expires", async () => {
      const { versionId } = await f.template(adminA, adminB);
      const owner = await f.person();
      const [suspended, expired] = [await f.verifier(adminA), await f.verifier(adminA)];
      const r1 = await f.openRequest(owner, await f.asset(owner), versionId);
      const r2 = await f.openRequest(owner, await f.asset(owner), versionId);
      await expectOk(f.claim(suspended, r1.id));
      await expectOk(f.claim(expired, r2.id));

      await expectOk(
        call(adminA, "POST", `/review/verifiers/${suspended.verifierId}/status`, {
          status: "SUSPENDED",
          reason: "Complaint under investigation",
        }),
      );
      await f.kyc(expired, "EXPIRED");

      const events = await db.prisma.verificationRequestStatusEvent.findMany({
        where: { requestId: { in: [r1.id, r2.id] }, toStatus: "OPEN", fromStatus: "ASSIGNED" },
      });
      expect(Object.fromEntries(events.map((e) => [e.requestId, e.reason]))).toEqual({
        [r1.id]: "verifier_suspended",
        [r2.id]: "verifier_identity_not_verified",
      });
      const requests = await db.prisma.verificationRequest.findMany({
        where: { id: { in: [r1.id, r2.id] } },
      });
      expect(requests.map((r) => [r.status, r.assignedVerifierId])).toEqual([
        ["OPEN", null],
        ["OPEN", null],
      ]);
      expect(await errorCode(f.claim(suspended, r1.id), 403)).toBe("verifier_not_approved");
      expect(await errorCode(f.claim(expired, r1.id), 403)).toBe("identity_not_verified");
    });

    it("is cancelled when the owner reports the asset stolen", async () => {
      const { versionId } = await f.template(adminA, adminB);
      const owner = await f.person();
      const wbId = await f.asset(owner);
      const request = await f.openRequest(owner, wbId, versionId);
      await expectOk(
        call(owner, "POST", `/assets/${wbId}/status`, { toStatus: "REPORTED_STOLEN" }),
      );
      expect(
        await db.prisma.verificationRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({ status: "CANCELLED", closedReason: "asset_unavailable" });
    });

    it("expires after 90 days", async () => {
      const { versionId } = await f.template(adminA, adminB);
      const owner = await f.person();
      const wbId = await f.asset(owner);
      const request = await f.openRequest(owner, wbId, versionId);
      const v = await f.verifier(adminA);
      clock.advance(91 * DAY_MS);
      try {
        const [freshVerifier, freshOwner] = [
          { ...v, token: await signIn(app, v.wallet) },
          { ...owner, token: await signIn(app, owner.wallet) },
        ];
        expect(await errorCode(f.claim(freshVerifier, request.id), 409)).toBe("request_expired");
        const list = await expectOk(
          call(freshOwner, "GET", `/assets/${wbId}/verification-requests`),
        );
        expect(list.items[0]).toMatchObject({ status: "EXPIRED", closedReason: "request_expired" });
        await f.openRequest(freshOwner, wbId, versionId);
      } finally {
        clock.advance(-91 * DAY_MS);
      }
    });
  });

  describe("signed attestations", () => {
    const assigned = async () => {
      const { versionId } = await f.template(adminA, adminB);
      const owner = await f.person();
      const wbId = await f.asset(owner);
      const request = await f.openRequest(owner, wbId, versionId);
      const v = await f.verifier(adminA);
      await expectOk(f.claim(v, request.id));
      return { owner, wbId, request, v, versionId };
    };

    it("builds the message from the claim and the server's records", async () => {
      const { v, wbId, request, versionId } = await assigned();
      const body = f.draft({ claimType: "CONDITION", conditionGrade: "VERY_GOOD" });
      const { message, verifierAddress } = await expectOk(
        call(v, "POST", `/verifier/requests/${request.id}/attestations/message`, body),
      );
      expect(verifierAddress).toBe(v.wallet.address);
      expect(message.split("\n")).toEqual(
        expect.arrayContaining([
          "WorthyBound attestation (wb-attestation-v1)",
          "Domain: worthybound.test",
          "Chain ID: solana:devnet",
          `Verifier: ${v.wallet.address}`,
          `Asset: ${wbId}`,
          "Category: LUXURY_WATCH",
          `Template version: ${versionId}`,
          `Verification request: ${request.id}`,
          "Claim: CONDITION",
          "Condition grade: VERY_GOOD",
          `Notes SHA-256: ${sha256("PRIVATE verifier notes")}`,
          `Nonce: ${body.nonce}`,
        ]),
      );
      expect(
        await db.prisma.attestation.count({ where: { verificationRequestId: request.id } }),
      ).toBe(0);
    });

    it("records an attestation signed by the verifier's wallet and shows it on the passport", async () => {
      const { owner, v, wbId, request } = await assigned();
      const res = await f.attest(v, request.id, {
        claimType: "CONDITION",
        conditionGrade: "VERY_GOOD",
        method: "LABORATORY",
      });
      expect(res.statusCode, res.body).toBe(201);
      const created = res.json();
      expect(created).toMatchObject({
        wbId,
        verificationRequestId: request.id,
        claimType: "CONDITION",
        conditionGrade: "VERY_GOOD",
        status: "ACTIVE",
        notes: "PRIVATE verifier notes",
        signedPayloadHash: sha256(created.signedMessage),
      });

      const stored = await db.prisma.attestation.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored.signedMessage).toBe(created.signedMessage);
      const asset = await db.prisma.asset.findUniqueOrThrow({ where: { wbId } });
      const provenance = await db.prisma.provenanceEvent.findFirstOrThrow({
        where: { assetId: asset.id, type: "ATTESTATION_ADDED" },
      });
      expect(provenance.payload).toMatchObject({ attestationId: created.id });
      expect(
        await db.prisma.attestationStatusEvent.count({ where: { attestationId: created.id } }),
      ).toBe(1);

      const passport = await call(null, "GET", `/passport/${wbId}`);
      expect(passport.json().passport.condition.verified).toMatchObject({ grade: "VERY_GOOD" });
      expect(passport.body).not.toContain("PRIVATE");
      expect(passport.body).not.toContain(v.wallet.address);

      const ownerView = await expectOk(call(owner, "GET", `/assets/${wbId}/verification-requests`));
      expect(ownerView.items[0].attestations).toEqual([
        expect.objectContaining({ id: created.id, conditionGrade: "VERY_GOOD" }),
      ]);
      expect(JSON.stringify(ownerView)).not.toContain("PRIVATE");
      expect(JSON.stringify(ownerView)).not.toContain("signedMessage");

      const done = await expectOk(call(v, "POST", `/verifier/requests/${request.id}/complete`));
      expect(done).toMatchObject({ status: "COMPLETED" });
      expect(await errorCode(f.attest(v, request.id, {}), 404)).toBe("not_found");
    });

    it.each([
      ["a signature over a different message", { tamper: (m: string) => `${m} ` }],
      ["a signature by another wallet", { signer: new TestWallet() }],
    ])("rejects %s", async (_label, options) => {
      const { v, request } = await assigned();
      expect(await errorCode(f.attest(v, request.id, {}, options), 422)).toBe("invalid_signature");
      expect(
        await db.prisma.attestation.count({ where: { verificationRequestId: request.id } }),
      ).toBe(0);
    });

    it("rejects a malformed signature, a reused nonce and a stale issue date", async () => {
      const { v, request } = await assigned();
      const body = f.draft();
      const submit = (fields: object) =>
        call(v, "POST", `/verifier/requests/${request.id}/attestations`, { ...body, ...fields });
      expect(await errorCode(submit({ signature: "1".repeat(88) }), 422)).toBe("invalid_signature");

      const first = await f.attest(v, request.id, { nonce: body.nonce });
      expect(first.statusCode, first.body).toBe(201);
      expect(
        await errorCode(
          f.attest(v, request.id, {
            claimType: "CONDITION",
            conditionGrade: "GOOD",
            nonce: body.nonce,
          }),
          409,
        ),
      ).toBe("nonce_reused");

      const stale = new Date(clock.now().getTime() - 60 * 60_000).toISOString();
      expect(
        await errorCode(
          call(v, "POST", `/verifier/requests/${request.id}/attestations/message`, {
            ...f.draft({ issuedAt: stale }),
          }),
          422,
        ),
      ).toBe("issued_at_out_of_range");
    });

    it("refuses claims and methods outside the template", async () => {
      const { v, request } = await assigned();
      const message = (fields: object) =>
        call(v, "POST", `/verifier/requests/${request.id}/attestations/message`, f.draft(fields));
      const res = await message({ claimType: "APPRAISAL" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({ code: "attestation_not_allowed" });
      expect(res.json().error.message).toContain("CLAIM_NOT_IN_TEMPLATE");
      expect((await message({ method: "REMOTE" })).json().error.message).toContain(
        "METHOD_NOT_ALLOWED",
      );
    });

    it("supersedes the verifier's previous attestation of the same claim only when asked", async () => {
      const { v, request } = await assigned();
      const first = (await f.attest(v, request.id)).json();
      expect(await errorCode(f.attest(v, request.id), 409)).toBe("attestation_exists");
      const second = await f.attest(v, request.id, { supersedesId: first.id });
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json().supersedesId).toBe(first.id);
      expect(
        (await db.prisma.attestation.findUniqueOrThrow({ where: { id: first.id } })).status,
      ).toBe("SUPERSEDED");
      expect(await errorCode(f.attest(v, request.id, { supersedesId: first.id }), 409)).toBe(
        "attestation_exists",
      );
    });

    it("is revoked by its issuer with a reason, once", async () => {
      const { v, wbId, owner, request } = await assigned();
      const created = (await f.attest(v, request.id)).json();
      const revoke = (who: Person) =>
        call(who, "POST", `/attestations/${created.id}/revoke`, { reason: "Wrong asset" });
      expect(await errorCode(revoke(owner), 404)).toBe("not_found");
      expect(await errorCode(revoke(await f.verifier(adminA)), 404)).toBe("not_found");
      expect(await expectOk(revoke(v))).toMatchObject({ status: "REVOKED" });
      expect(await errorCode(revoke(v), 409)).toBe("invalid_transition");

      const asset = await db.prisma.asset.findUniqueOrThrow({ where: { wbId } });
      expect(
        await db.prisma.provenanceEvent.count({
          where: { assetId: asset.id, type: "ATTESTATION_REVOKED" },
        }),
      ).toBe(1);
      const passport = (await call(null, "GET", `/passport/${wbId}`)).json().passport;
      expect(passport.attestations).toEqual([expect.objectContaining({ status: "REVOKED" })]);
    });

    it("stops accepting attestations once the verifier's category is suspended", async () => {
      const { v, request } = await assigned();
      await expectOk(
        call(adminA, "POST", `/review/verifiers/${v.verifierId}/categories/LUXURY_WATCH`, {
          status: "SUSPENDED",
          reason: "Recertification pending",
        }),
      );
      expect(await errorCode(f.attest(v, request.id), 404)).toBe("not_found");
      expect(
        await db.prisma.verificationRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({ status: "OPEN" });
    });

    it("needs an attestation before the request is completed", async () => {
      const { v, request } = await assigned();
      expect(
        await errorCode(call(v, "POST", `/verifier/requests/${request.id}/complete`), 409),
      ).toBe("no_attestations");
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL || !TEST_STORAGE_AVAILABLE)("verifier evidence", () => {
  let db: TestDatabase;
  let storage: Storage;
  let app: FastifyInstance;
  let clock: Clock;
  let adminA: Person;
  let adminB: Person;
  const f = fixtures(() => ({ app, db, clock }));
  const { call, expectOk, errorCode } = f;

  beforeAll(async () => {
    db = await createTestDatabase();
    storage = await createTestStorage();
    clock = testClock();
    app = await testApp(db.prisma, { storage, now: clock.now });
    adminA = await f.newAdmin();
    adminB = await f.newAdmin();
  });

  afterAll(async () => {
    await app?.close();
    await storage?.deleteBucket();
    await db?.drop();
  });

  const meta = (body: Buffer, type = "INSPECTION_REPORT", mimeType = "application/pdf") => ({
    type,
    mimeType,
    sizeBytes: body.length,
    sha256: sha256(body),
  });

  const sendFile = async (form: { url: string; fields: Record<string, string> }, body: Buffer) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(form.fields)) data.append(k, v);
    data.append("file", new Blob([new Uint8Array(body)], { type: "application/pdf" }));
    const res = await fetch(form.url, { method: "POST", body: data });
    expect(res.status, await res.text()).toBeLessThan(300);
  };

  const uploadAs = async (who: Person, url: string, body: Buffer) => {
    const { uploadId, form } = await expectOk(call(who, "POST", url, meta(body)), 201);
    await sendFile(form, body);
    return {
      uploadId: uploadId as string,
      complete: () => call(who, "POST", `/evidence/uploads/${uploadId}/complete`),
    };
  };

  const assigned = async () => {
    const { versionId } = await f.template(adminA, adminB);
    const owner = await f.person();
    const wbId = await f.asset(owner);
    const request = await f.openRequest(owner, wbId, versionId);
    const v = await f.verifier(adminA);
    await expectOk(f.claim(v, request.id));
    return { owner, wbId, requestId: request.id as string, v };
  };

  it("lets the assigned verifier add private evidence, which the owner sees", async () => {
    const { owner, wbId, requestId, v } = await assigned();
    const body = pdf();
    const upload = await uploadAs(v, `/verifier/requests/${requestId}/evidence/uploads`, body);
    const evidence = await expectOk(upload.complete(), 201);
    expect(evidence).toMatchObject({
      source: "VERIFIER",
      type: "INSPECTION_REPORT",
      visibility: "PRIVATE",
      sha256: sha256(body),
    });
    const stored = await db.prisma.evidence.findUniqueOrThrow({ where: { id: evidence.id } });
    expect(stored).toMatchObject({ verificationRequestId: requestId, uploaderId: v.id });

    const ownerList = await expectOk(call(owner, "GET", `/assets/${wbId}/evidence`));
    expect(ownerList.items).toContainEqual(
      expect.objectContaining({ id: evidence.id, source: "VERIFIER" }),
    );
    const passport = await call(null, "GET", `/passport/${wbId}`);
    expect(passport.json().passport.evidenceCommitments.at(-1).evidenceCount).toBe(1);
  });

  it("refuses uploads from anyone but the assigned verifier and owner-history document types", async () => {
    const { owner, requestId, v } = await assigned();
    const other = await f.verifier(adminA);
    const url = `/verifier/requests/${requestId}/evidence/uploads`;
    expect(await errorCode(call(other, "POST", url, meta(pdf())), 404)).toBe("not_found");
    expect(await errorCode(call(owner, "POST", url, meta(pdf())), 404)).toBe("not_found");
    expect(await errorCode(call(v, "POST", url, meta(pdf(), "RECEIPT")), 400)).toBe(
      "invalid_request",
    );
    expect(
      await errorCode(call(v, "POST", url, { ...meta(pdf()), visibility: "PUBLIC" }), 400),
    ).toBe("invalid_request");
  });

  it("refuses to complete an upload once the request is no longer assigned to the verifier", async () => {
    const { requestId, v } = await assigned();
    const upload = await uploadAs(v, `/verifier/requests/${requestId}/evidence/uploads`, pdf());
    await expectOk(call(v, "POST", `/verifier/requests/${requestId}/release`));
    expect(await errorCode(upload.complete(), 422)).toBe("request_unavailable");
    expect(
      await db.prisma.evidenceUpload.findUniqueOrThrow({ where: { id: upload.uploadId } }),
    ).toMatchObject({ status: "FAILED", failureReason: "request_unavailable" });
  });

  it("lets the assigned verifier download and review the owner's evidence, once", async () => {
    const { owner, wbId, requestId, v } = await assigned();
    const ownerFile = pdf();
    const ownerUpload = await uploadAs(owner, `/assets/${wbId}/evidence/uploads`, ownerFile);
    const evidence = await expectOk(ownerUpload.complete(), 201);

    const list = await expectOk(call(v, "GET", `/verifier/requests/${requestId}/evidence`));
    expect(list.items.map((e: { id: string }) => e.id)).toEqual([evidence.id]);
    const link = await expectOk(
      call(v, "POST", `/verifier/requests/${requestId}/evidence/${evidence.id}/download`),
    );
    const file = await fetch(link.url);
    expect(Buffer.from(await file.arrayBuffer()).equals(ownerFile)).toBe(true);

    const other = await f.verifier(adminA);
    expect(
      await errorCode(call(other, "GET", `/verifier/requests/${requestId}/evidence`), 404),
    ).toBe("not_found");
    expect(
      await errorCode(
        call(other, "POST", `/verifier/requests/${requestId}/evidence/${evidence.id}/download`),
        404,
      ),
    ).toBe("not_found");

    const review = (who: Person, payload: object) =>
      call(who, "POST", `/verifier/requests/${requestId}/evidence/${evidence.id}/review`, payload);
    expect(await errorCode(review(v, { status: "REJECTED" }), 400)).toBe("invalid_request");
    expect(await errorCode(review(other, { status: "ACCEPTED" }), 404)).toBe("not_found");
    expect(await errorCode(review(owner, { status: "ACCEPTED" }), 404)).toBe("not_found");
    const rejected = await expectOk(
      review(v, { status: "REJECTED", reason: "Document is illegible" }),
    );
    expect(rejected).toMatchObject({
      reviewStatus: "REJECTED",
      reviewReason: "Document is illegible",
    });
    expect(await errorCode(review(v, { status: "ACCEPTED" }), 409)).toBe("invalid_transition");

    const ownerList = await expectOk(call(owner, "GET", `/assets/${wbId}/evidence`));
    expect(ownerList.items[0]).toMatchObject({
      reviewStatus: "REJECTED",
      reviewReason: "Document is illegible",
    });
    expect(JSON.stringify(ownerList)).not.toContain(v.id);
    const asset = await db.prisma.asset.findUniqueOrThrow({ where: { wbId } });
    expect(
      await db.prisma.provenanceEvent.count({
        where: { assetId: asset.id, type: "EVIDENCE_REVIEWED" },
      }),
    ).toBe(1);

    expect(
      await errorCode(
        f.attest(v, requestId, {
          evidence: [{ evidenceId: evidence.id, sha256: evidence.sha256 }],
        }),
        422,
      ),
    ).toBe("evidence_rejected");
  });

  it("does not let verifiers review their own uploads", async () => {
    const { requestId, v } = await assigned();
    const upload = await uploadAs(v, `/verifier/requests/${requestId}/evidence/uploads`, pdf());
    const evidence = await expectOk(upload.complete(), 201);
    expect(
      await errorCode(
        call(v, "POST", `/verifier/requests/${requestId}/evidence/${evidence.id}/review`, {
          status: "ACCEPTED",
        }),
        403,
      ),
    ).toBe("self_review");
  });

  it("links the evidence an attestation relies on, with each file's hash", async () => {
    const { requestId, v } = await assigned();
    const upload = await uploadAs(v, `/verifier/requests/${requestId}/evidence/uploads`, pdf());
    const evidence = await expectOk(upload.complete(), 201);
    expect(
      await errorCode(
        f.attest(v, requestId, { evidence: [{ evidenceId: evidence.id, sha256: "0".repeat(64) }] }),
        422,
      ),
    ).toBe("evidence_mismatch");
    const res = await f.attest(v, requestId, {
      evidence: [{ evidenceId: evidence.id, sha256: evidence.sha256 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().evidence).toEqual([{ evidenceId: evidence.id, sha256: evidence.sha256 }]);
    expect(res.json().signedMessage).toContain(`Evidence: ${evidence.id} ${evidence.sha256}`);
  });
});
