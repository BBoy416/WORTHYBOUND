import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AssetCategory,
  DatabaseErrorCode,
  isDatabaseError,
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

  const asset = async (category: AssetCategory = "LUXURY_WATCH", ownerId?: string) =>
    db.prisma.asset.create({
      data: { wbId: wbId(), category, ownerId: ownerId ?? (await user()).id },
    });

  const verifier = async (
    options: { status?: VerifierStatus; categories?: AssetCategory[] } = {},
  ) => {
    const admin = await user();
    const account = await user();
    const status = options.status ?? "APPROVED";
    const approved = status === "APPROVED";
    const record = await db.prisma.verifier.create({
      data: {
        userId: account.id,
        entityType: "BUSINESS",
        status,
        ...(approved ? { approvedById: admin.id, approvedAt: new Date() } : {}),
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
    return { ...record, admin };
  };

  const templateVersion = async (
    category: AssetCategory = "LUXURY_WATCH",
    status: TemplateVersionStatus = "PUBLISHED",
  ) => {
    const template = await db.prisma.verificationTemplate.create({
      data: { code: `tpl-${randomUUID()}`, category, name: "Test template" },
    });
    return db.prisma.verificationTemplateVersion.create({
      data: {
        templateId: template.id,
        version: 1,
        status,
        requiredClaims: ["AUTHENTICATION"],
        requiredEvidence: ["PHOTO"],
        allowedMethods: ["IN_PERSON"],
        ...(status === "DRAFT" ? {} : { publishedAt: new Date() }),
      },
    });
  };

  const attestationData = (assetId: string, verifierId: string, templateVersionId: string) => ({
    assetId,
    verifierId,
    templateVersionId,
    claimType: "AUTHENTICATION" as const,
    result: "CONFIRMED" as const,
    method: "IN_PERSON" as const,
    assuranceLevel: "HIGH" as const,
    nonce: randomUUID(),
    signedPayloadHash: randomHex64(),
    signature: randomBytes(64).toString("base64url"),
    issuedAt: new Date(),
  });

  const attestation = async () => {
    const a = await asset();
    const v = await verifier();
    const tv = await templateVersion();
    return db.prisma.attestation.create({ data: attestationData(a.id, v.id, tv.id) });
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
      await db.prisma.attestationStatusEvent.create({
        data: { attestationId: att.id, toStatus: "ACTIVE" },
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
      const a = await asset();
      await expect(
        db.prisma.attestation.create({
          data: {
            ...attestationData(a.id, att.verifierId, att.templateVersionId),
            nonce: att.nonce,
          },
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
      const u = await user();
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
        const [a, v, tv] = [await asset(), await verifier({ status }), await templateVersion()];
        await expectDbError(
          db.prisma.attestation.create({ data: attestationData(a.id, v.id, tv.id) }),
          DatabaseErrorCode.AUTHORITY,
        );
      },
    );

    it("rejects attestations outside the verifier's permitted categories", async () => {
      const a = await asset("FINE_ART");
      const v = await verifier({ categories: ["LUXURY_WATCH"] });
      const tv = await templateVersion("FINE_ART");
      await expectDbError(
        db.prisma.attestation.create({ data: attestationData(a.id, v.id, tv.id) }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("rejects attestations on the verifier's own asset", async () => {
      const v = await verifier();
      const a = await asset("LUXURY_WATCH", v.userId);
      const tv = await templateVersion();
      await expectDbError(
        db.prisma.attestation.create({ data: attestationData(a.id, v.id, tv.id) }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("rejects attestations against an unpublished template version", async () => {
      const [a, v, tv] = [
        await asset(),
        await verifier(),
        await templateVersion("LUXURY_WATCH", "DRAFT"),
      ];
      await expectDbError(
        db.prisma.attestation.create({ data: attestationData(a.id, v.id, tv.id) }),
        DatabaseErrorCode.AUTHORITY,
      );
    });

    it("rejects attestations whose template category differs from the asset", async () => {
      const a = await asset("LUXURY_WATCH");
      const v = await verifier({ categories: ["LUXURY_WATCH", "JEWELRY"] });
      const tv = await templateVersion("JEWELRY");
      await expectDbError(
        db.prisma.attestation.create({ data: attestationData(a.id, v.id, tv.id) }),
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

    it("rejects changes to the assessed condition grade", async () => {
      const a = await asset();
      const v = await verifier();
      const tv = await templateVersion();
      const att = await db.prisma.attestation.create({
        data: {
          ...attestationData(a.id, v.id, tv.id),
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

  // ─── Check constraints ──────────────────────────────────────────────────────

  describe("check constraints", () => {
    it("requires a condition grade on confirmed CONDITION claims only", async () => {
      const a = await asset();
      const v = await verifier();
      const tv = await templateVersion();
      const data = () => attestationData(a.id, v.id, tv.id);
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
          data: { ...data(), claimType: "CONDITION", result: "INCONCLUSIVE" },
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
});
