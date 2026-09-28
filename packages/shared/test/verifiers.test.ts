import { describe, expect, it } from "vitest";
import {
  PERMISSION_STATUSES_REQUIRING_REASON,
  type PublicVerifierSource,
  REAPPLY_COOLDOWN_MS,
  reapplyAvailableAt,
  reviewActor,
  toPublicVerifier,
  VERIFIER_STATUSES_REQUIRING_REASON,
  verifierPublicName,
} from "../src/index.js";

const SECRET = "PRIVATE";

function source(overrides: Partial<PublicVerifierSource> = {}): PublicVerifierSource {
  return {
    id: "0199d2a0-0000-7000-8000-000000000001",
    entityType: "LABORATORY",
    businessName: "Geneva Watch Lab",
    website: "https://lab.example",
    status: "APPROVED",
    approvedAt: new Date("2026-09-01T00:00:00.000Z"),
    categoryPermissions: [
      { category: "LUXURY_WATCH", status: "APPROVED" },
      { category: "JEWELRY", status: "PENDING" },
      { category: "FINE_ART", status: "REVOKED" },
      { category: "COLLECTIBLE", status: "APPROVED" },
    ],
    ...overrides,
  };
}

describe("toPublicVerifier", () => {
  it("names organisations and lists only approved categories", () => {
    expect(toPublicVerifier(source())).toEqual({
      id: "0199d2a0-0000-7000-8000-000000000001",
      entityType: "LABORATORY",
      publicName: "Geneva Watch Lab",
      website: "https://lab.example",
      status: "APPROVED",
      approvedAt: "2026-09-01T00:00:00.000Z",
      categories: ["COLLECTIBLE", "LUXURY_WATCH"],
    });
  });

  it("shows neither the name nor the website of an individual", () => {
    const profile = toPublicVerifier(
      source({
        entityType: "INDIVIDUAL",
        businessName: `${SECRET}-name`,
        website: "https://me.example",
      }),
    );
    expect(profile).toMatchObject({ entityType: "INDIVIDUAL", publicName: null, website: null });
    expect(JSON.stringify(profile)).not.toContain(SECRET);
    expect(JSON.stringify(profile)).not.toContain("me.example");
  });

  it("copies only allow-listed fields, so private columns cannot leak", () => {
    const row = {
      ...source(),
      userId: `${SECRET}-user`,
      bio: `${SECRET}-bio`,
      credentialStatus: "PENDING",
      approvedById: `${SECRET}-approver`,
      user: { walletAddress: `${SECRET}-wallet`, identityProviderRef: `${SECRET}-kyc` },
    };
    const profile = toPublicVerifier(row);
    expect(Object.keys(profile ?? {}).sort()).toEqual([
      "approvedAt",
      "categories",
      "entityType",
      "id",
      "publicName",
      "status",
      "website",
    ]);
    expect(JSON.stringify(profile)).not.toContain(SECRET);
  });

  it("has no profile for verifiers that were never approved", () => {
    expect(toPublicVerifier(source({ status: "APPLIED", approvedAt: null }))).toBeNull();
    expect(toPublicVerifier(source({ status: "REJECTED", approvedAt: null }))).toBeNull();
  });

  it("keeps suspended and revoked verifiers visible", () => {
    expect(toPublicVerifier(source({ status: "SUSPENDED" }))?.status).toBe("SUSPENDED");
    expect(toPublicVerifier(source({ status: "REVOKED", categoryPermissions: [] }))).toMatchObject({
      status: "REVOKED",
      categories: [],
    });
  });
});

describe("verifierPublicName", () => {
  it("names organisations only", () => {
    expect(verifierPublicName({ entityType: "BUSINESS", businessName: "Acme" })).toBe("Acme");
    expect(verifierPublicName({ entityType: "MANUFACTURER", businessName: "Maker" })).toBe("Maker");
    expect(verifierPublicName({ entityType: "INDIVIDUAL", businessName: "Jane" })).toBeNull();
  });
});

describe("reviewActor", () => {
  it("maps roles to the reviewing lifecycle actor, admin first", () => {
    expect(reviewActor(["USER", "ADMIN", "VERIFIER_REVIEWER"])).toBe("ADMIN");
    expect(reviewActor(["USER", "VERIFIER_REVIEWER"])).toBe("REVIEWER");
    expect(reviewActor(["USER", "VERIFIER"])).toBeNull();
  });
});

describe("reasons and re-application", () => {
  it("requires a reason for rejection, suspension and revocation", () => {
    expect(VERIFIER_STATUSES_REQUIRING_REASON).toEqual(["REJECTED", "SUSPENDED", "REVOKED"]);
    expect(PERMISSION_STATUSES_REQUIRING_REASON).toEqual(["SUSPENDED", "REVOKED"]);
  });

  it("allows applying again 30 days after a rejection", () => {
    const rejectedAt = new Date("2026-09-01T12:00:00.000Z");
    expect(REAPPLY_COOLDOWN_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(reapplyAvailableAt(rejectedAt).toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });
});
