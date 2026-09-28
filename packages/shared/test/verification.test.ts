import { describe, expect, it } from "vitest";
import {
  type AttestationAuthorityContext,
  attestationAuthorityViolations,
  type AttestationFact,
  evaluateTemplate,
  type TemplateRequirements,
} from "../src/index.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");

function authority(
  overrides: {
    verifier?: Partial<AttestationAuthorityContext["verifier"]>;
    asset?: Partial<AttestationAuthorityContext["asset"]>;
    template?: Partial<AttestationAuthorityContext["template"]>;
  } & Partial<Pick<AttestationAuthorityContext, "claimType" | "method">> = {},
): AttestationAuthorityContext {
  return {
    verifier: {
      userId: "verifier-user",
      status: "APPROVED",
      identityStatus: "VERIFIED",
      approvedCategories: ["LUXURY_WATCH"],
      ...overrides.verifier,
    },
    asset: {
      ownerId: "owner-user",
      category: "LUXURY_WATCH",
      status: "ACTIVE",
      ...overrides.asset,
    },
    template: {
      status: "PUBLISHED",
      category: "LUXURY_WATCH",
      requirements: { requiredClaims: ["AUTHENTICATION"], allowedMethods: ["IN_PERSON"] },
      ...overrides.template,
    },
    claimType: overrides.claimType ?? "AUTHENTICATION",
    method: overrides.method ?? "IN_PERSON",
  };
}

describe("attestationAuthorityViolations", () => {
  it("allows an approved, permitted, independent verifier using a published template", () => {
    expect(attestationAuthorityViolations(authority())).toEqual([]);
  });

  it.each([
    [
      "an unapproved verifier",
      authority({ verifier: { status: "SUSPENDED" } }),
      "VERIFIER_NOT_APPROVED",
    ],
    [
      "a verifier whose identity verification expired",
      authority({ verifier: { identityStatus: "EXPIRED" } }),
      "VERIFIER_IDENTITY_NOT_VERIFIED",
    ],
    [
      "a verifier without permission for the category (watch specialist on fine art)",
      authority({
        asset: { category: "FINE_ART" },
        template: {
          status: "PUBLISHED",
          category: "FINE_ART",
          requirements: { requiredClaims: ["AUTHENTICATION"], allowedMethods: ["IN_PERSON"] },
        },
      }),
      "NO_CATEGORY_PERMISSION",
    ],
    [
      "a verifier attesting to their own asset",
      authority({ asset: { ownerId: "verifier-user" } }),
      "OWN_ASSET",
    ],
    ["a draft asset", authority({ asset: { status: "DRAFT" } }), "ASSET_NOT_ATTESTABLE"],
    ["a stolen asset", authority({ asset: { status: "REPORTED_STOLEN" } }), "ASSET_NOT_ATTESTABLE"],
    ["a draft template", authority({ template: { status: "DRAFT" } }), "TEMPLATE_NOT_PUBLISHED"],
    [
      "a retired template",
      authority({ template: { status: "RETIRED" } }),
      "TEMPLATE_NOT_PUBLISHED",
    ],
    [
      "a template for another category",
      authority({ template: { category: "JEWELRY" } }),
      "TEMPLATE_CATEGORY_MISMATCH",
    ],
    [
      "a claim the template does not cover",
      authority({ claimType: "APPRAISAL" }),
      "CLAIM_NOT_IN_TEMPLATE",
    ],
    ["a method the template does not allow", authority({ method: "REMOTE" }), "METHOD_NOT_ALLOWED"],
  ] as const)("rejects %s", (_label, ctx, violation) => {
    expect(attestationAuthorityViolations(ctx)).toEqual([violation]);
  });

  it("reports every violation at once", () => {
    const ctx = authority({
      verifier: { status: "REVOKED", approvedCategories: [], userId: "owner-user" },
      template: { status: "DRAFT" },
    });
    expect(attestationAuthorityViolations(ctx)).toEqual([
      "VERIFIER_NOT_APPROVED",
      "NO_CATEGORY_PERMISSION",
      "OWN_ASSET",
      "TEMPLATE_NOT_PUBLISHED",
    ]);
  });
});

describe("evaluateTemplate", () => {
  const requirements: TemplateRequirements = {
    requiredClaims: ["SERIAL_NUMBER", "AUTHENTICATION"],
    requiredEvidence: [
      { type: "PHOTO", minCount: 3 },
      { type: "RECEIPT", minCount: 1 },
    ],
    allowedMethods: ["IN_PERSON", "LABORATORY"],
    minVerifiers: 1,
  };

  const attestation = (overrides: Partial<AttestationFact> = {}): AttestationFact => ({
    claimType: "AUTHENTICATION",
    result: "CONFIRMED",
    status: "ACTIVE",
    method: "IN_PERSON",
    verifierId: "v-1",
    verifierStatus: "APPROVED",
    expiresAt: null,
    ...overrides,
  });

  const fullEvidence = [
    { type: "PHOTO", reviewStatus: "ACCEPTED" },
    { type: "PHOTO", reviewStatus: "PENDING" },
    { type: "PHOTO", reviewStatus: "ACCEPTED" },
    { type: "RECEIPT", reviewStatus: "ACCEPTED" },
  ] as const;

  const complete = [attestation({ claimType: "SERIAL_NUMBER" }), attestation()];

  it("is satisfied when every required claim and evidence item is present", () => {
    expect(
      evaluateTemplate(requirements, { attestations: complete, evidence: fullEvidence, at: NOW }),
    ).toEqual({
      satisfied: true,
      missingClaims: [],
      contradictedClaims: [],
      missingEvidence: [],
      missingEvidenceCount: 0,
    });
  });

  it.each([
    ["revoked", attestation({ status: "REVOKED" })],
    ["expired status", attestation({ status: "EXPIRED" })],
    ["disputed", attestation({ status: "DISPUTED" })],
    ["past its expiry date", attestation({ expiresAt: new Date("2026-08-31T00:00:00.000Z") })],
    ["expiring exactly now", attestation({ expiresAt: NOW })],
    ["from a suspended verifier", attestation({ verifierStatus: "SUSPENDED" })],
    ["using a method the template does not allow", attestation({ method: "REMOTE" })],
    ["inconclusive", attestation({ result: "INCONCLUSIVE" })],
  ])("does not count an attestation that is %s", (_label, authentication) => {
    const result = evaluateTemplate(requirements, {
      attestations: [attestation({ claimType: "SERIAL_NUMBER" }), authentication],
      evidence: fullEvidence,
      at: NOW,
    });
    expect(result.satisfied).toBe(false);
    expect(result.missingClaims).toEqual(["AUTHENTICATION"]);
  });

  it("counts an attestation that has not yet expired", () => {
    const result = evaluateTemplate(requirements, {
      attestations: [
        attestation({ claimType: "SERIAL_NUMBER" }),
        attestation({ expiresAt: new Date("2027-01-01T00:00:00.000Z") }),
      ],
      evidence: fullEvidence,
      at: NOW,
    });
    expect(result.satisfied).toBe(true);
  });

  it("requires distinct verifiers per claim when minVerifiers > 1", () => {
    const strict = { ...requirements, minVerifiers: 2 };
    const sameVerifierTwice = [
      ...complete,
      attestation({ claimType: "SERIAL_NUMBER" }),
      attestation(),
    ];
    expect(
      evaluateTemplate(strict, { attestations: sameVerifierTwice, evidence: fullEvidence, at: NOW })
        .missingClaims,
    ).toEqual(["SERIAL_NUMBER", "AUTHENTICATION"]);

    const secondVerifierOnOneClaim = [...complete, attestation({ verifierId: "v-2" })];
    expect(
      evaluateTemplate(strict, {
        attestations: secondVerifierOnOneClaim,
        evidence: fullEvidence,
        at: NOW,
      }).missingClaims,
    ).toEqual(["SERIAL_NUMBER"]);
  });

  it("is blocked by a current contradiction even when the claim is also confirmed", () => {
    const result = evaluateTemplate(requirements, {
      attestations: [...complete, attestation({ verifierId: "v-2", result: "CONTRADICTED" })],
      evidence: fullEvidence,
      at: NOW,
    });
    expect(result.satisfied).toBe(false);
    expect(result.missingClaims).toEqual([]);
    expect(result.contradictedClaims).toEqual(["AUTHENTICATION"]);
  });

  it("ignores a contradiction that has been revoked", () => {
    const result = evaluateTemplate(requirements, {
      attestations: [
        ...complete,
        attestation({ verifierId: "v-2", result: "CONTRADICTED", status: "REVOKED" }),
      ],
      evidence: fullEvidence,
      at: NOW,
    });
    expect(result.satisfied).toBe(true);
  });

  it("counts missing evidence, ignoring rejected items", () => {
    const result = evaluateTemplate(requirements, {
      attestations: complete,
      evidence: [
        { type: "PHOTO", reviewStatus: "ACCEPTED" },
        { type: "PHOTO", reviewStatus: "REJECTED" },
        { type: "RECEIPT", reviewStatus: "REJECTED" },
      ],
      at: NOW,
    });
    expect(result.satisfied).toBe(false);
    expect(result.missingEvidence).toEqual([
      { type: "PHOTO", missing: 2 },
      { type: "RECEIPT", missing: 1 },
    ]);
    expect(result.missingEvidenceCount).toBe(3);
  });
});
