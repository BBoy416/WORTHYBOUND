import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordKyc } from "../src/cli/kyc-record.js";
import { createTestDatabase, TEST_DATABASE_URL, TestWallet, type TestDatabase } from "./helpers.js";

describe.skipIf(!TEST_DATABASE_URL)("kyc:record", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  const signedUpUser = async () => {
    const wallet = new TestWallet();
    const user = await db.prisma.user.create({ data: { walletAddress: wallet.address } });
    return { wallet, user };
  };

  it("records a verified identity with its provider reference and audits it without the reference", async () => {
    const { wallet, user } = await signedUpUser();
    const at = new Date("2026-09-28T12:00:00.000Z");
    const result = await recordKyc(
      db.prisma,
      {
        walletAddress: wallet.address,
        provider: "acme-kyc",
        reference: "case-123456",
        status: "VERIFIED",
      },
      () => at,
    );
    expect(result).toEqual({ fromStatus: "UNVERIFIED", status: "VERIFIED" });
    expect(await db.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      identityStatus: "VERIFIED",
      identityProvider: "acme-kyc",
      identityProviderRef: "case-123456",
      identityVerifiedAt: at,
    });
    const logs = await db.prisma.auditLog.findMany({
      where: { action: "identity.recorded", targetId: user.id },
    });
    expect(logs.map((l) => [l.actorId, l.metadata])).toEqual([
      [null, { fromStatus: "UNVERIFIED", status: "VERIFIED", provider: "acme-kyc", via: "cli" }],
    ]);
    expect(JSON.stringify(logs)).not.toContain("case-123456");
  });

  it("records an expired identity and keeps the original verification date", async () => {
    const { wallet, user } = await signedUpUser();
    const input = { walletAddress: wallet.address, provider: "acme-kyc", reference: "case-9" };
    const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
    await recordKyc(db.prisma, { ...input, status: "VERIFIED" }, () => verifiedAt);
    expect(await recordKyc(db.prisma, { ...input, status: "EXPIRED" })).toEqual({
      fromStatus: "VERIFIED",
      status: "EXPIRED",
    });
    expect(await db.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      identityStatus: "EXPIRED",
      identityVerifiedAt: verifiedAt,
    });
  });

  it("requires an existing user and valid arguments", async () => {
    const valid = {
      walletAddress: new TestWallet().address,
      provider: "acme-kyc",
      reference: "case-1",
      status: "VERIFIED" as const,
    };
    await expect(recordKyc(db.prisma, valid)).rejects.toThrow("must sign in first");
    const { wallet } = await signedUpUser();
    const known = { ...valid, walletAddress: wallet.address };
    await expect(recordKyc(db.prisma, { ...known, walletAddress: "z".repeat(44) })).rejects.toThrow(
      "Invalid wallet address",
    );
    await expect(recordKyc(db.prisma, { ...known, provider: "acme kyc" })).rejects.toThrow(
      "Invalid provider name",
    );
    await expect(recordKyc(db.prisma, { ...known, reference: "" })).rejects.toThrow(
      "Invalid provider reference",
    );
    await expect(
      recordKyc(db.prisma, { ...known, status: "PENDING" as unknown as "VERIFIED" }),
    ).rejects.toThrow("Status must be one of");
  });
});
