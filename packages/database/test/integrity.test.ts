import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AssetCategory,
  DatabaseErrorCode,
  isDatabaseError,
  type Prisma,
  type TemplateVersionStatus,
  type VerifierStatus,
} from "../src/index.js";
import {
  createTestDatabase,
  randomHex64,
  TEST_DATABASE_URL,
  type TestDatabase,
  wallet,
  wbId,
} from "./helpers.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

describe.skipIf(!TEST_DATABASE_URL)("database integrity", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  // ─── Fixtures ───────────────────────────────────────────────────────────────

  const user = () => db.prisma.user.create({ data: { walletAddress: wallet() } });

  /** A user whose identity was verified by a KYC provider (ADR 0004). */
  const kycUser = () =>
    db.prisma.user.create({
      data: {
        walletAddress: wallet(),
        identityStatus: "VERIFIED",
        identityProvider: "test-kyc",
        identityProviderRef: randomUUID(),
        identityVerifiedAt: new Date(),
      },
    });

  const asset = async (category: AssetCategory = "LUXURY_WATCH", ownerId?: string) =>
    db.prisma.asset.create({
      data: { wbId: wbId(), category, ownerId: ownerId ?? (await user()).id },
    });

  /** A published asset, which accepts attestations. */
  const activeAsset = async (category: AssetCategory = "LUXURY_WATCH", ownerId?: string) =>
    db.prisma.asset.create({
      data: {
        wbId: wbId(),
        category,
        ownerId: ownerId ?? (await user()).id,
        status: "ACTIVE",
        publishedAt: new Date(),
      },
    });

  const admin = async () => {
    const [account, granter] = [await user(), await user()];
    await db.prisma.roleAssignment.create({
      data: { userId: account.id, role: "ADMIN", grantedById: granter.id },
    });
    return account;
  };

  const verifier = async (
    options: { status?: VerifierStatus; categories?: AssetCategory[] } = {},
  ) => {
    const admin = await user();
    const account = await kycUser();
    const status = options.status ?? "APPROVED";
    // Categories are approved while the verifier is approved; the status is set afterwards.
    let record = await db.prisma.verifier.create({
      data: {
        userId: account.id,
        entityType: "BUSINESS",
        status: "APPROVED",
        approvedById: admin.id,
        approvedAt: new Date(),
      },
    });
    for (const category of options.categories ?? ["LUXURY_WATCH"]) {
      await db.prisma.verifierCategoryPermission.create({
        data: {
          verifierId: record.id,
          category,
          status: "APPROVED",
          approvedById: admin.id,
          approvedAt: new Date(),
        },
      });
    }
    if (status !== "APPROVED") {
      record = await db.prisma.verifier.update({ where: { id: record.id }, data: { status } });
    }
    return { ...record, admin };
  };

  const requirements = {
    requiredClaims: ["AUTHENTICATION", "CONDITION"],
    requiredEvidence: [{ type: "PHOTO", minCount: 1 }],
    allowedMethods: ["IN_PERSON"],
  };

  /** Published versions are created by one user and published by another. */
  const templateVersion = async (
    category: AssetCategory = "LUXURY_WATCH",
    status: TemplateVersionStatus = "PUBLISHED",
  ) => {
    const template = await db.prisma.verificationTemplate.create({
      data: { code: `tpl-${randomUUID()}`, category, name: "Test template" },
    });
    const [creator, publisher] = [await user(), await user()];
    return db.prisma.verificationTemplateVersion.create({
      data: {
        templateId: template.id,
        version: 1,
        status,
        ...requirements,
        createdById: creator.id,
        ...(status === "DRAFT" ? {} : { publishedAt: new Date(), publishedById: publisher.id }),
      },
    });
  };

  /** A verification request for the asset, assigned to the verifier. */
  const assign = async (
    a: { id: string; ownerId: string },
    verifierId: string,
    templateVersionId: string,
  ) =>
    db.prisma.verificationRequest.create({
      data: {
        assetId: a.id,
        requesterId: a.ownerId,
        templateVersionId,
        status: "ASSIGNED",
        assignedVerifierId: verifierId,
        assignedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

  const signed = () => {
    const signedMessage = `WorthyBound attestation (wb-attestation-v1)\nNonce: ${randomUUID()}`;
    return {
      signedMessage,
      signedPayloadHash: createHash("sha256").update(signedMessage, "utf8").digest("hex"),
    };
  };

  const attestationData = (request: {
    id: string;
    assetId: string;
    assignedVerifierId: string | null;
    templateVersionId: string;
  }) => ({
    assetId: request.assetId,
    verifierId: request.assignedVerifierId as string,
    verificationRequestId: request.id,
    templateVersionId: request.templateVersionId,
    claimType: "AUTHENTICATION" as const,
    result: "CONFIRMED" as const,
    method: "IN_PERSON" as const,
    assuranceLevel: "HIGH" as const,
    nonce: randomUUID(),
    ...signed(),
    signature: randomBytes(64).toString("base64url"),
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
  });

  /** An asset, an approved verifier, a published template and a request assigned to the verifier. */
  const assigned = async (
    options: { category?: AssetCategory; verifierCategories?: AssetCategory[] } = {},
  ) => {
    const category = options.category ?? "LUXURY_WATCH";
    const a = await activeAsset(category);
    const v = await verifier({ categories: options.verifierCategories ?? [category] });
    const tv = await templateVersion(category);
    const request = await assign(a, v.id, tv.id);
    return { a, v, tv, request };
  };

  const attestation = async () => {
    const { request } = await assigned();
    return db.prisma.attestation.create({ data: attestationData(request) });
  };

  const expectDbError = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, `expected database error ${code}`).toBeDefined();
    expect(isDatabaseError(error, code), String(error)).toBe(true);
  };

  // ─── Migrations ─────────────────────────────────────────────────────────────

  describe("migrations", () => {
    it("leave no drift between the Prisma schema and the migrated database", () => {
      const run = () =>
        execFileSync(
          "pnpm",
          [
            "exec",
            "prisma",
            "migrate",
            "diff",
            "--from-config-datasource",
            "--to-schema",
            "prisma/schema.prisma",
            "--exit-code",
          ],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { ...process.env, DATABASE_URL: db.url },
            stdio: "pipe",
          },
        );
      expect(run).not.toThrow();
    });
  });

  // ─── Append-only history ────────────────────────────────────────────────────

  describe("append-only tables", () => {
    const tables = [
      "asset_status_events",
      "verifier_status_events",
      "verifier_category_permission_events",
      "verification_request_status_events",
      "attestation_status_events",
      "attestation_evidence",
      "evidence_commitments",
      "evidence_commitment_items",
      "trust_score_snapshots",
      "provenance_events",
      "audit_logs",
    ];

    beforeAll(async () => {
      const att = await attestation();
      const v = await db.prisma.verifier.findUniqueOrThrow({ where: { id: att.verifierId } });
      const owner = await user();
      const evidence = await db.prisma.evidence.create({
        data: {
          assetId: att.assetId,
          uploaderId: owner.id,
          type: "PHOTO",
          storageKey: `evidence/${randomUUID()}`,
          sha256: randomHex64(),
          mimeType: "image/jpeg",
          sizeBytes: 1024,
        },
      });
      const commitment = await db.prisma.evidenceCommitment.create({
        data: { assetId: att.assetId, merkleRoot: randomHex64(), evidenceCount: 1 },
      });
      await db.prisma.evidenceCommitmentItem.create({
        data: {
          commitmentId: commitment.id,
          leafIndex: 0,
          evidenceId: evidence.id,
          sha256: evidence.sha256,
        },
      });
      await db.prisma.attestationEvidence.create({
        data: { attestationId: att.id, evidenceId: evidence.id, sha256: evidence.sha256 },
      });
      await db.prisma.assetStatusEvent.create({
        data: { assetId: att.assetId, fromStatus: "DRAFT", toStatus: "ACTIVE" },
      });
      await db.prisma.verifierStatusEvent.create({
        data: { verifierId: v.id, fromStatus: "UNDER_REVIEW", toStatus: "APPROVED" },
      });
      const permission = await db.prisma.verifierCategoryPermission.findFirstOrThrow({
        where: { verifierId: v.id },
      });
      await db.prisma.verifierCategoryPermissionEvent.create({
        data: { permissionId: permission.id, fromStatus: "PENDING", toStatus: "APPROVED" },
      });
      await db.prisma.attestationStatusEvent.create({
        data: { attestationId: att.id, toStatus: "ACTIVE" },
      });
      await db.prisma.verificationRequestStatusEvent.create({
        data: { requestId: att.verificationRequestId, toStatus: "ASSIGNED", verifierId: v.id },
      });
      await db.prisma.trustScoreSnapshot.create({
        data: {
          assetId: att.assetId,
          score: 42,
          verificationLevel: "AUTHENTICATED",
          factors: [],
          deductions: [],
          capsApplied: [],
          excludedProofs: [],
          engineVersion: "1.0.0",
          weightsVersion: "weights-2026.1",
          inputsHash: randomHex64(),
          computedAt: new Date(),
        },
      });
      await db.prisma.provenanceEvent.create({
        data: { assetId: att.assetId, type: "REGISTERED" },
      });
      await db.prisma.auditLog.create({ data: { action: "test", targetType: "asset" } });
    });

    it.each(tables)("%s rejects UPDATE", async (table) => {
      const { rows } = await db.sql.query<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`);
      expect(Number(rows[0]?.n)).toBeGreaterThan(0);
      const column = (
        await db.sql.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 ORDER BY ordinal_position LIMIT 1`,
          [table],
        )
      ).rows[0]?.column_name;
      await expectDbError(
        db.sql.query(`UPDATE "${table}" SET "${column}" = "${column}"`),
        DatabaseErrorCode.APPEND_ONLY,
      );
    });

    it.each(tables)("%s rejects DELETE", async (table) => {
      await expectDbError(db.sql.query(`DELETE FROM "${table}"`), DatabaseErrorCode.APPEND_ONLY);
    });

    it.each(tables)("%s rejects TRUNCATE", async (table) => {
      await expectDbError(
        db.sql.query(`TRUNCATE "${table}" CASCADE`),
        DatabaseErrorCode.APPEND_ONLY,
      );
    });

    it("rejects updates made through Prisma", async () => {
      const log = await db.prisma.auditLog.create({ data: { action: "x", targetType: "asset" } });
      await expectDbError(
        db.prisma.auditLog.update({ where: { id: log.id }, data: { action: "tampered" } }),
        DatabaseErrorCode.APPEND_ONLY,
      );
    });
  });

  // ─── Provenance hash chain ──────────────────────────────────────────────────

  describe("provenance hash chain", () => {
    it("assigns sequence and links each event to the previous hash", async () => {
      const a = await asset();
      const types = ["REGISTERED", "EVIDENCE_ADDED", "TOKENIZED"] as const;
      for (const type of types) {
        await db.prisma.provenanceEvent.create({
          data: { assetId: a.id, type, payload: { note: type } },
        });
      }
      const events = await db.prisma.provenanceEvent.findMany({
        where: { assetId: a.id },
        orderBy: { sequence: "asc" },
      });
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect(events[0]?.prevHash).toBeNull();
      expect(events[1]?.prevHash).toBe(events[0]?.hash);
      expect(events[2]?.prevHash).toBe(events[1]?.hash);
      for (const e of events) expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("ignores client-supplied sequence and hash values", async () => {
      const a = await asset();
      const e = await db.prisma.provenanceEvent.create({
        data: { assetId: a.id, type: "REGISTERED", sequence: 99, hash: "f".repeat(64) },
      });
      expect(e.sequence).toBe(1);
      expect(e.hash).not.toBe("f".repeat(64));
    });

    it("keeps an independent chain per asset", async () => {
      const [a, b] = [await asset(), await asset()];
      await db.prisma.provenanceEvent.create({ data: { assetId: a.id, type: "REGISTERED" } });
      const first = await db.prisma.provenanceEvent.create({
        data: { assetId: b.id, type: "REGISTERED" },
      });
      expect(first.sequence).toBe(1);
      expect(first.prevHash).toBeNull();
    });

    it("produces a contiguous chain under concurrent appends", async () => {
      const a = await asset();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          db.prisma.provenanceEvent.create({
            data: { assetId: a.id, type: "EVIDENCE_ADDED", payload: { i } },
          }),
        ),
      );
      const { rows } = await db.sql.query<{ broken: number | null }>(
        "SELECT wb_verify_provenance_chain($1) AS broken",
        [a.id],
      );
      expect(rows[0]?.broken).toBeNull();
      const sequences = (
        await db.prisma.provenanceEvent.findMany({
          where: { assetId: a.id },
          select: { sequence: true },
        })
      )
        .map((e) => e.sequence)
        .sort((x, y) => x - y);
      expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("detects tampering that bypasses the append-only protection", async () => {
      const a = await asset();
      for (const type of ["REGISTERED", "EVIDENCE_ADDED", "TOKENIZED"] as const) {
        await db.prisma.provenanceEvent.create({ data: { assetId: a.id, type, payload: {} } });
      }
      const verify = async () =>
        (
          await db.sql.query<{ broken: number | null }>(
            "SELECT wb_verify_provenance_chain($1) AS broken",
            [a.id],
          )
        ).rows[0]?.broken;
      expect(await verify()).toBeNull();

      // Simulates a privileged attacker editing history directly.
      await db.sql.query("BEGIN");
      try {
        await db.sql.query(
          'ALTER TABLE "provenance_events" DISABLE TRIGGER "provenance_events_append_only"',
        );
        await db.sql.query(
          `UPDATE "provenance_events" SET "payload" = '{"forged": true}' WHERE "assetId" = $1 AND "sequence" = 2`,
          [a.id],
        );
        await db.sql.query(
          'ALTER TABLE "provenance_events" ENABLE TRIGGER "provenance_events_append_only"',
        );
        await db.sql.query("COMMIT");
      } catch (error) {
        await db.sql.query("ROLLBACK");
        throw error;
      }

      expect(await verify()).toBe(2);
    });
  });

  // ─── Uniqueness and single use ──────────────────────────────────────────────

  describe("unique rules", () => {
    it("allows only one asset per WorthyBound ID", async () => {
      const owner = await user();
      const id = wbId();
      await db.prisma.asset.create({ data: { wbId: id, category: "OTHER", ownerId: owner.id } });
      await expect(
        db.prisma.asset.create({ data: { wbId: id, category: "OTHER", ownerId: owner.id } }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it.each(["WB-7f93a281", "WB-7F93A28", "XX-7F93A281", "WB-7F93A281Z"])(
      "rejects the malformed WorthyBound ID %s",
      async (id) => {
        const owner = await user();
        await expectDbError(
          db.sql.query(
            `INSERT INTO "assets" ("id", "wbId", "ownerId", "category", "updatedAt")
             VALUES ($1, $2, $3, 'OTHER', now())`,
            [randomUUID(), id, owner.id],
          ),
          CHECK_VIOLATION,
        );
      },
    );

    it("uses each login nonce only once", async () => {
      const nonce = await db.prisma.authNonce.create({
        data: {
          walletAddress: wallet(),
          nonce: randomUUID(),
          domain: "localhost",
          expiresAt: new Date(Date.now() + 300_000),
        },
      });
      await db.prisma.authNonce.update({ where: { id: nonce.id }, data: { usedAt: new Date() } });
      await expectDbError(
        db.prisma.authNonce.update({ where: { id: nonce.id }, data: { usedAt: new Date() } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expect(
        db.prisma.authNonce.create({
          data: {
            walletAddress: wallet(),
            nonce: nonce.nonce,
            domain: "localhost",
            expiresAt: new Date(Date.now() + 300_000),
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("does not allow changing a nonce's binding fields", async () => {
      const nonce = await db.prisma.authNonce.create({
        data: {
          walletAddress: wallet(),
          nonce: randomUUID(),
          domain: "localhost",
          expiresAt: new Date(Date.now() + 300_000),
        },
      });
      await expectDbError(
        db.prisma.authNonce.update({ where: { id: nonce.id }, data: { domain: "evil.example" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("allows only one open custody period per asset", async () => {
      const a = await asset();
      await db.prisma.ownership.create({
        data: { assetId: a.id, ownerId: a.ownerId, reason: "REGISTRATION" },
      });
      await expectDbError(
        db.sql.query(
          `INSERT INTO "ownerships" ("id", "assetId", "ownerId", "reason") VALUES ($1, $2, $3, 'TRANSFER')`,
          [randomUUID(), a.id, (await user()).id],
        ),
        UNIQUE_VIOLATION,
      );
    });

    it("allows only one open transfer per asset", async () => {
      const a = await asset();
      const data = {
        assetId: a.id,
        fromUserId: a.ownerId,
        toWalletAddress: wallet(),
        expiresAt: new Date(Date.now() + 86_400_000),
      };
      const first = await db.prisma.transferRequest.create({ data });
      await expect(db.prisma.transferRequest.create({ data })).rejects.toBeDefined();
      await db.prisma.transferRequest.update({
        where: { id: first.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
      await expect(db.prisma.transferRequest.create({ data })).resolves.toBeDefined();
    });

    it("allows only one active assignment of a role per user", async () => {
      const [holder, granter] = [await user(), await user()];
      const data = {
        userId: holder.id,
        role: "VERIFIER_REVIEWER" as const,
        grantedById: granter.id,
      };
      const first = await db.prisma.roleAssignment.create({ data });
      await expect(db.prisma.roleAssignment.create({ data })).rejects.toBeDefined();
      await db.prisma.roleAssignment.update({
        where: { id: first.id },
        data: { revokedAt: new Date() },
      });
      await expect(db.prisma.roleAssignment.create({ data })).resolves.toBeDefined();
    });

    it("rejects a reused attestation nonce for the same verifier", async () => {
      const att = await attestation();
      const request = await assign(await activeAsset(), att.verifierId, att.templateVersionId);
      await expect(
        db.prisma.attestation.create({
          data: { ...attestationData(request), nonce: att.nonce },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  // ─── Authority ──────────────────────────────────────────────────────────────

  describe("authority checks", () => {
    it("prevents users granting roles to themselves", async () => {
      const u = await user();
      await expectDbError(
        db.sql.query(
          `INSERT INTO "role_assignments" ("id", "userId", "role", "grantedById") VALUES ($1, $2, 'ADMIN', $2)`,
          [randomUUID(), u.id],
        ),
        CHECK_VIOLATION,
      );
    });

    it("prevents verifiers approving themselves", async () => {
      const u = await kycUser();
      await expectDbError(
        db.prisma.verifier.create({
          data: {
            userId: u.id,
            entityType: "INDIVIDUAL",
            status: "APPROVED",
            approvedById: u.id,
            approvedAt: new Date(),
          },
        }),
        CHECK_VIOLATION,
      );
    });

    it("prevents verifiers approving their own category permissions", async () => {
      const v = await verifier({ categories: [] });
      await expectDbError(
        db.prisma.verifierCategoryPermission.create({
          data: {
            verifierId: v.id,
            category: "FINE_ART",
            status: "APPROVED",
            approvedById: v.userId,
            approvedAt: new Date(),
          },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("accepts an attestation from an approved, permitted, independent verifier", async () => {
      await expect(attestation()).resolves.toMatchObject({ status: "ACTIVE" });
    });

    it.each(["APPLIED", "UNDER_REVIEW", "SUSPENDED", "REVOKED"] as const)(
      "rejects attestations from a %s verifier",
      async (status) => {
        const { v, request } = await assigned();
        await db.prisma.verifier.update({ where: { id: v.id }, data: { status } });
        await expectDbError(
          db.prisma.attestation.create({ data: attestationData(request) }),
          DatabaseErrorCode.AUTHORITY,
        );
      },
    );

    it("rejects attestations from a verifier whose identity is no longer verified", async () => {
      const { v, request } = await assigned();
      await db.prisma.user.update({
        where: { id: v.userId },
        data: { identityStatus: "EXPIRED" },
      });
      await expectDbError(
        db.prisma.attestation.create({ data: attestationData(request) }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("rejects attestations once the verifier's permission for the category is revoked", async () => {
      const { v, request } = await assigned({ category: "FINE_ART" });
      await db.prisma.verifierCategoryPermission.updateMany({
        where: { verifierId: v.id, category: "FINE_ART" },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      await expectDbError(
        db.prisma.attestation.create({ data: attestationData(request) }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it.each(["REPORTED_STOLEN", "REPORTED_LOST", "DISPUTED", "REVOKED"] as const)(
      "rejects attestations on a %s asset",
      async (status) => {
        const { a, request } = await assigned();
        await db.prisma.asset.update({ where: { id: a.id }, data: { status } });
        await expectDbError(
          db.prisma.attestation.create({ data: attestationData(request) }),
          DatabaseErrorCode.AUTHORITY,
        );
      },
    );

    it("rejects attestations against a template version retired after assignment", async () => {
      const { tv, request } = await assigned();
      await db.prisma.verificationTemplateVersion.update({
        where: { id: tv.id },
        data: { status: "RETIRED" },
      });
      await expectDbError(
        db.prisma.attestation.create({ data: attestationData(request) }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it.each([
      ["a claim the template does not require", { claimType: "APPRAISAL" as const }],
      ["a method the template does not allow", { method: "REMOTE" as const }],
    ])("rejects attestations with %s", async (_label, change) => {
      const { request } = await assigned();
      await expectDbError(
        db.prisma.attestation.create({ data: { ...attestationData(request), ...change } }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("requires a request assigned to the attesting verifier", async () => {
      const { request, tv } = await assigned();
      const other = await verifier();
      await expectDbError(
        db.prisma.attestation.create({
          data: { ...attestationData(request), verifierId: other.id },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
      const otherAsset = await activeAsset();
      await expectDbError(
        db.prisma.attestation.create({
          data: { ...attestationData(request), assetId: otherAsset.id },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
      const open = await db.prisma.verificationRequest.create({
        data: {
          assetId: otherAsset.id,
          requesterId: otherAsset.ownerId,
          templateVersionId: tv.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await expectDbError(
        db.prisma.attestation.create({
          data: {
            ...attestationData({ ...open, assignedVerifierId: request.assignedVerifierId }),
          },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("requires the attestation to name its request", async () => {
      const { request } = await assigned();
      const data: Partial<Prisma.AttestationUncheckedCreateInput> = attestationData(request);
      delete data.verificationRequestId;
      await expect(
        db.prisma.attestation.create({ data: data as Prisma.AttestationUncheckedCreateInput }),
      ).rejects.toBeDefined();
    });

    it("stores the SHA-256 of the exact signed message", async () => {
      const { request } = await assigned();
      await expectDbError(
        db.prisma.attestation.create({
          data: { ...attestationData(request), signedPayloadHash: randomHex64() },
        }),
        CHECK_VIOLATION,
      );
    });

    it("requires an expiry within the template's validity", async () => {
      const { request } = await assigned();
      const issuedAt = new Date("2026-01-31T12:00:00.000Z");
      const create = (expiresAt: Date | null) =>
        db.prisma.attestation.create({
          data: { ...attestationData(request), issuedAt, expiresAt },
        });
      await expectDbError(create(null), DatabaseErrorCode.AUTHORITY);
      await expectDbError(
        create(new Date("2031-01-31T12:00:00.001Z")),
        DatabaseErrorCode.AUTHORITY,
      );
      await expect(create(new Date("2031-01-31T12:00:00.000Z"))).resolves.toMatchObject({
        status: "ACTIVE",
      });
    });

    it("keeps one current attestation per verifier, asset and claim", async () => {
      const { request } = await assigned();
      const first = await db.prisma.attestation.create({ data: attestationData(request) });
      await expect(
        db.prisma.attestation.create({ data: attestationData(request) }),
      ).rejects.toBeDefined();
      await db.prisma.attestation.update({
        where: { id: first.id },
        data: { status: "SUPERSEDED" },
      });
      await expect(
        db.prisma.attestation.create({
          data: { ...attestationData(request), supersedesId: first.id },
        }),
      ).resolves.toMatchObject({ status: "ACTIVE", supersedesId: first.id });
    });

    it("only supersedes the same verifier's superseded attestation of the same claim", async () => {
      const { request } = await assigned();
      const active = await db.prisma.attestation.create({ data: attestationData(request) });
      await expectDbError(
        db.prisma.attestation.create({
          data: {
            ...attestationData(request),
            claimType: "CONDITION",
            conditionGrade: "GOOD",
            supersedesId: active.id,
          },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
      const other = await attestation();
      await db.prisma.attestation.update({
        where: { id: other.id },
        data: { status: "SUPERSEDED" },
      });
      await expectDbError(
        db.prisma.attestation.create({
          data: {
            ...attestationData(request),
            claimType: "CONDITION",
            conditionGrade: "GOOD",
            supersedesId: other.id,
          },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
    });
  });

  // ─── Immutability ───────────────────────────────────────────────────────────

  describe("attestation immutability", () => {
    it("rejects changes to the signed claim", async () => {
      const att = await attestation();
      await expectDbError(
        db.prisma.attestation.update({ where: { id: att.id }, data: { result: "CONTRADICTED" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("allows status changes and keeps REVOKED final", async () => {
      const att = await attestation();
      await db.prisma.attestation.update({ where: { id: att.id }, data: { status: "DISPUTED" } });
      await db.prisma.attestation.update({ where: { id: att.id }, data: { status: "REVOKED" } });
      await expectDbError(
        db.prisma.attestation.update({ where: { id: att.id }, data: { status: "ACTIVE" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("sets the chain address once only", async () => {
      const att = await attestation();
      await db.prisma.attestation.update({
        where: { id: att.id },
        data: { chainAttestationAddress: wallet() },
      });
      await expectDbError(
        db.prisma.attestation.update({
          where: { id: att.id },
          data: { chainAttestationAddress: wallet() },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("rejects changes to the signed message", async () => {
      const att = await attestation();
      await expectDbError(
        db.prisma.attestation.update({ where: { id: att.id }, data: signed() }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("rejects changes to the assessed condition grade", async () => {
      const { request } = await assigned();
      const att = await db.prisma.attestation.create({
        data: {
          ...attestationData(request),
          claimType: "CONDITION",
          conditionGrade: "VERY_GOOD",
        },
      });
      await expectDbError(
        db.prisma.attestation.update({ where: { id: att.id }, data: { conditionGrade: "NEW" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("rejects deletion so the original verification stays visible", async () => {
      const att = await attestation();
      await expectDbError(
        db.prisma.attestation.delete({ where: { id: att.id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });
  });

  describe("template version immutability", () => {
    it("allows editing and deleting drafts", async () => {
      const tv = await templateVersion("LUXURY_WATCH", "DRAFT");
      await db.prisma.verificationTemplateVersion.update({
        where: { id: tv.id },
        data: { minVerifiers: 2 },
      });
      await expect(
        db.prisma.verificationTemplateVersion.delete({ where: { id: tv.id } }),
      ).resolves.toBeDefined();
    });

    it("rejects edits to published versions but allows retirement", async () => {
      const tv = await templateVersion();
      await expectDbError(
        db.prisma.verificationTemplateVersion.update({
          where: { id: tv.id },
          data: { minVerifiers: 3 },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await db.prisma.verificationTemplateVersion.update({
        where: { id: tv.id },
        data: { status: "RETIRED" },
      });
      await expectDbError(
        db.prisma.verificationTemplateVersion.update({
          where: { id: tv.id },
          data: { status: "PUBLISHED" },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("rejects deletion of published versions", async () => {
      const tv = await templateVersion();
      await expectDbError(
        db.prisma.verificationTemplateVersion.delete({ where: { id: tv.id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });
  });

  describe("verification templates", () => {
    const draft = async (
      overrides: Partial<Prisma.VerificationTemplateVersionUncheckedCreateInput> = {},
    ) => {
      const template = await db.prisma.verificationTemplate.create({
        data: { code: `tpl-${randomUUID()}`, category: "LUXURY_WATCH", name: "Draft" },
      });
      return db.prisma.verificationTemplateVersion.create({
        data: {
          templateId: template.id,
          version: 1,
          ...requirements,
          createdById: (await user()).id,
          ...overrides,
        },
      });
    };

    const publish = async (id: string, publishedById: string) =>
      db.prisma.verificationTemplateVersion.update({
        where: { id },
        data: { status: "PUBLISHED", publishedAt: new Date(), publishedById },
      });

    it("is published by an admin other than its creator, unless the creator is the only admin", async () => {
      const [creator] = [await admin(), await admin()];
      const tv = await draft({ createdById: creator.id });
      await expectDbError(publish(tv.id, creator.id), DatabaseErrorCode.AUTHORITY);

      const rolledBack = new Error("rolled back");
      await expect(
        db.prisma.$transaction(async (tx) => {
          await tx.roleAssignment.updateMany({
            where: { role: "ADMIN", revokedAt: null, userId: { not: creator.id } },
            data: { revokedAt: new Date() },
          });
          await expect(
            tx.verificationTemplateVersion.update({
              where: { id: tv.id },
              data: { status: "PUBLISHED", publishedAt: new Date(), publishedById: creator.id },
            }),
          ).resolves.toMatchObject({ status: "PUBLISHED" });
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);

      await expectDbError(
        db.prisma.verificationTemplateVersion.update({
          where: { id: tv.id },
          data: { status: "PUBLISHED", publishedAt: new Date() },
        }),
        CHECK_VIOLATION,
      );
      await expect(publish(tv.id, (await user()).id)).resolves.toMatchObject({
        status: "PUBLISHED",
      });
    });

    it("never changes the publisher of a published version", async () => {
      const tv = await templateVersion();
      await expectDbError(
        db.prisma.verificationTemplateVersion.update({
          where: { id: tv.id },
          data: { publishedById: (await user()).id },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("allows one published version per template", async () => {
      const tv = await templateVersion();
      const next = await db.prisma.verificationTemplateVersion.create({
        data: {
          templateId: tv.templateId,
          version: 2,
          ...requirements,
          createdById: (await user()).id,
        },
      });
      await expect(publish(next.id, (await user()).id)).rejects.toBeDefined();
      await db.prisma.verificationTemplateVersion.update({
        where: { id: tv.id },
        data: { status: "RETIRED" },
      });
      await expect(publish(next.id, (await user()).id)).resolves.toMatchObject({ version: 2 });
    });

    it.each([
      ["no claims", { requiredClaims: [] }],
      ["an unknown claim", { requiredClaims: ["VERIFIED"] }],
      ["duplicate claims", { requiredClaims: ["CONDITION", "CONDITION"] }],
      ["no methods", { allowedMethods: [] }],
      ["an unknown method", { allowedMethods: ["TELEPATHY"] }],
      ["evidence as plain types", { requiredEvidence: ["PHOTO"] }],
      ["an unknown evidence type", { requiredEvidence: [{ type: "SELFIE", minCount: 1 }] }],
      ["a zero evidence count", { requiredEvidence: [{ type: "PHOTO", minCount: 0 }] }],
      ["a fractional evidence count", { requiredEvidence: [{ type: "PHOTO", minCount: 1.5 }] }],
      [
        "an extra evidence field",
        { requiredEvidence: [{ type: "PHOTO", minCount: 1, optional: true }] },
      ],
      [
        "duplicate evidence types",
        {
          requiredEvidence: [
            { type: "PHOTO", minCount: 1 },
            { type: "PHOTO", minCount: 2 },
          ],
        },
      ],
    ])("publishes no version with %s", async (_label, change) => {
      const tv = await draft(change);
      await expectDbError(publish(tv.id, (await user()).id), DatabaseErrorCode.AUTHORITY);
    });

    it("requires 1-5 verifiers per claim", async () => {
      await expectDbError(draft({ minVerifiers: 6 }), CHECK_VIOLATION);
    });

    it("keeps attestation validity between 1 and 120 months, fixed once published", async () => {
      expect((await draft()).validityMonths).toBe(60);
      await expectDbError(draft({ validityMonths: 0 }), CHECK_VIOLATION);
      await expectDbError(draft({ validityMonths: 121 }), CHECK_VIOLATION);
      const tv = await templateVersion();
      await expectDbError(
        db.prisma.verificationTemplateVersion.update({
          where: { id: tv.id },
          data: { validityMonths: 12 },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("never changes a template's code or category", async () => {
      const tv = await templateVersion();
      await expectDbError(
        db.prisma.verificationTemplate.update({
          where: { id: tv.templateId },
          data: { category: "FINE_ART" },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.verificationTemplate.update({
          where: { id: tv.templateId },
          data: { code: "renamed" },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expect(
        db.prisma.verificationTemplate.update({
          where: { id: tv.templateId },
          data: { name: "Renamed" },
        }),
      ).resolves.toMatchObject({ name: "Renamed" });
    });
  });

  describe("verification requests", () => {
    const open = async (a: { id: string; ownerId: string }, templateVersionId: string) =>
      db.prisma.verificationRequest.create({
        data: {
          assetId: a.id,
          requesterId: a.ownerId,
          templateVersionId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

    it("is opened only by the asset owner", async () => {
      const [a, tv] = [await activeAsset(), await templateVersion()];
      await expectDbError(
        db.prisma.verificationRequest.create({
          data: {
            assetId: a.id,
            requesterId: (await user()).id,
            templateVersionId: tv.id,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("requires a published template version for the asset's category", async () => {
      const a = await activeAsset();
      await expectDbError(
        open(a, (await templateVersion("LUXURY_WATCH", "DRAFT")).id),
        DatabaseErrorCode.AUTHORITY,
      );
      await expectDbError(
        open(a, (await templateVersion("JEWELRY")).id),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("allows one open request per asset and template version", async () => {
      const [a, tv] = [await activeAsset(), await templateVersion()];
      const first = await open(a, tv.id);
      await expect(open(a, tv.id)).rejects.toBeDefined();
      await db.prisma.verificationRequest.update({
        where: { id: first.id },
        data: { status: "CANCELLED", closedReason: "owner" },
      });
      await expect(open(a, tv.id)).resolves.toMatchObject({ status: "OPEN" });
    });

    it.each([
      ["an open request with a verifier", { assignedAt: new Date() }],
      ["an assigned request without a verifier", { status: "ASSIGNED" as const }],
      ["a completed request without a completion date", { status: "COMPLETED" as const }],
      ["a closing reason on an open request", { closedReason: "x" }],
    ])("rejects %s", async (_label, change) => {
      const [a, tv] = [await activeAsset(), await templateVersion()];
      await expectDbError(
        db.prisma.verificationRequest.create({
          data: {
            assetId: a.id,
            requesterId: a.ownerId,
            templateVersionId: tv.id,
            expiresAt: new Date(Date.now() + 86_400_000),
            ...change,
          },
        }),
        CHECK_VIOLATION,
      );
    });

    it.each(["SUSPENDED", "REVOKED"] as const)(
      "is not assigned to a %s verifier",
      async (status) => {
        const [a, tv] = [await activeAsset(), await templateVersion()];
        const v = await verifier({ status });
        await expectDbError(assign(a, v.id, tv.id), DatabaseErrorCode.AUTHORITY);
      },
    );

    it("is not assigned to a verifier without a verified identity or category permission", async () => {
      const [a, tv] = [await activeAsset(), await templateVersion()];
      const expired = await verifier();
      await db.prisma.user.update({
        where: { id: expired.userId },
        data: { identityStatus: "EXPIRED" },
      });
      await expectDbError(assign(a, expired.id, tv.id), DatabaseErrorCode.AUTHORITY);
      const jeweller = await verifier({ categories: ["JEWELRY"] });
      await expectDbError(assign(a, jeweller.id, tv.id), DatabaseErrorCode.AUTHORITY);
    });

    it("is not assigned to a verifier who owns the asset", async () => {
      const v = await verifier();
      const a = await activeAsset("LUXURY_WATCH", v.userId);
      await expectDbError(
        assign(a, v.id, (await templateVersion()).id),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("checks the verifier when a request is taken, not afterwards", async () => {
      const [a, tv] = [await activeAsset(), await templateVersion()];
      const request = await open(a, tv.id);
      const v = await verifier();
      await db.prisma.verificationRequest.update({
        where: { id: request.id },
        data: { status: "ASSIGNED", assignedVerifierId: v.id, assignedAt: new Date() },
      });
      await db.prisma.verifier.update({ where: { id: v.id }, data: { status: "SUSPENDED" } });
      await expect(
        db.prisma.verificationRequest.update({
          where: { id: request.id },
          data: { status: "OPEN", assignedVerifierId: null, assignedAt: null },
        }),
      ).resolves.toMatchObject({ status: "OPEN" });
      await expectDbError(
        db.prisma.verificationRequest.update({
          where: { id: request.id },
          data: { status: "ASSIGNED", assignedVerifierId: v.id, assignedAt: new Date() },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("never deletes a request, never moves it and keeps finished requests final", async () => {
      const { request } = await assigned();
      await expectDbError(
        db.prisma.verificationRequest.delete({ where: { id: request.id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.verificationRequest.update({
          where: { id: request.id },
          data: { assetId: (await activeAsset()).id },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.verificationRequest.update({
          where: { id: request.id },
          data: { expiresAt: new Date(Date.now() + 10 * 86_400_000) },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await db.prisma.verificationRequest.update({
        where: { id: request.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      await expectDbError(
        db.prisma.verificationRequest.update({
          where: { id: request.id },
          data: { status: "CANCELLED", completedAt: null },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });
  });

  // ─── Check constraints ──────────────────────────────────────────────────────

  describe("check constraints", () => {
    it("requires a condition grade on confirmed CONDITION claims only", async () => {
      const { request } = await assigned();
      const { request: second } = await assigned();
      const data = () => attestationData(request);
      await expectDbError(
        db.prisma.attestation.create({ data: { ...data(), claimType: "CONDITION" } }),
        CHECK_VIOLATION,
      );
      await expectDbError(
        db.prisma.attestation.create({ data: { ...data(), conditionGrade: "GOOD" } }),
        CHECK_VIOLATION,
      );
      await expect(
        db.prisma.attestation.create({
          data: { ...data(), claimType: "CONDITION", conditionGrade: "FAIR" },
        }),
      ).resolves.toMatchObject({ conditionGrade: "FAIR" });
      await expect(
        db.prisma.attestation.create({
          data: { ...attestationData(second), claimType: "CONDITION", result: "INCONCLUSIVE" },
        }),
      ).resolves.toMatchObject({ conditionGrade: null });
    });

    it("keeps the cached trust score within 0-100", async () => {
      const a = await asset();
      await expectDbError(
        db.prisma.asset.update({ where: { id: a.id }, data: { currentTrustScore: 101 } }),
        CHECK_VIOLATION,
      );
    });

    it("rejects snapshot scores outside 0-100", async () => {
      const a = await asset();
      await expectDbError(
        db.prisma.trustScoreSnapshot.create({
          data: {
            assetId: a.id,
            score: -1,
            verificationLevel: "UNVERIFIED",
            factors: [],
            deductions: [],
            capsApplied: [],
            excludedProofs: [],
            engineVersion: "1.0.0",
            weightsVersion: "w",
            inputsHash: randomHex64(),
            computedAt: new Date(),
          },
        }),
        CHECK_VIOLATION,
      );
    });

    it.each([
      ["a public URL as storage key", { storageKey: "https://bucket.example/evidence.jpg" }],
      ["a malformed sha256", { sha256: "not-a-hash" }],
      ["a zero size", { sizeBytes: 0 }],
    ])("rejects evidence with %s", async (_label, override) => {
      const a = await asset();
      await expectDbError(
        db.prisma.evidence.create({
          data: {
            assetId: a.id,
            uploaderId: a.ownerId,
            type: "PHOTO",
            storageKey: `evidence/${randomUUID()}`,
            sha256: randomHex64(),
            mimeType: "image/jpeg",
            sizeBytes: 10,
            ...override,
          },
        }),
        CHECK_VIOLATION,
      );
    });

    it("prevents uploaders reviewing their own evidence", async () => {
      const a = await asset();
      await expectDbError(
        db.prisma.evidence.create({
          data: {
            assetId: a.id,
            uploaderId: a.ownerId,
            reviewedById: a.ownerId,
            type: "RECEIPT",
            storageKey: `evidence/${randomUUID()}`,
            sha256: randomHex64(),
            mimeType: "application/pdf",
            sizeBytes: 10,
          },
        }),
        CHECK_VIOLATION,
      );
    });

    it("requires a chain address for tokenized assets", async () => {
      const a = await asset();
      await expectDbError(
        db.prisma.asset.update({ where: { id: a.id }, data: { tokenizationStatus: "TOKENIZED" } }),
        CHECK_VIOLATION,
      );
    });

    it("requires a KYC provider reference for verified identities", async () => {
      await expectDbError(
        db.prisma.user.create({ data: { walletAddress: wallet(), identityStatus: "VERIFIED" } }),
        CHECK_VIOLATION,
      );
    });

    it("requires a signature once a chain transaction is submitted", async () => {
      await expectDbError(
        db.prisma.chainTransaction.create({
          data: {
            idempotencyKey: randomUUID(),
            kind: "REGISTER_ASSET",
            entityType: "ASSET",
            entityId: randomUUID(),
            status: "SUBMITTED",
          },
        }),
        CHECK_VIOLATION,
      );
    });

    it("makes chain transactions idempotent by key", async () => {
      const data = {
        idempotencyKey: `register:${randomUUID()}`,
        kind: "REGISTER_ASSET" as const,
        entityType: "ASSET" as const,
        entityId: randomUUID(),
      };
      await db.prisma.chainTransaction.create({ data });
      await expect(db.prisma.chainTransaction.create({ data })).rejects.toMatchObject({
        code: "P2002",
      });
    });
  });

  // ─── Asset registration ─────────────────────────────────────────────────────

  describe("asset registration", () => {
    const withSerial = async (fingerprint = randomHex64()) =>
      db.prisma.asset.create({
        data: {
          wbId: wbId(),
          category: "LUXURY_WATCH",
          ownerId: (await user()).id,
          brand: "Rolex",
          model: "Submariner",
          serialNumber: "AB1234",
          serialFingerprint: fingerprint,
          serialFingerprintKeyVersion: 1,
        },
      });

    const publishedAsset = async () => {
      const a = await withSerial();
      return db.prisma.asset.update({
        where: { id: a.id },
        data: { status: "ACTIVE", publishedAt: new Date() },
      });
    };

    it.each([
      ["a serial without a fingerprint", { serialNumber: "AB1234" }],
      [
        "a fingerprint without a serial",
        { serialFingerprint: randomHex64(), serialFingerprintKeyVersion: 1 },
      ],
      [
        "a serial with a malformed fingerprint",
        { serialNumber: "AB1234", serialFingerprint: "AB1234", serialFingerprintKeyVersion: 1 },
      ],
      [
        "a serial without a key version",
        { serialNumber: "AB1234", serialFingerprint: randomHex64() },
      ],
    ])("rejects %s", async (_name, fields) => {
      await expectDbError(
        db.prisma.asset.create({
          data: { wbId: wbId(), category: "OTHER", ownerId: (await user()).id, ...fields },
        }),
        CHECK_VIOLATION,
      );
    });

    it("allows each item only once until it is revoked", async () => {
      const fingerprint = randomHex64();
      const first = await withSerial(fingerprint);
      await expect(withSerial(fingerprint)).rejects.toMatchObject({ code: "P2002" });
      await db.prisma.asset.update({ where: { id: first.id }, data: { status: "REVOKED" } });
      await expect(withSerial(fingerprint)).resolves.toBeDefined();
    });

    it("requires publishedAt for published statuses", async () => {
      const a = await withSerial();
      await expectDbError(
        db.prisma.asset.update({ where: { id: a.id }, data: { status: "ACTIVE" } }),
        CHECK_VIOLATION,
      );
    });

    it.each([
      ["category", { category: "JEWELRY" as const }],
      ["brand", { brand: "Omega" }],
      ["model", { model: "Daytona" }],
      ["serial", { serialNumber: "ZZ9999" }],
      ["publication date", { publishedAt: new Date(0) }],
    ])("locks the %s of a published asset", async (_name, change) => {
      const a = await publishedAsset();
      await expectDbError(
        db.prisma.asset.update({ where: { id: a.id }, data: change }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("still allows public details, condition and status to change after publishing", async () => {
      const a = await publishedAsset();
      await expect(
        db.prisma.asset.update({
          where: { id: a.id },
          data: { publicDescription: "Serviced", condition: "GOOD", status: "REPORTED_LOST" },
        }),
      ).resolves.toMatchObject({ status: "REPORTED_LOST" });
    });

    it("never changes the WorthyBound ID, never deletes assets and keeps REVOKED final", async () => {
      const a = await asset();
      await expectDbError(
        db.prisma.asset.update({ where: { id: a.id }, data: { wbId: wbId() } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.asset.delete({ where: { id: a.id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await db.prisma.asset.update({ where: { id: a.id }, data: { status: "REVOKED" } });
      await expectDbError(
        db.prisma.asset.update({ where: { id: a.id }, data: { status: "DRAFT" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("stores well-formed idempotency keys once per user and operation", async () => {
      const u = await user();
      const data = {
        userId: u.id,
        scope: "asset.register",
        key: randomUUID(),
        requestHash: randomHex64(),
        resourceId: randomUUID(),
      };
      await db.prisma.idempotencyKey.create({ data });
      await expect(db.prisma.idempotencyKey.create({ data })).rejects.toMatchObject({
        code: "P2002",
      });
      await expectDbError(
        db.prisma.idempotencyKey.create({ data: { ...data, key: "bad key!" } }),
        CHECK_VIOLATION,
      );
    });
  });

  // ─── Evidence Vault ─────────────────────────────────────────────────────────

  describe("evidence vault", () => {
    const evidence = async (fields: Partial<Prisma.EvidenceUncheckedCreateInput> = {}) => {
      const a = fields.assetId ? null : await asset();
      return db.prisma.evidence.create({
        data: {
          assetId: a?.id as string,
          uploaderId: a?.ownerId as string,
          type: "PHOTO",
          storageKey: `evidence/${randomUUID()}`,
          sha256: randomHex64(),
          mimeType: "image/jpeg",
          sizeBytes: 10,
          ...fields,
        },
      });
    };

    const upload = async (fields: Partial<Prisma.EvidenceUploadUncheckedCreateInput> = {}) => {
      const a = await asset();
      return db.prisma.evidenceUpload.create({
        data: {
          assetId: a.id,
          uploaderId: a.ownerId,
          type: "PHOTO",
          mimeType: "image/jpeg",
          sizeBytes: 10,
          sha256: randomHex64(),
          visibility: "PRIVATE",
          stagingKey: `staging/${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000),
          ...fields,
        },
      });
    };

    it.each([
      ["an unsupported file type", { mimeType: "text/html" }],
      ["an image over 25 MB", { sizeBytes: 25 * 1024 * 1024 + 1 }],
      ["a video over 500 MB", { mimeType: "video/mp4", sizeBytes: 500 * 1024 * 1024 + 1 }],
      ["a public photo without a public copy", { visibility: "PUBLIC" as const }],
      [
        "a public document",
        {
          type: "RECEIPT" as const,
          visibility: "PUBLIC" as const,
          publicStorageKey: `public/${randomUUID()}`,
        },
      ],
      [
        "a public HEIC photo",
        {
          mimeType: "image/heic",
          visibility: "PUBLIC" as const,
          publicStorageKey: `public/${randomUUID()}`,
        },
      ],
      ["a public copy while private", { publicStorageKey: `public/${randomUUID()}` }],
      [
        "a public URL as public copy",
        { visibility: "PUBLIC" as const, publicStorageKey: "https://cdn.example/a.jpg" },
      ],
    ])("rejects %s", async (_name, fields) => {
      await expectDbError(evidence(fields), CHECK_VIOLATION);
    });

    it("accepts a 500 MB video and a public photo with its public copy", async () => {
      await expect(
        evidence({ type: "VIDEO", mimeType: "video/mp4", sizeBytes: 500 * 1024 * 1024 }),
      ).resolves.toBeDefined();
      await expect(
        evidence({ visibility: "PUBLIC", publicStorageKey: `public/${randomUUID()}` }),
      ).resolves.toBeDefined();
    });

    it("stores each file only once per asset", async () => {
      const first = await evidence();
      await expect(
        evidence({ assetId: first.assetId, uploaderId: first.uploaderId, sha256: first.sha256 }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it.each([
      ["file hash", { sha256: randomHex64() }],
      ["storage key", { storageKey: `evidence/${randomUUID()}` }],
      ["file type", { mimeType: "image/png" }],
      ["size", { sizeBytes: 11 }],
      ["evidence type", { type: "RECEIPT" as const }],
      ["description", { description: "changed" }],
      ["duplicate flag", { duplicateOfId: null }],
    ])("never changes the %s", async (_name, change) => {
      const original = await evidence();
      const e = await evidence({ duplicateOfId: original.id });
      await expectDbError(
        db.prisma.evidence.update({ where: { id: e.id }, data: change }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("lets visibility change, never deletes and makes the review decision final", async () => {
      const e = await evidence();
      await db.prisma.evidence.update({
        where: { id: e.id },
        data: { visibility: "PUBLIC", publicStorageKey: `public/${randomUUID()}` },
      });
      await db.prisma.evidence.update({
        where: { id: e.id },
        data: { visibility: "PRIVATE", publicStorageKey: null },
      });
      await expectDbError(
        db.prisma.evidence.delete({ where: { id: e.id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      const reviewer = await admin();
      await db.prisma.evidence.update({
        where: { id: e.id },
        data: { reviewStatus: "ACCEPTED", reviewedById: reviewer.id, reviewedAt: new Date() },
      });
      await expectDbError(
        db.prisma.evidence.update({ where: { id: e.id }, data: { reviewStatus: "REJECTED" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.evidence.update({ where: { id: e.id }, data: { reviewReason: "changed" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("does not let evidence be marked a duplicate of itself", async () => {
      const id = randomUUID();
      await expectDbError(evidence({ id, duplicateOfId: id }), CHECK_VIOLATION);
    });

    it.each([
      ["a malformed hash", { sha256: "abc" }],
      ["a public URL as staging key", { stagingKey: "https://bucket.example/x" }],
      [
        "a completed upload without evidence",
        { status: "COMPLETED" as const, completedAt: new Date() },
      ],
      ["a failed upload without a reason", { status: "FAILED" as const, completedAt: new Date() }],
    ])("rejects an upload with %s", async (_name, fields) => {
      await expectDbError(upload(fields), CHECK_VIOLATION);
    });

    it("completes or fails an upload once and never changes the request", async () => {
      const u = await upload();
      await expectDbError(
        db.prisma.evidenceUpload.update({ where: { id: u.id }, data: { sizeBytes: 99 } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await db.prisma.evidenceUpload.update({
        where: { id: u.id },
        data: { status: "FAILED", failureReason: "hash_mismatch", completedAt: new Date() },
      });
      await expectDbError(
        db.prisma.evidenceUpload.update({
          where: { id: u.id },
          data: { status: "PENDING", failureReason: null, completedAt: null },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.evidenceUpload.delete({ where: { id: u.id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });
  });

  // ─── Verifier system ────────────────────────────────────────────────────────

  describe("verifier system", () => {
    const applicant = async (entityType: "INDIVIDUAL" | "BUSINESS" = "BUSINESS") =>
      db.prisma.verifier.create({
        data: { userId: (await kycUser()).id, entityType, status: "UNDER_REVIEW" },
      });

    const approve = async (verifierId: string) => {
      const admin = await user();
      return db.prisma.verifier.update({
        where: { id: verifierId },
        data: { status: "APPROVED", approvedById: admin.id, approvedAt: new Date() },
      });
    };

    const permission = async (verifierId: string, category: AssetCategory = "FINE_ART") =>
      db.prisma.verifierCategoryPermission.create({ data: { verifierId, category } });

    it("approves a verifier only with a verified identity", async () => {
      const [admin, unverified] = [await user(), await user()];
      await expectDbError(
        db.prisma.verifier.create({
          data: {
            userId: unverified.id,
            entityType: "INDIVIDUAL",
            status: "APPROVED",
            approvedById: admin.id,
            approvedAt: new Date(),
          },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
      const pending = await db.prisma.verifier.create({
        data: { userId: unverified.id, entityType: "INDIVIDUAL", status: "UNDER_REVIEW" },
      });
      await expectDbError(approve(pending.id), DatabaseErrorCode.AUTHORITY);
      await expect(approve((await applicant()).id)).resolves.toMatchObject({ status: "APPROVED" });
    });

    it("keeps an approved verifier usable after their identity expires", async () => {
      const v = await approve((await applicant()).id);
      await db.prisma.user.update({ where: { id: v.userId }, data: { identityStatus: "EXPIRED" } });
      await expect(
        db.prisma.verifier.update({ where: { id: v.id }, data: { status: "SUSPENDED" } }),
      ).resolves.toMatchObject({ status: "SUSPENDED" });
      await expectDbError(
        db.prisma.verifier.update({ where: { id: v.id }, data: { status: "APPROVED" } }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("never deletes a verifier, never moves it to another user and keeps REVOKED final", async () => {
      const v = await approve((await applicant()).id);
      await expectDbError(
        db.prisma.verifier.delete({ where: { id: v.id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.verifier.update({ where: { id: v.id }, data: { userId: (await user()).id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await db.prisma.verifier.update({ where: { id: v.id }, data: { status: "REVOKED" } });
      await expectDbError(
        db.prisma.verifier.update({ where: { id: v.id }, data: { status: "SUSPENDED" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it("lets an applicant change the entity type until approval, then locks it and the approval", async () => {
      const v = await applicant("INDIVIDUAL");
      await db.prisma.verifier.update({
        where: { id: v.id },
        data: { entityType: "BUSINESS", businessName: "Acme Appraisals" },
      });
      await approve(v.id);
      await expectDbError(
        db.prisma.verifier.update({ where: { id: v.id }, data: { entityType: "INDIVIDUAL" } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.verifier.update({ where: { id: v.id }, data: { approvedAt: new Date(0) } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.verifier.update({
          where: { id: v.id },
          data: { approvedById: (await user()).id },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });

    it.each(["APPLIED", "UNDER_REVIEW", "REJECTED", "REVOKED"] as const)(
      "approves no category for a %s verifier",
      async (status) => {
        const v = await approve((await applicant()).id);
        const p = await permission(v.id);
        const admin = await user();
        await db.prisma.verifier.update({ where: { id: v.id }, data: { status } });
        await expectDbError(
          db.prisma.verifierCategoryPermission.update({
            where: { id: p.id },
            data: { status: "APPROVED", approvedById: admin.id, approvedAt: new Date() },
          }),
          DatabaseErrorCode.AUTHORITY,
        );
      },
    );

    it("approves categories for approved and suspended verifiers", async () => {
      const v = await approve((await applicant()).id);
      const admin = await user();
      const approved = {
        status: "APPROVED" as const,
        approvedById: admin.id,
        approvedAt: new Date(),
      };
      const p = await permission(v.id, "FINE_ART");
      await expect(
        db.prisma.verifierCategoryPermission.update({ where: { id: p.id }, data: approved }),
      ).resolves.toMatchObject({ status: "APPROVED" });
      await db.prisma.verifier.update({ where: { id: v.id }, data: { status: "SUSPENDED" } });
      await expect(
        db.prisma.verifierCategoryPermission.create({
          data: { verifierId: v.id, category: "JEWELRY", ...approved },
        }),
      ).resolves.toMatchObject({ status: "APPROVED" });
    });

    it("allows one open permission per category and a new request after revocation", async () => {
      const v = await applicant();
      const first = await permission(v.id, "FINE_ART");
      await expect(permission(v.id, "FINE_ART")).rejects.toMatchObject({ code: "P2002" });
      await db.prisma.verifierCategoryPermission.update({
        where: { id: first.id },
        data: { status: "REVOKED", revokedAt: new Date(), reason: "Not qualified" },
      });
      await expect(permission(v.id, "FINE_ART")).resolves.toMatchObject({ status: "PENDING" });
    });

    it("never deletes a permission, never moves it and keeps REVOKED final", async () => {
      const v = await applicant();
      const p = await permission(v.id, "FINE_ART");
      await expectDbError(
        db.prisma.verifierCategoryPermission.delete({ where: { id: p.id } }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.verifierCategoryPermission.update({
          where: { id: p.id },
          data: { category: "JEWELRY" },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await expectDbError(
        db.prisma.verifierCategoryPermission.update({
          where: { id: p.id },
          data: { verifierId: (await applicant()).id },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
      await db.prisma.verifierCategoryPermission.update({
        where: { id: p.id },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      await expectDbError(
        db.prisma.verifierCategoryPermission.update({
          where: { id: p.id },
          data: { status: "PENDING" },
        }),
        DatabaseErrorCode.IMMUTABLE,
      );
    });
  });

  // ─── Verifier evidence ──────────────────────────────────────────────────────

  describe("verifier evidence", () => {
    const evidenceData = (assetId: string, uploaderId: string) => ({
      assetId,
      uploaderId,
      type: "INSPECTION_REPORT" as const,
      storageKey: `evidence/${randomUUID()}`,
      sha256: randomHex64(),
      mimeType: "application/pdf",
      sizeBytes: 10,
    });

    it("comes from the verifier assigned to the request, for the request's asset", async () => {
      const { a, v, request } = await assigned();
      const verifierData = {
        source: "VERIFIER" as const,
        verificationRequestId: request.id,
      };
      await expect(
        db.prisma.evidence.create({ data: { ...evidenceData(a.id, v.userId), ...verifierData } }),
      ).resolves.toMatchObject({ source: "VERIFIER" });
      await expectDbError(
        db.prisma.evidence.create({
          data: { ...evidenceData(a.id, (await user()).id), ...verifierData },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
      await expectDbError(
        db.prisma.evidence.create({
          data: { ...evidenceData((await activeAsset()).id, v.userId), ...verifierData },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("marks evidence from a request as verifier evidence, and only that", async () => {
      const { a, v, request } = await assigned();
      await expectDbError(
        db.prisma.evidence.create({
          data: { ...evidenceData(a.id, v.userId), verificationRequestId: request.id },
        }),
        CHECK_VIOLATION,
      );
      await expectDbError(
        db.prisma.evidence.create({
          data: { ...evidenceData(a.id, v.userId), source: "VERIFIER" },
        }),
        CHECK_VIOLATION,
      );
    });

    it("accepts uploads for a request only from its assigned verifier", async () => {
      const { a, v, request } = await assigned();
      const data = (uploaderId: string) => ({
        assetId: a.id,
        uploaderId,
        type: "PHOTO" as const,
        mimeType: "image/jpeg",
        sizeBytes: 10,
        sha256: randomHex64(),
        visibility: "PRIVATE" as const,
        stagingKey: `staging/${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        verificationRequestId: request.id,
      });
      await expect(
        db.prisma.evidenceUpload.create({ data: data(v.userId) }),
      ).resolves.toBeDefined();
      await expectDbError(
        db.prisma.evidenceUpload.create({ data: data(a.ownerId) }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("is reviewed by the assigned verifier or an admin, never the owner or anyone else", async () => {
      const { a, v } = await assigned();
      const review = async (reviewedById: string) => {
        const e = await db.prisma.evidence.create({ data: evidenceData(a.id, a.ownerId) });
        return db.prisma.evidence.update({
          where: { id: e.id },
          data: { reviewStatus: "ACCEPTED", reviewedById, reviewedAt: new Date() },
        });
      };
      await expect(review(v.userId)).resolves.toMatchObject({ reviewStatus: "ACCEPTED" });
      await expect(review((await admin()).id)).resolves.toMatchObject({ reviewStatus: "ACCEPTED" });
      await expectDbError(review((await user()).id), DatabaseErrorCode.AUTHORITY);
      await expectDbError(review((await verifier()).userId), DatabaseErrorCode.AUTHORITY);
      await db.prisma.roleAssignment.create({
        data: { userId: a.ownerId, role: "ADMIN", grantedById: (await user()).id },
      });
      await expectDbError(review(a.ownerId), DatabaseErrorCode.AUTHORITY);
    });

    it("stops the verifier reviewing once suspended", async () => {
      const { a, v } = await assigned();
      await db.prisma.verifier.update({ where: { id: v.id }, data: { status: "SUSPENDED" } });
      const e = await db.prisma.evidence.create({ data: evidenceData(a.id, a.ownerId) });
      await expectDbError(
        db.prisma.evidence.update({
          where: { id: e.id },
          data: { reviewStatus: "ACCEPTED", reviewedById: v.userId, reviewedAt: new Date() },
        }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("requires a reason to reject evidence", async () => {
      const { a, v } = await assigned();
      const e = await db.prisma.evidence.create({ data: evidenceData(a.id, a.ownerId) });
      const rejected = {
        reviewStatus: "REJECTED" as const,
        reviewedById: v.userId,
        reviewedAt: new Date(),
      };
      await expectDbError(
        db.prisma.evidence.update({ where: { id: e.id }, data: rejected }),
        CHECK_VIOLATION,
      );
      await expect(
        db.prisma.evidence.update({
          where: { id: e.id },
          data: { ...rejected, reviewReason: "Serial not legible" },
        }),
      ).resolves.toMatchObject({ reviewStatus: "REJECTED" });
    });
  });
});
