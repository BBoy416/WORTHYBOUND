import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ATTESTATION_STATEMENT,
  type AttestationAuthorityContext,
  attestationAuthorityViolations,
  attestationExpiryLimit,
  type AttestationFact,
  attestationMessage,
  type AttestationMessageFields,
  evaluateTemplate,
  requestAssignmentViolations,
  sha256Text,
  type TemplateRequirements,
  VERIFIER_EVIDENCE_TYPES,
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

describe("requestAssignmentViolations", () => {
  it("allows an approved, permitted, independent verifier", () => {
    expect(requestAssignmentViolations(authority())).toEqual([]);
  });

  it("reports every reason a verifier may not take the request", () => {
    const ctx = authority({
      verifier: {
        status: "SUSPENDED",
        identityStatus: "EXPIRED",
        approvedCategories: [],
        userId: "owner-user",
      },
      asset: { status: "REPORTED_STOLEN" },
    });
    expect(requestAssignmentViolations(ctx)).toEqual([
      "VERIFIER_NOT_APPROVED",
      "VERIFIER_IDENTITY_NOT_VERIFIED",
      "NO_CATEGORY_PERMISSION",
      "OWN_ASSET",
      "ASSET_NOT_ATTESTABLE",
    ]);
  });

  it("ignores the template, which the request already fixes", () => {
    expect(
      requestAssignmentViolations(authority({ template: { status: "DRAFT" }, method: "REMOTE" })),
    ).toEqual([]);
  });
});

describe("VERIFIER_EVIDENCE_TYPES", () => {
  it("leaves the owner's history documents to the owner", () => {
    for (const type of ["RECEIPT", "OWNERSHIP_DOCUMENT", "MANUFACTURER_DOCUMENT"]) {
      expect(VERIFIER_EVIDENCE_TYPES).not.toContain(type);
    }
    expect(VERIFIER_EVIDENCE_TYPES).toContain("INSPECTION_REPORT");
  });
});

describe("attestationExpiryLimit", () => {
  it.each([
    ["2026-09-29T10:15:30.123Z", 60, "2031-09-29T10:15:30.123Z"],
    ["2026-01-31T23:59:59.999Z", 1, "2026-02-28T23:59:59.999Z"],
    ["2028-01-31T00:00:00.000Z", 1, "2028-02-29T00:00:00.000Z"],
    ["2028-02-29T12:00:00.000Z", 12, "2029-02-28T12:00:00.000Z"],
    ["2026-11-30T08:00:00.000Z", 3, "2027-02-28T08:00:00.000Z"],
    ["2026-12-15T08:00:00.000Z", 120, "2036-12-15T08:00:00.000Z"],
  ])("from %s plus %i months is %s", (issuedAt, months, expected) => {
    expect(attestationExpiryLimit(new Date(issuedAt), months).toISOString()).toBe(expected);
  });
});

describe("attestationMessage", () => {
  const fields: AttestationMessageFields = {
    domain: "worthybound.test",
    chainId: "solana:devnet",
    verifierAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    wbId: "WB-7F93A281",
    category: "LUXURY_WATCH",
    templateVersionId: "0199d2a0-0000-7000-8000-000000000001",
    verificationRequestId: "0199d2a0-0000-7000-8000-000000000002",
    claimType: "CONDITION",
    result: "CONFIRMED",
    conditionGrade: "VERY_GOOD",
    method: "IN_PERSON",
    assuranceLevel: "HIGH",
    issuedAt: new Date("2026-09-01T10:00:00.000Z"),
    expiresAt: null,
    supersedesId: null,
    notesSha256: null,
    evidence: [
      { evidenceId: "0199d2a0-0000-7000-8000-00000000000b", sha256: "b".repeat(64) },
      { evidenceId: "0199d2a0-0000-7000-8000-00000000000a", sha256: "a".repeat(64) },
    ],
    nonce: "f".repeat(32),
  };

  it("lists every signed field on its own line, evidence sorted by ID", () => {
    expect(attestationMessage(fields).split("\n")).toEqual([
      "WorthyBound attestation (wb-attestation-v1)",
      ATTESTATION_STATEMENT,
      "",
      "Domain: worthybound.test",
      "Chain ID: solana:devnet",
      "Verifier: 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "Asset: WB-7F93A281",
      "Category: LUXURY_WATCH",
      "Template version: 0199d2a0-0000-7000-8000-000000000001",
      "Verification request: 0199d2a0-0000-7000-8000-000000000002",
      "Claim: CONDITION",
      "Result: CONFIRMED",
      "Condition grade: VERY_GOOD",
      "Method: IN_PERSON",
      "Assurance: HIGH",
      "Issued at: 2026-09-01T10:00:00.000Z",
      "Expires at: none",
      "Supersedes: none",
      "Notes SHA-256: none",
      "Evidence count: 2",
      `Evidence: 0199d2a0-0000-7000-8000-00000000000a ${"a".repeat(64)}`,
      `Evidence: 0199d2a0-0000-7000-8000-00000000000b ${"b".repeat(64)}`,
      `Nonce: ${"f".repeat(32)}`,
    ]);
  });

  it("gives the same text regardless of evidence order", () => {
    expect(attestationMessage({ ...fields, evidence: [...fields.evidence].reverse() })).toBe(
      attestationMessage(fields),
    );
  });

  it.each<[string, Partial<AttestationMessageFields>]>([
    ["domain", { domain: "evil.example" }],
    ["chain", { chainId: "solana:mainnet" }],
    ["verifier", { verifierAddress: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" }],
    ["asset", { wbId: "WB-00000000" }],
    ["category", { category: "JEWELRY" }],
    ["template version", { templateVersionId: "0199d2a0-0000-7000-8000-000000000009" }],
    ["request", { verificationRequestId: "0199d2a0-0000-7000-8000-000000000009" }],
    ["claim", { claimType: "AUTHENTICATION", conditionGrade: null }],
    ["result", { result: "CONTRADICTED" }],
    ["condition grade", { conditionGrade: "FAIR" }],
    ["method", { method: "REMOTE" }],
    ["assurance", { assuranceLevel: "LOW" }],
    ["issue time", { issuedAt: new Date("2026-09-01T10:00:00.001Z") }],
    ["expiry", { expiresAt: new Date("2031-09-01T00:00:00.000Z") }],
    ["superseded attestation", { supersedesId: "0199d2a0-0000-7000-8000-000000000009" }],
    ["notes", { notesSha256: "c".repeat(64) }],
    ["evidence hash", { evidence: [{ ...fields.evidence[0]!, sha256: "c".repeat(64) }] }],
    ["nonce", { nonce: "e".repeat(32) }],
  ])("changes when the %s changes", (_label, change) => {
    expect(attestationMessage({ ...fields, ...change })).not.toBe(attestationMessage(fields));
  });

  it("refuses values that would add lines", () => {
    expect(() => attestationMessage({ ...fields, domain: "a\nClaim: AUTHENTICATION" })).toThrow(
      /line breaks/,
    );
  });

  it("hashes notes as UTF-8", async () => {
    const notes = "Movement serviced in 2024 — crown replaced";
    expect(await sha256Text(notes)).toBe(createHash("sha256").update(notes, "utf8").digest("hex"));
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
