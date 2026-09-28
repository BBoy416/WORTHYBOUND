import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantAdmin } from "../src/cli/admin-grant.js";
import { createTestDatabase, TEST_DATABASE_URL, TestWallet, type TestDatabase } from "./helpers.js";

describe.skipIf(!TEST_DATABASE_URL)("admin:grant", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("grants ADMIN once and records it in the audit log", async () => {
    const wallet = new TestWallet();
    expect(await grantAdmin(db.prisma, wallet.address)).toBe("granted");
    expect(await grantAdmin(db.prisma, wallet.address)).toBe("already_admin");

    const user = await db.prisma.user.findUniqueOrThrow({
      where: { walletAddress: wallet.address },
      include: { roles: true },
    });
    expect(user.identityStatus).toBe("UNVERIFIED");
    expect(user.roles.map((r) => [r.role, r.grantedById])).toEqual([
      ["USER", null],
      ["ADMIN", null],
    ]);
    const logs = await db.prisma.auditLog.findMany({
      where: { action: "role.granted", targetId: user.id },
    });
    expect(logs.map((l) => l.metadata)).toEqual([{ role: "ADMIN", via: "cli", newUser: true }]);
  });

  it("rejects an invalid wallet address", async () => {
    await expect(grantAdmin(db.prisma, "z".repeat(44))).rejects.toThrow("Invalid wallet address");
  });
});
