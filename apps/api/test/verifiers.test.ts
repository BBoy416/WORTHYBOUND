import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CheckEngineError } from "@worthybound/automated-checks";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantAdmin } from "../src/cli/admin-grant.js";
import { recordKyc } from "../src/cli/kyc-record.js";
import {
  type Clock,
  createTestDatabase,
  fakeCheckEngine,
  signIn,
  TEST_DATABASE_URL,
  testApp,
  testClock,
  TestWallet,
  type TestDatabase,
} from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)("verifier system", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let clock: Clock;
  let admin: Person;
  const engine = fakeCheckEngine();

  interface Person {
    wallet: TestWallet;
    token: string;
    id: string;
  }

  const person = async (): Promise<Person> => {
    const wallet = new TestWallet();
    const token = await signIn(app, wallet);
    const user = await db.prisma.user.findUniqueOrThrow({
      where: { walletAddress: wallet.address },
    });
    return { wallet, token, id: user.id };
  };

  const call = (
    who: Person | null,
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      cookies: who ? { wb_session: who.token } : {},
    });

  const kyc = (who: Person, status: "VERIFIED" | "EXPIRED" = "VERIFIED") =>
    recordKyc(
      db.prisma,
      { walletAddress: who.wallet.address, provider: "test-kyc", reference: randomUUID(), status },
      clock.now,
    );

  const reviewer = async (): Promise<Person> => {
    const p = await person();
    const res = await call(admin, "POST", "/admin/roles", {
      walletAddress: p.wallet.address,
      role: "VERIFIER_REVIEWER",
    });
    expect(res.statusCode, res.body).toBe(201);
    return p;
  };

  const lab = {
    entityType: "LABORATORY",
    businessName: "Geneva Watch Lab",
    website: "https://lab.example",
  };

  const apply = async (who: Person, body: object = {}) => {
    const res = await call(who, "POST", "/verifier/application", {
      ...lab,
      categories: ["LUXURY_WATCH", "JEWELRY"],
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; status: string }>();
  };

  const setStatus = (who: Person, id: string, status: string, reason?: string) =>
    call(who, "POST", `/review/verifiers/${id}/status`, { status, ...(reason ? { reason } : {}) });

  const setCategory = (
    who: Person,
    id: string,
    category: string,
    status: string,
    reason?: string,
  ) =>
    call(who, "POST", `/review/verifiers/${id}/categories/${category}`, {
      status,
      ...(reason ? { reason } : {}),
    });

  const expectOk = async (promise: ReturnType<typeof call>, status = 200) => {
    const res = await promise;
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  };

  /** An applicant approved for LUXURY_WATCH by `by`. */
  const approvedVerifier = async (by: Person, body: object = {}) => {
    const applicant = await person();
    const { id } = await apply(applicant, body);
    await kyc(applicant);
    await expectOk(setStatus(by, id, "UNDER_REVIEW"));
    await expectOk(setStatus(by, id, "APPROVED"));
    await expectOk(setCategory(by, id, "LUXURY_WATCH", "APPROVED"));
    return { applicant, id };
  };

  const activeRoles = async (userId: string) =>
    (await db.prisma.roleAssignment.findMany({ where: { userId, revokedAt: null } }))
      .map((r) => r.role)
      .sort();

  const audits = (action: string, targetId: string) =>
    db.prisma.auditLog.findMany({ where: { action, targetId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    db = await createTestDatabase();
    clock = testClock();
    app = await testApp(db.prisma, { now: clock.now, checkEngine: engine });
    admin = await person();
    await grantAdmin(db.prisma, admin.wallet.address);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  describe("applications", () => {
    it("records the application with pending categories, history and an audit entry", async () => {
      const alice = await person();
      const res = await call(alice, "POST", "/verifier/application", {
        ...lab,
        bio: "Independent laboratory since 1990",
        categories: ["LUXURY_WATCH", "JEWELRY"],
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        status: "APPLIED",
        entityType: "LABORATORY",
        businessName: "Geneva Watch Lab",
        approvedAt: null,
        identityStatus: "UNVERIFIED",
        identityRequired: true,
        canApplyAgainAt: null,
        history: [{ fromStatus: null, toStatus: "APPLIED", reason: null }],
      });
      expect(
        body.categories.map((c: { category: string; status: string }) => [c.category, c.status]),
      ).toEqual([
        ["LUXURY_WATCH", "PENDING"],
        ["JEWELRY", "PENDING"],
      ]);
      expect(await expectOk(call(alice, "GET", "/verifier/me"))).toEqual(body);
      expect((await audits("verifier.applied", body.id)).map((a) => a.metadata)).toEqual([
        { entityType: "LABORATORY", categories: ["LUXURY_WATCH", "JEWELRY"] },
      ]);
      const events = await db.prisma.verifierCategoryPermissionEvent.findMany({
        where: { permission: { verifierId: body.id } },
      });
      expect(events.map((e) => [e.fromStatus, e.toStatus, e.actorId])).toEqual([
        [null, "PENDING", alice.id],
        [null, "PENDING", alice.id],
      ]);
      expect((await call(null, "GET", `/verifiers/${body.id}`)).statusCode).toBe(404);
    });

    it("accepts one application per user", async () => {
      const bob = await person();
      await apply(bob);
      const res = await call(bob, "POST", "/verifier/application", {
        entityType: "INDIVIDUAL",
        categories: ["FINE_ART"],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("application_exists");
    });

    it("answers 404 without an application and 401 without a session", async () => {
      const carol = await person();
      expect((await call(carol, "GET", "/verifier/me")).statusCode).toBe(404);
      expect((await call(null, "GET", "/verifier/me")).statusCode).toBe(401);
      expect(
        (await call(null, "POST", "/verifier/application", { ...lab, categories: ["OTHER"] }))
          .statusCode,
      ).toBe(401);
    });

    it.each([
      ["status", { status: "APPROVED" }],
      ["user", { userId: randomUUID() }],
      ["approver", { approvedById: randomUUID() }],
      ["credential review", { credentialStatus: "ACCEPTED" }],
    ])("rejects a client-supplied %s", async (_name, field) => {
      const dave = await person();
      const res = await call(dave, "POST", "/verifier/application", {
        ...lab,
        categories: ["OTHER"],
        ...field,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("review", () => {
    it("is limited to verifier reviewers and admins", async () => {
      const user = await person();
      const { id } = await apply(await person());
      for (const [method, url, payload] of [
        ["GET", "/review/verifiers", undefined],
        ["GET", `/review/verifiers/${id}`, undefined],
        ["POST", `/review/verifiers/${id}/status`, { status: "UNDER_REVIEW" }],
        ["POST", `/review/verifiers/${id}/categories/JEWELRY`, { status: "REVOKED", reason: "x" }],
      ] as const) {
        expect((await call(user, method, url, payload)).statusCode).toBe(403);
        expect((await call(null, method, url, payload)).statusCode).toBe(401);
      }
    });

    it("approves only with a verified identity, grants the VERIFIER role and publishes a profile", async () => {
      const rev = await reviewer();
      const applicant = await person();
      const { id } = await apply(applicant);

      await expectOk(setStatus(rev, id, "UNDER_REVIEW"));
      const blocked = await setStatus(rev, id, "APPROVED");
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe("identity_not_verified");
      const early = await setCategory(rev, id, "LUXURY_WATCH", "APPROVED");
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe("verifier_not_approved");

      await kyc(applicant);
      const approved = await expectOk(setStatus(rev, id, "APPROVED"));
      expect(approved).toMatchObject({ status: "APPROVED", approvedById: rev.id });
      expect(await activeRoles(applicant.id)).toEqual(["USER", "VERIFIER"]);
      expect((await audits("role.granted", applicant.id)).map((a) => a.metadata)).toEqual([
        { role: "VERIFIER", via: "verifier_review" },
      ]);

      const decided = await expectOk(setCategory(rev, id, "LUXURY_WATCH", "APPROVED"));
      expect(
        decided.categories.map((c: { category: string; status: string }) => [c.category, c.status]),
      ).toEqual([
        ["LUXURY_WATCH", "APPROVED"],
        ["JEWELRY", "PENDING"],
      ]);
      expect(decided.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
        "APPLIED",
        "UNDER_REVIEW",
        "APPROVED",
      ]);
      expect(decided.history.at(-1).actorId).toBe(rev.id);

      const res = await call(null, "GET", `/verifiers/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id,
        entityType: "LABORATORY",
        publicName: "Geneva Watch Lab",
        website: "https://lab.example",
        status: "APPROVED",
        approvedAt: approved.approvedAt,
        categories: ["LUXURY_WATCH"],
      });
      expect(res.body).not.toContain(applicant.wallet.address);

      expect((await audits("verifier.status_changed", id)).map((a) => a.metadata)).toEqual([
        { fromStatus: "APPLIED", toStatus: "UNDER_REVIEW" },
        { fromStatus: "UNDER_REVIEW", toStatus: "APPROVED" },
      ]);
      expect((await audits("verifier.category_changed", id)).map((a) => a.metadata)).toEqual([
        { category: "LUXURY_WATCH", fromStatus: "PENDING", toStatus: "APPROVED" },
      ]);
    });

    it("does not let reviewers review themselves", async () => {
      const rev = await reviewer();
      const { id } = await apply(rev);
      const res = await setStatus(rev, id, "UNDER_REVIEW");
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("self_review");
      expect((await setCategory(rev, id, "JEWELRY", "REVOKED", "no")).statusCode).toBe(403);
    });

    it("requires a reason to reject and follows the lifecycle", async () => {
      const rev = await reviewer();
      const { id } = await apply(await person());
      expect((await setStatus(rev, id, "REJECTED")).statusCode).toBe(400);
      const skip = await setStatus(rev, id, "APPROVED");
      expect(skip.statusCode).toBe(409);
      expect(skip.json().error.code).toBe("invalid_transition");
    });

    it("revokes the requested categories on rejection and allows applying again after 30 days", async () => {
      const rev = await reviewer();
      const applicant = await person();
      const { id } = await apply(applicant);
      await expectOk(setStatus(rev, id, "REJECTED", "Accreditation could not be verified"));

      const mine = await expectOk(call(applicant, "GET", "/verifier/me"));
      expect(mine.status).toBe("REJECTED");
      expect(mine.history.at(-1)).toMatchObject({
        toStatus: "REJECTED",
        reason: "Accreditation could not be verified",
      });
      expect(mine.history.at(-1)).not.toHaveProperty("actorId");
      expect(
        mine.categories.map((c: { status: string; reason: string }) => [c.status, c.reason]),
      ).toEqual([
        ["REVOKED", "Accreditation could not be verified"],
        ["REVOKED", "Accreditation could not be verified"],
      ]);
      const availableAt = new Date(clock.now().getTime() + 30 * DAY_MS).toISOString();
      expect(mine.canApplyAgainAt).toBe(availableAt);

      const tooSoon = await call(applicant, "POST", "/verifier/application", {
        entityType: "INDIVIDUAL",
        categories: ["LUXURY_WATCH"],
      });
      expect(tooSoon.statusCode).toBe(409);
      expect(tooSoon.json().error).toEqual({
        code: "reapply_too_soon",
        message: `You can apply again after ${availableAt}`,
      });

      clock.advance(30 * DAY_MS);
      // Sessions last 7 days.
      applicant.token = await signIn(app, applicant.wallet);
      admin.token = await signIn(app, admin.wallet);
      const again = await expectOk(
        call(applicant, "POST", "/verifier/application", {
          entityType: "INDIVIDUAL",
          categories: ["LUXURY_WATCH"],
        }),
        201,
      );
      expect(again).toMatchObject({
        id,
        status: "APPLIED",
        entityType: "INDIVIDUAL",
        businessName: null,
        canApplyAgainAt: null,
      });
      expect(
        again.categories.map((c: { category: string; status: string }) => [c.category, c.status]),
      ).toEqual([
        ["LUXURY_WATCH", "REVOKED"],
        ["JEWELRY", "REVOKED"],
        ["LUXURY_WATCH", "PENDING"],
      ]);
      expect(again.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
        "APPLIED",
        "REJECTED",
        "APPLIED",
      ]);
      expect(await audits("verifier.reapplied", id)).toHaveLength(1);
    });

    it("suspends and reinstates; only an admin revokes, which is final", async () => {
      const rev = await reviewer();
      const { applicant, id } = await approvedVerifier(rev);

      await expectOk(setStatus(rev, id, "SUSPENDED", "Complaint under investigation"));
      expect((await call(null, "GET", `/verifiers/${id}`)).json().status).toBe("SUSPENDED");
      await expectOk(setStatus(rev, id, "APPROVED"));
      const approvedAt = (await db.prisma.verifier.findUniqueOrThrow({ where: { id } })).approvedAt;

      const denied = await setStatus(rev, id, "REVOKED", "Fraud");
      expect(denied.statusCode).toBe(409);
      expect(denied.json().error.code).toBe("forbidden_transition");

      const revoked = await expectOk(setStatus(admin, id, "REVOKED", "Issued false reports"));
      expect(revoked.status).toBe("REVOKED");
      expect(revoked.approvedAt).toBe(approvedAt?.toISOString());
      expect(revoked.categories.map((c: { status: string }) => c.status)).toEqual([
        "REVOKED",
        "REVOKED",
      ]);
      expect(await activeRoles(applicant.id)).toEqual(["USER"]);
      expect((await audits("role.revoked", applicant.id)).map((a) => a.metadata)).toEqual([
        { role: "VERIFIER", via: "verifier_review" },
      ]);

      const final = await setStatus(admin, id, "APPROVED");
      expect(final.statusCode).toBe(409);
      expect(final.json().error.code).toBe("invalid_transition");
      expect((await call(null, "GET", `/verifiers/${id}`)).json()).toMatchObject({
        status: "REVOKED",
        categories: [],
      });
    });

    it("lets approved verifiers request more categories, once each", async () => {
      const rev = await reviewer();
      const pending = await person();
      await apply(pending);
      const early = await call(pending, "POST", "/verifier/me/categories", {
        categories: ["FINE_ART"],
      });
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe("verifier_not_approved");

      const { applicant, id } = await approvedVerifier(rev);
      const duplicate = await call(applicant, "POST", "/verifier/me/categories", {
        categories: ["FINE_ART", "JEWELRY"],
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error).toEqual({
        code: "category_already_requested",
        message: "Already requested or approved: JEWELRY",
      });

      await expectOk(
        call(applicant, "POST", "/verifier/me/categories", { categories: ["FINE_ART"] }),
        201,
      );
      expect((await setCategory(rev, id, "FINE_ART", "REVOKED")).statusCode).toBe(400);
      await expectOk(setCategory(rev, id, "FINE_ART", "REVOKED", "No art credentials"));
      const again = await expectOk(
        call(applicant, "POST", "/verifier/me/categories", { categories: ["FINE_ART"] }),
        201,
      );
      expect(
        again.categories
          .filter((c: { category: string }) => c.category === "FINE_ART")
          .map((c: { status: string; reason: string | null }) => [c.status, c.reason]),
      ).toEqual([
        ["REVOKED", "No art credentials"],
        ["PENDING", null],
      ]);
      expect((await setCategory(rev, id, "COLLECTIBLE", "APPROVED")).statusCode).toBe(404);
    });

    it("lists the queue with filters and pagination, without KYC references", async () => {
      const rev = await reviewer();
      const first = await person();
      await kyc(first);
      const ids = [
        (await apply(first)).id,
        (await apply(await person())).id,
        (await apply(await person())).id,
      ];
      const [firstId] = ids as [string];
      await expectOk(setStatus(rev, firstId, "UNDER_REVIEW"));

      const underReview = await expectOk(call(rev, "GET", "/review/verifiers?status=UNDER_REVIEW"));
      const found = underReview.items.find((i: { id: string }) => i.id === firstId);
      expect(found).toMatchObject({
        status: "UNDER_REVIEW",
        walletAddress: first.wallet.address,
        identityStatus: "VERIFIED",
        categories: [
          { category: "LUXURY_WATCH", status: "PENDING" },
          { category: "JEWELRY", status: "PENDING" },
        ],
      });
      expect(underReview.items.every((i: { status: string }) => i.status === "UNDER_REVIEW")).toBe(
        true,
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: { id: string }[]; nextCursor: string | null } = await expectOk(
          call(rev, "GET", `/review/verifiers?limit=2${cursor ? `&cursor=${cursor}` : ""}`),
        );
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([...seen].sort());
      expect(seen).toEqual(expect.arrayContaining(ids));

      const detail = await call(rev, "GET", `/review/verifiers/${firstId}`);
      const user = await db.prisma.user.findUniqueOrThrow({ where: { id: first.id } });
      expect(detail.json()).toMatchObject({
        identityProvider: "test-kyc",
        identityStatus: "VERIFIED",
      });
      expect(detail.body).not.toContain(user.identityProviderRef as string);
      expect((await call(rev, "GET", `/review/verifiers/${randomUUID()}`)).statusCode).toBe(404);
    });
  });

  describe("public profiles", () => {
    it("does not name individuals or show their website and bio", async () => {
      const rev = await reviewer();
      const { id } = await approvedVerifier(rev, {
        entityType: "INDIVIDUAL",
        businessName: "Jane Doe Appraisals",
        website: "https://jane.example",
        bio: "PRIVATE bio",
      });
      const res = await call(null, "GET", `/verifiers/${id}`);
      expect(res.json()).toMatchObject({
        entityType: "INDIVIDUAL",
        publicName: null,
        website: null,
      });
      expect(res.body).not.toContain("Jane");
      expect(res.body).not.toContain("PRIVATE");
    });

    it("answers unknown IDs and applicants the same way", async () => {
      const { id } = await apply(await person());
      const applicant = await call(null, "GET", `/verifiers/${id}`);
      const unknown = await call(null, "GET", `/verifiers/${randomUUID()}`);
      expect(applicant.statusCode).toBe(404);
      expect(applicant.body).toBe(unknown.body);
      expect((await call(null, "GET", "/verifiers/not-an-id")).statusCode).toBe(400);
    });

    it("names only organisations on passports", async () => {
      const rev = await reviewer();
      const org = await approvedVerifier(rev);
      const individual = await approvedVerifier(rev, {
        entityType: "INDIVIDUAL",
        businessName: "Jane Doe Appraisals",
      });
      const owner = await person();
      const created = await expectOk(
        call(owner, "POST", "/assets", {
          category: "LUXURY_WATCH",
          brand: "Rolex",
          model: "Datejust",
        }),
        201,
      );
      await expectOk(call(owner, "POST", `/assets/${created.wbId}/publish`));
      const asset = await db.prisma.asset.findUniqueOrThrow({ where: { wbId: created.wbId } });
      const template = await db.prisma.verificationTemplate.create({
        data: { code: `tpl-${randomUUID()}`, category: "LUXURY_WATCH", name: "Watch" },
      });
      const version = await db.prisma.verificationTemplateVersion.create({
        data: {
          templateId: template.id,
          version: 1,
          status: "PUBLISHED",
          createdById: admin.id,
          publishedById: rev.id,
          publishedAt: clock.now(),
          requiredClaims: ["AUTHENTICATION"],
          requiredEvidence: [],
          allowedMethods: ["IN_PERSON"],
        },
      });
      for (const verifierId of [org.id, individual.id]) {
        const request = await db.prisma.verificationRequest.create({
          data: {
            assetId: asset.id,
            requesterId: owner.id,
            templateVersionId: version.id,
            status: "ASSIGNED",
            assignedVerifierId: verifierId,
            assignedAt: clock.now(),
            expiresAt: new Date(clock.now().getTime() + DAY_MS),
          },
        });
        const signedMessage = `WorthyBound attestation (wb-attestation-v1)\nNonce: ${randomUUID()}`;
        await db.prisma.attestation.create({
          data: {
            assetId: asset.id,
            verifierId,
            verificationRequestId: request.id,
            templateVersionId: version.id,
            claimType: "AUTHENTICATION",
            result: "CONFIRMED",
            method: "IN_PERSON",
            assuranceLevel: "HIGH",
            nonce: randomBytes(16).toString("hex"),
            signedMessage,
            signedPayloadHash: createHash("sha256").update(signedMessage).digest("hex"),
            signature: randomBytes(64).toString("base64url"),
            issuedAt: clock.now(),
            expiresAt: new Date(clock.now().getTime() + 365 * DAY_MS),
          },
        });
        await db.prisma.verificationRequest.update({
          where: { id: request.id },
          data: { status: "COMPLETED", completedAt: clock.now() },
        });
      }
      const res = await call(null, "GET", `/passport/${created.wbId}`);
      const names = Object.fromEntries(
        res
          .json()
          .passport.attestations.map(
            (a: { verifier: { id: string; publicName: string | null } }) => [
              a.verifier.id,
              a.verifier.publicName,
            ],
          ),
      );
      expect(names).toEqual({ [org.id]: "Geneva Watch Lab", [individual.id]: null });
      expect(res.body).not.toContain("Jane");
    });
  });

  describe("AI reports", () => {
    const reports = (who: Person, id: string) =>
      call(who, "GET", `/review/verifiers/${id}/ai-reports`);
    /** Until the queue is empty: earlier tests queued reports too. */
    const run = async () => {
      const checks = app.automatedChecks as NonNullable<FastifyInstance["automatedChecks"]>;
      while ((await checks.runOnce()) > 0);
    };
    const answer = engine.report;

    it("writes an advisory report on each application for reviewers only", async () => {
      const rev = await reviewer();
      const applicant = await person();
      const { id } = await apply(applicant, { bio: "Watchmaker since 2001" });
      expect(await expectOk(reports(rev, id))).toEqual({
        available: true,
        pending: true,
        lastError: null,
        items: [],
      });
      await run();
      expect(engine.reportCalls.filter((c) => c.bio === "Watchmaker since 2001")).toEqual([
        {
          entityType: "LABORATORY",
          businessName: "Geneva Watch Lab",
          website: "https://lab.example",
          bio: "Watchmaker since 2001",
          categories: ["LUXURY_WATCH", "JEWELRY"],
          identityVerified: false,
          previousRejections: 0,
        },
      ]);
      const body = await expectOk(reports(rev, id));
      expect(body).toMatchObject({ pending: false, lastError: null });
      expect(body.items).toEqual([
        expect.objectContaining({
          recommendation: "NEEDS_MORE_INFORMATION",
          concerns: ["No certifications named"],
          sources: ["https://lab.example/about"],
          engine: "fake",
          model: "fake-model-1",
          reportVersion: "verifier-report-v1",
        }),
      ]);
      // Reviewers decide: the report changes nothing about the application.
      const me = await call(applicant, "GET", "/verifier/me");
      expect(me.json().status).toBe("APPLIED");
      expect(me.body).not.toContain("certifications");
      expect((await reports(applicant, id)).statusCode).toBe(403);
      expect((await call(null, "GET", `/review/verifiers/${id}/ai-reports`)).statusCode).toBe(401);
      expect((await reports(rev, randomUUID())).statusCode).toBe(404);
    });

    it("lets reviewers request a new report and shows when one could not be written", async () => {
      const rev = await reviewer();
      const applicant = await person();
      const { id } = await apply(applicant);
      await run();
      engine.report = async () => {
        throw new CheckEngineError("invalid recommendation", false);
      };
      try {
        const requested = await call(rev, "POST", `/review/verifiers/${id}/ai-reports`);
        expect(requested.statusCode, requested.body).toBe(202);
        expect(requested.json()).toMatchObject({ pending: true });
        clock.advance(1000);
        await run();
      } finally {
        engine.report = answer;
      }
      const body = await expectOk(reports(rev, id));
      expect(body.items).toHaveLength(1);
      expect(body.lastError).toMatch(/could not be written/);
      expect((await audits("verifier.ai_report_requested", id)).map((a) => a.actorId)).toEqual([
        rev.id,
      ]);

      const self = await call(applicant, "POST", `/review/verifiers/${id}/ai-reports`);
      expect(self.statusCode).toBe(403);
      const ownReview = await call(rev, "POST", "/verifier/application", {
        ...lab,
        categories: ["OTHER"],
      });
      const own = ownReview.json<{ id: string }>().id;
      expect(
        (await call(rev, "POST", `/review/verifiers/${own}/ai-reports`)).json().error.code,
      ).toBe("self_review");
    });
  });

  describe("admin roles", () => {
    it("grants and revokes VERIFIER_REVIEWER, taking effect at once", async () => {
      const p = await person();
      const granted = await expectOk(
        call(admin, "POST", "/admin/roles", {
          walletAddress: p.wallet.address,
          role: "VERIFIER_REVIEWER",
        }),
        201,
      );
      expect(granted).toMatchObject({
        walletAddress: p.wallet.address,
        role: "VERIFIER_REVIEWER",
        grantedById: admin.id,
        revokedAt: null,
      });
      const list = await expectOk(call(admin, "GET", "/admin/roles?role=VERIFIER_REVIEWER"));
      expect(list.items.map((i: { id: string }) => i.id)).toContain(granted.id);
      expect((await call(p, "GET", "/review/verifiers")).statusCode).toBe(200);

      const duplicate = await call(admin, "POST", "/admin/roles", {
        walletAddress: p.wallet.address,
        role: "VERIFIER_REVIEWER",
      });
      expect(duplicate.json().error.code).toBe("role_already_granted");

      const revoked = await expectOk(call(admin, "DELETE", `/admin/roles/${granted.id}`));
      expect(revoked.revokedAt).not.toBeNull();
      expect((await call(p, "GET", "/review/verifiers")).statusCode).toBe(403);
      const again = await call(admin, "DELETE", `/admin/roles/${granted.id}`);
      expect(again.json().error.code).toBe("role_already_revoked");

      expect((await audits("role.granted", p.id)).map((a) => a.metadata)).toEqual([
        { role: "VERIFIER_REVIEWER", via: "api" },
      ]);
      expect((await audits("role.revoked", p.id)).map((a) => a.metadata)).toEqual([
        { role: "VERIFIER_REVIEWER", via: "api" },
      ]);
    });

    it("rejects self-grants, unknown users and roles not managed through the API", async () => {
      const self = await call(admin, "POST", "/admin/roles", {
        walletAddress: admin.wallet.address,
        role: "VERIFIER_REVIEWER",
      });
      expect(self.json().error.code).toBe("self_grant");
      const unknown = await call(admin, "POST", "/admin/roles", {
        walletAddress: new TestWallet().address,
        role: "VERIFIER_REVIEWER",
      });
      expect(unknown.statusCode).toBe(404);
      const p = await person();
      const adminGrant = await call(admin, "POST", "/admin/roles", {
        walletAddress: p.wallet.address,
        role: "ADMIN",
      });
      expect(adminGrant.statusCode).toBe(400);
      const adminRole = await db.prisma.roleAssignment.findFirstOrThrow({
        where: { userId: admin.id, role: "ADMIN" },
      });
      const res = await call(admin, "DELETE", `/admin/roles/${adminRole.id}`);
      expect(res.json().error.code).toBe("role_not_managed");
      expect(await activeRoles(admin.id)).toEqual(["ADMIN", "USER"]);
    });

    it("is limited to admins", async () => {
      const rev = await reviewer();
      const target = await person();
      const grant = await call(rev, "POST", "/admin/roles", {
        walletAddress: target.wallet.address,
        role: "VERIFIER_REVIEWER",
      });
      expect(grant.statusCode).toBe(403);
      expect((await call(rev, "GET", "/admin/roles?role=VERIFIER_REVIEWER")).statusCode).toBe(403);
      expect((await call(null, "DELETE", `/admin/roles/${randomUUID()}`)).statusCode).toBe(401);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("verifier rate limits", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  const generous = { max: 1000, timeWindowMs: 60_000 };

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await testApp(db.prisma, {
      rateLimits: {
        auth: generous,
        write: generous,
        public: { max: 2, timeWindowMs: 60_000 },
        apply: { max: 2, timeWindowMs: 60_000 },
        checks: { max: 1, timeWindowMs: 60_000 },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("limits applications per user", async () => {
    const applyAs = (token: string) =>
      app.inject({
        method: "POST",
        url: "/verifier/application",
        payload: { entityType: "INDIVIDUAL", categories: ["OTHER"] },
        cookies: { wb_session: token },
      });
    const alice = await signIn(app, new TestWallet());
    const bob = await signIn(app, new TestWallet());
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await applyAs(alice)).statusCode);
    expect(codes).toEqual([201, 409, 429]);
    expect((await applyAs(bob)).statusCode).toBe(201);
  });

  it("answers 503 for AI reports without a check engine, and limits requests per user", async () => {
    const applicant = await signIn(app, new TestWallet());
    const { id } = (
      await app.inject({
        method: "POST",
        url: "/verifier/application",
        payload: { entityType: "INDIVIDUAL", categories: ["OTHER"] },
        cookies: { wb_session: applicant },
      })
    ).json<{ id: string }>();
    const adminWallet = new TestWallet();
    const admin = await signIn(app, adminWallet);
    await grantAdmin(db.prisma, adminWallet.address);
    const request = (method: "GET" | "POST") =>
      app.inject({
        method,
        url: `/review/verifiers/${id}/ai-reports`,
        cookies: { wb_session: admin },
      });
    expect((await request("GET")).json()).toEqual({
      available: false,
      pending: false,
      lastError: null,
      items: [],
    });
    const codes = [];
    for (let i = 0; i < 2; i++) codes.push((await request("POST")).statusCode);
    expect(codes).toEqual([503, 429]);
    expect(await db.prisma.automatedJob.count()).toBe(0);
  });

  it("limits public profile lookups per IP address", async () => {
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push(
        (await app.inject({ method: "GET", url: `/verifiers/${randomUUID()}` })).statusCode,
      );
    }
    expect(codes).toEqual([404, 404, 429]);
  });
});
