import { CLAIM_TYPES } from "@worthybound/shared";
import { describe, expect, it } from "vitest";
import {
  computeTrust,
  DEFAULT_WEIGHTS,
  ENGINE_VERSION,
  type Proof,
  type TrustInputs,
  TrustInputError,
  type TrustTemplate,
} from "../src/index.js";

const NOW = "2026-09-01T00:00:00.000Z";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

let seq = 0;
function proof(overrides: Partial<Proof> & Pick<Proof, "type" | "source">): Proof {
  seq += 1;
  return {
    id: `p-${String(seq).padStart(4, "0")}`,
    sourceId: overrides.source === "OWNER" ? "owner-1" : `${overrides.source.toLowerCase()}-1`,
    issuedAt: daysAgo(10),
    status: "ACTIVE",
    ...overrides,
  };
}

function inputs(overrides: Partial<TrustInputs> = {}): TrustInputs {
  return {
    assetId: "WB-7F93A281",
    category: "EQUIPMENT",
    status: "ACTIVE",
    owner: { walletVerified: true, identityVerified: true },
    currentCustodySince: daysAgo(400),
    custodyContinuous: true,
    proofs: [],
    openDisputes: 0,
    evaluatedAt: NOW,
    ...overrides,
  };
}

const ownerPhotos = (n: number) =>
  Array.from({ length: n }, () => proof({ type: "PHOTO", source: "OWNER" }));

const TEMPLATE = {
  requiredClaims: ["AUTHENTICATION", "CONDITION"],
  allowedMethods: ["IN_PERSON", "REMOTE", "LABORATORY", "DOCUMENT_REVIEW"],
} as const satisfies TrustTemplate;

/** A verifier's signed, confirmed attestations of every claim `TEMPLATE` requires. */
const review = (sourceId: string, method: NonNullable<Proof["method"]>) =>
  TEMPLATE.requiredClaims.map((type) =>
    proof({ type, source: "VERIFIER", sourceId, result: "CONFIRMED", method }),
  );

describe("computeTrust: output contract", () => {
  it("returns score, factors, deductions, versions, hash and timestamp", () => {
    const result = computeTrust(inputs());
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.weightsVersion).toBe(DEFAULT_WEIGHTS.version);
    expect(result.computedAt).toBe(NOW);
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(result.factors)).toBe(true);
    expect(Array.isArray(result.deductions)).toBe(true);
  });

  it("gives an asset without proofs only identity and custody points", () => {
    const result = computeTrust(inputs());
    expect(result.verificationLevel).toBe("UNVERIFIED");
    expect(result.score).toBe(2 + 8 + 5);
    expect(result.factors.map((f) => f.code)).toEqual([
      "OWNER_WALLET_VERIFIED",
      "OWNER_IDENTITY_VERIFIED",
      "CUSTODY_CONTINUITY",
    ]);
  });

  it("always yields an integer score within 0-100", () => {
    const heavy = inputs({
      category: "LUXURY_WATCH",
      proofs: [
        ...ownerPhotos(20),
        ...["v-a", "v-b", "v-c", "v-d"].flatMap((sourceId) => [
          proof({ type: "INSPECTION", source: "VERIFIER", sourceId }),
          ...review(sourceId, "IN_PERSON"),
        ]),
        proof({ type: "AUTHENTICATION", source: "MANUFACTURER" }),
        proof({ type: "PROVENANCE", source: "THIRD_PARTY" }),
      ],
      templates: [TEMPLATE],
    });
    const worst = inputs({
      owner: { walletVerified: false, identityVerified: false },
      custodyContinuous: false,
      openDisputes: 5,
      missingRequiredEvidence: 10,
    });
    for (const result of [computeTrust(heavy), computeTrust(worst)]) {
      expect(Number.isInteger(result.score)).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
    expect(computeTrust(heavy).score).toBe(100);
    expect(computeTrust(worst).score).toBe(0);
  });
});

describe("computeTrust: strength of proofs, not number of proofs", () => {
  it("scores an honest, inspected asset above a heavily self-documented fake", () => {
    const honest = computeTrust(
      inputs({
        proofs: [
          proof({ type: "RECEIPT", source: "OWNER" }),
          ...ownerPhotos(3),
          proof({ type: "INSPECTION", source: "VERIFIER" }),
        ],
      }),
    );
    const scammer = computeTrust(
      inputs({
        proofs: [
          ...ownerPhotos(50),
          proof({ type: "RECEIPT", source: "OWNER" }),
          proof({ type: "CERTIFICATE", source: "OWNER" }),
          proof({ type: "PROVENANCE", source: "OWNER" }),
        ],
      }),
    );

    expect(honest.score).toBeGreaterThan(scammer.score);
    expect(honest.score).toBeGreaterThanOrEqual(60);
    expect(honest.verificationLevel).toBe("INSPECTED");
    expect(scammer.score).toBeLessThanOrEqual(DEFAULT_WEIGHTS.caps.selfDocumentedIdentityVerified);
    expect(scammer.verificationLevel).toBe("SELF_DOCUMENTED");
  });

  it("gives diminishing returns for repeated proofs of the same kind", () => {
    const result = computeTrust(inputs({ proofs: ownerPhotos(50) }));
    const photoPoints = result.factors
      .filter((f) => f.code === "PROOF_PHOTO")
      .reduce((acc, f) => acc + f.points, 0);
    expect(photoPoints).toBeLessThan(2 * DEFAULT_WEIGHTS.typePoints.PHOTO);
  });

  it("limits the total contribution of owner-submitted proofs to the source ceiling", () => {
    const result = computeTrust(
      inputs({
        proofs: (
          ["RECEIPT", "CERTIFICATE", "PROVENANCE", "SERIAL_NUMBER", "POSSESSION"] as const
        ).flatMap((type) => [proof({ type, source: "OWNER" }), proof({ type, source: "OWNER" })]),
      }),
    );
    const ownerPoints = result.factors
      .filter((f) => f.detail?.source === "OWNER")
      .reduce((acc, f) => acc + f.points, 0);
    expect(ownerPoints).toBeCloseTo(DEFAULT_WEIGHTS.sourceCeiling.OWNER, 1);
    expect(result.factors.some((f) => f.detail?.ceilingFactor !== undefined)).toBe(true);
  });

  it("weights the same proof type higher from an independent source", () => {
    const own = computeTrust(inputs({ proofs: [proof({ type: "CERTIFICATE", source: "OWNER" })] }));
    const maker = computeTrust(
      inputs({ proofs: [proof({ type: "CERTIFICATE", source: "MANUFACTURER" })] }),
    );
    const points = (r: ReturnType<typeof computeTrust>) =>
      r.factors.find((f) => f.code === "PROOF_CERTIFICATE")?.points ?? 0;
    expect(points(maker)).toBeGreaterThan(points(own));
  });

  it("counts two independent verifiers higher than the same verifier twice", () => {
    const sameVerifier = computeTrust(
      inputs({
        proofs: [...review("v-a", "IN_PERSON"), ...review("v-a", "IN_PERSON")],
        templates: [TEMPLATE],
      }),
    );
    const twoVerifiers = computeTrust(
      inputs({
        proofs: [...review("v-a", "IN_PERSON"), ...review("v-b", "IN_PERSON")],
        templates: [TEMPLATE],
      }),
    );
    expect(twoVerifiers.score).toBeGreaterThan(sameVerifier.score);
    expect(twoVerifiers.factors.map((f) => f.code)).toContain("MULTIPLE_INDEPENDENT_VERIFIERS");
    expect(twoVerifiers.verificationLevel).toBe("MULTI_VERIFIED");
  });

  it("reduces the weight of old inspections", () => {
    const at = (days: number) =>
      computeTrust(
        inputs({
          proofs: [proof({ type: "INSPECTION", source: "VERIFIER", issuedAt: daysAgo(days) })],
        }),
      ).factors.find((f) => f.code === "PROOF_INSPECTION")?.points ?? 0;
    expect(at(10)).toBeGreaterThan(at(730));
    expect(at(730)).toBeCloseTo(at(0) / 2, 0);
  });

  it("does not decay receipts over time", () => {
    const at = (days: number) =>
      computeTrust(
        inputs({ proofs: [proof({ type: "RECEIPT", source: "OWNER", issuedAt: daysAgo(days) })] }),
      ).factors.find((f) => f.code === "PROOF_RECEIPT")?.points;
    expect(at(3650)).toBe(at(1));
  });
});

describe("computeTrust: trust must be earned (tier caps)", () => {
  it("caps self-documented assets lower when the owner is not identity-verified", () => {
    const proofs = [
      ...ownerPhotos(5),
      proof({ type: "RECEIPT", source: "OWNER" }),
      proof({ type: "CERTIFICATE", source: "OWNER" }),
      proof({ type: "PROVENANCE", source: "OWNER" }),
      proof({ type: "SERIAL_NUMBER", source: "OWNER" }),
      proof({ type: "PROVENANCE", source: "THIRD_PARTY" }),
    ];
    const anonymous = computeTrust(
      inputs({ owner: { walletVerified: true, identityVerified: false }, proofs }),
    );
    const kyc = computeTrust(inputs({ proofs }));
    expect(anonymous.score).toBe(DEFAULT_WEIGHTS.caps.selfDocumented);
    expect(anonymous.capsApplied.map((c) => c.code)).toEqual(["SELF_DOCUMENTED"]);
    expect(kyc.score).toBe(DEFAULT_WEIGHTS.caps.selfDocumentedIdentityVerified);
  });

  it("does not treat existence, presenter, documentation or ownership claims as an inspection", () => {
    const result = computeTrust(
      inputs({
        proofs: [
          "PHYSICAL_EXISTENCE",
          "IDENTITY_OF_PRESENTER",
          "DOCUMENTATION",
          "OWNERSHIP_CLAIM",
        ].map((type) =>
          proof({ type: type as Proof["type"], source: "VERIFIER", sourceId: "v-a" }),
        ),
      }),
    );
    expect(result.verificationLevel).toBe("SELF_DOCUMENTED");
    expect(result.score).toBeLessThanOrEqual(DEFAULT_WEIGHTS.caps.withoutReview);
  });

  it("assigns a weight and freshness rule to every claim type", () => {
    for (const type of CLAIM_TYPES) {
      expect(DEFAULT_WEIGHTS.typePoints[type], type).toBeGreaterThan(0);
      expect(DEFAULT_WEIGHTS.freshness[type], type).toBeDefined();
    }
  });

  it("requires a review of the required claims to exceed 60", () => {
    const result = computeTrust(
      inputs({
        proofs: [
          proof({ type: "RECEIPT", source: "OWNER" }),
          proof({ type: "PROVENANCE", source: "OWNER" }),
          proof({ type: "SERIAL_NUMBER", source: "OWNER" }),
          proof({ type: "APPRAISAL", source: "VERIFIER", sourceId: "v-a" }),
          proof({ type: "INSPECTION", source: "VERIFIER", sourceId: "v-a" }),
          proof({ type: "CERTIFICATE", source: "MANUFACTURER" }),
        ],
        templates: [TEMPLATE],
      }),
    );
    expect(result.score).toBe(DEFAULT_WEIGHTS.caps.withoutReview);
    expect(result.capsApplied.map((c) => c.code)).toEqual(["WITHOUT_REVIEW"]);
    expect(result.verificationLevel).toBe("INSPECTED");
  });
});

describe("computeTrust: verification route ceilings", () => {
  const base = () => [
    ...ownerPhotos(3),
    proof({ type: "RECEIPT", source: "OWNER" }),
    proof({ type: "CERTIFICATE", source: "OWNER" }),
    proof({ type: "PROVENANCE", source: "OWNER" }),
    proof({ type: "SERIAL_NUMBER", source: "OWNER" }),
    proof({ type: "PHOTO", source: "AUTOMATED" }),
    proof({ type: "RECEIPT", source: "AUTOMATED" }),
    proof({ type: "CERTIFICATE", source: "AUTOMATED" }),
  ];
  const score = (proofs: Proof[], overrides: Partial<TrustInputs> = {}) =>
    computeTrust(inputs({ proofs: [...base(), ...proofs], templates: [TEMPLATE], ...overrides }));

  it.each([
    ["one online review", [["v-a", "REMOTE"]], 75, "ONE_ONLINE_REVIEW"],
    [
      "two online reviews",
      [
        ["v-a", "REMOTE"],
        ["v-b", "REMOTE"],
      ],
      80,
      "TWO_ONLINE_REVIEWS",
    ],
    ["one in-person inspection", [["v-a", "IN_PERSON"]], 85, "ONE_IN_PERSON_INSPECTION"],
    [
      "an online review and an in-person inspection",
      [
        ["v-a", "REMOTE"],
        ["v-b", "IN_PERSON"],
      ],
      90,
      "ONLINE_REVIEW_AND_IN_PERSON_INSPECTION",
    ],
  ] as const)("caps %s", (_label, reviews, limit, code) => {
    const result = score(reviews.flatMap(([id, method]) => review(id, method)));
    expect(result.score).toBe(limit);
    expect(result.capsApplied).toEqual([{ code, limit }]);
    expect(result.verificationLevel).not.toBe("MULTI_VERIFIED");
  });

  it("allows 100 and MULTI_VERIFIED only with two independent in-person inspections", () => {
    const two = score([...review("v-a", "IN_PERSON"), ...review("v-b", "IN_PERSON")]);
    expect(two.score).toBe(100);
    expect(two.capsApplied).toEqual([]);
    expect(two.verificationLevel).toBe("MULTI_VERIFIED");

    const threeOnline = score(["v-a", "v-b", "v-c"].flatMap((id) => review(id, "REMOTE")));
    expect(threeOnline.score).toBe(DEFAULT_WEIGHTS.caps.twoOnlineReviews);
    expect(threeOnline.verificationLevel).toBe("AUTHENTICATED");

    const sameVerifier = score([...review("v-a", "IN_PERSON"), ...review("v-a", "IN_PERSON")]);
    expect(sameVerifier.score).toBe(DEFAULT_WEIGHTS.caps.oneInPersonInspection);
  });

  it("is a ceiling: deductions still lower the score below it", () => {
    const result = score(review("v-a", "IN_PERSON"), { openDisputes: 1 });
    expect(result.score).toBe(
      DEFAULT_WEIGHTS.caps.oneInPersonInspection - DEFAULT_WEIGHTS.deductions.openDispute.points,
    );
  });

  it("counts a review with any claim examined online as online", () => {
    const [authentication, condition] = review("v-a", "IN_PERSON");
    const result = score([authentication!, { ...condition!, method: "REMOTE" }]);
    expect(result.capsApplied.map((c) => c.code)).toEqual(["ONE_ONLINE_REVIEW"]);
    expect(score(review("v-a", "DOCUMENT_REVIEW")).capsApplied.map((c) => c.code)).toEqual([
      "ONE_ONLINE_REVIEW",
    ]);
    expect(score(review("v-a", "LABORATORY")).capsApplied.map((c) => c.code)).toEqual([
      "ONE_IN_PERSON_INSPECTION",
    ]);
  });

  it("counts only confirmed, signed reports covering every required claim", () => {
    const [authentication, condition] = review("v-a", "IN_PERSON");
    const cases: Proof[][] = [
      [authentication!],
      [authentication!, (({ method: _method, ...unsigned }) => unsigned)(condition!)],
      [authentication!, { ...condition!, result: "CONTRADICTED" }],
      [authentication!, { ...condition!, status: "REVOKED" }],
      [authentication!, { ...condition!, expiresAt: daysAgo(1) }],
      review("v-b", "IN_PERSON").map((p) => ({ ...p, sourceStatus: "SUSPENDED" as const })),
      review("v-c", "IN_PERSON").map((p) => ({ ...p, source: "MANUFACTURER" as const })),
    ];
    for (const proofs of cases) {
      const result = score(proofs);
      expect(result.capsApplied.map((c) => c.code)).toEqual(["AUTOMATED_CHECKS_PASSED"]);
    }
    expect(score(review("v-a", "IN_PERSON"), { templates: [] }).score).toBe(
      DEFAULT_WEIGHTS.caps.automatedChecksPassed,
    );
  });

  it("uses each template's required claims and allowed methods", () => {
    const inPersonOnly: TrustTemplate = { ...TEMPLATE, allowedMethods: ["IN_PERSON"] };
    expect(score(review("v-a", "REMOTE"), { templates: [inPersonOnly] }).score).toBe(
      DEFAULT_WEIGHTS.caps.automatedChecksPassed,
    );
    const authenticationOnly: TrustTemplate = {
      requiredClaims: ["AUTHENTICATION"],
      allowedMethods: ["REMOTE"],
    };
    const result = score(review("v-a", "REMOTE").slice(0, 1), {
      templates: [inPersonOnly, authenticationOnly],
    });
    expect(result.capsApplied.map((c) => c.code)).toEqual(["ONE_ONLINE_REVIEW"]);
  });
});

describe("computeTrust: automated checks (ADR 0013)", () => {
  const ownerFiles = () => [
    ...ownerPhotos(3),
    proof({ type: "RECEIPT", source: "OWNER" }),
    proof({ type: "CERTIFICATE", source: "OWNER" }),
    proof({ type: "PROVENANCE", source: "OWNER" }),
    proof({ type: "SERIAL_NUMBER", source: "OWNER" }),
  ];
  const passedChecks = () => [
    proof({ type: "PHOTO", source: "AUTOMATED" }),
    proof({ type: "RECEIPT", source: "AUTOMATED" }),
    proof({ type: "CERTIFICATE", source: "AUTOMATED" }),
  ];

  it("lets owner uploads that passed the checks reach 65 without a verifier", () => {
    const without = computeTrust(inputs({ proofs: ownerFiles() }));
    const checked = computeTrust(inputs({ proofs: [...ownerFiles(), ...passedChecks()] }));
    expect(without.score).toBe(DEFAULT_WEIGHTS.caps.selfDocumentedIdentityVerified);
    expect(checked.score).toBe(DEFAULT_WEIGHTS.caps.automatedChecksPassed);
    const automated = checked.factors.filter((f) => f.detail?.source === "AUTOMATED");
    expect(automated.reduce((acc, f) => acc + f.points, 0)).toBeCloseTo(
      DEFAULT_WEIGHTS.sourceCeiling.AUTOMATED,
    );
    expect(checked.verificationLevel).toBe("SELF_DOCUMENTED");

    const many = computeTrust(
      inputs({
        proofs: [
          ...ownerFiles(),
          ...passedChecks(),
          ...Array.from({ length: 20 }, () => proof({ type: "PHOTO", source: "AUTOMATED" })),
        ],
      }),
    );
    expect(many.score).toBe(DEFAULT_WEIGHTS.caps.automatedChecksPassed);
  });

  it("counts checked photos from a completed guided capture 1.5 times", () => {
    const checks = (captured: boolean) =>
      Array.from({ length: 4 }, () => proof({ type: "PHOTO", source: "AUTOMATED", captured }));
    const uploaded = computeTrust(inputs({ proofs: checks(false) }));
    const captured = computeTrust(inputs({ proofs: checks(true) }));
    const points = (r: typeof uploaded) =>
      r.factors.filter((f) => f.detail?.source === "AUTOMATED").reduce((a, f) => a + f.points, 0);
    expect(points(captured)).toBeCloseTo(points(uploaded) * DEFAULT_WEIGHTS.capturedMultiplier, 1);
    expect(captured.factors.find((f) => f.detail?.source === "AUTOMATED")?.detail).toMatchObject({
      capturedMultiplier: DEFAULT_WEIGHTS.capturedMultiplier,
    });
    expect(uploaded.factors.some((f) => f.detail?.capturedMultiplier !== undefined)).toBe(false);
    expect(captured.score).toBeGreaterThan(uploaded.score);
    expect(captured.inputsHash).not.toBe(uploaded.inputsHash);
  });

  it("scores owners without KYC lower, and keeps the owner-only cap when a check failed", () => {
    const anonymous = computeTrust(
      inputs({
        owner: { walletVerified: true, identityVerified: false },
        proofs: [...ownerFiles(), ...passedChecks()],
      }),
    );
    expect(anonymous.score).toBeGreaterThan(DEFAULT_WEIGHTS.caps.selfDocumentedIdentityVerified);
    expect(anonymous.score).toBeLessThan(DEFAULT_WEIGHTS.caps.automatedChecksPassed);

    const failed = computeTrust(
      inputs({ proofs: [...ownerFiles(), ...passedChecks()], failedAutomatedChecks: 1 }),
    );
    expect(failed.capsApplied.map((c) => c.code)).toEqual(["SELF_DOCUMENTED_IDENTITY_VERIFIED"]);
    expect(failed.deductions).toContainEqual({
      code: "FAILED_AUTOMATED_CHECKS",
      points: DEFAULT_WEIGHTS.deductions.failedAutomatedCheck.points,
      count: 1,
    });
    expect(failed.score).toBe(
      DEFAULT_WEIGHTS.caps.selfDocumentedIdentityVerified -
        DEFAULT_WEIGHTS.deductions.failedAutomatedCheck.points,
    );
    const many = computeTrust(inputs({ proofs: ownerFiles(), failedAutomatedChecks: 9 }));
    expect(many.deductions.find((d) => d.code === "FAILED_AUTOMATED_CHECKS")?.points).toBe(
      DEFAULT_WEIGHTS.deductions.failedAutomatedCheck.max,
    );
  });

  it("raises the no-inspection cap to 65, and never counts as an independent inspection", () => {
    const proofs = [
      ...ownerFiles(),
      ...passedChecks(),
      proof({ type: "SERIAL_NUMBER", source: "VERIFIER", sourceId: "v-a" }),
      proof({ type: "APPRAISAL", source: "VERIFIER", sourceId: "v-a" }),
      proof({ type: "CERTIFICATE", source: "MANUFACTURER" }),
    ];
    const result = computeTrust(inputs({ proofs }));
    expect(result.score).toBe(DEFAULT_WEIGHTS.caps.automatedChecksPassed);
    expect(result.capsApplied.map((c) => c.code)).toEqual(["AUTOMATED_CHECKS_PASSED"]);
    expect(result.verificationLevel).toBe("SELF_DOCUMENTED");

    const inspection = computeTrust(
      inputs({ proofs: [proof({ type: "INSPECTION", source: "AUTOMATED" })] }),
    );
    expect(inspection.verificationLevel).toBe("SELF_DOCUMENTED");
  });
});

describe("computeTrust: asset status", () => {
  const strong = () => [
    proof({ type: "RECEIPT", source: "OWNER" }),
    proof({ type: "INSPECTION", source: "VERIFIER" }),
    proof({ type: "AUTHENTICATION", source: "VERIFIER" }),
    proof({ type: "PROVENANCE", source: "THIRD_PARTY" }),
  ];

  it.each([
    ["REPORTED_STOLEN", 10],
    ["REPORTED_LOST", 25],
    ["DISPUTED", 40],
    ["REVOKED", 0],
  ] as const)("caps the score of a %s asset at %i", (status, cap) => {
    const result = computeTrust(inputs({ status, proofs: strong() }));
    expect(result.score).toBe(cap);
    expect(result.capsApplied.at(-1)).toEqual({ code: `STATUS_${status}`, limit: cap });
  });

  it("does not cap a VERIFIED asset", () => {
    const result = computeTrust(
      inputs({
        status: "VERIFIED",
        proofs: [...strong(), ...review("v-a", "IN_PERSON")],
        templates: [TEMPLATE],
      }),
    );
    expect(result.score).toBe(DEFAULT_WEIGHTS.caps.oneInPersonInspection);
  });
});

describe("computeTrust: deductions", () => {
  const inspected = () => [
    proof({ type: "RECEIPT", source: "OWNER" }),
    proof({ type: "INSPECTION", source: "VERIFIER", sourceId: "v-a" }),
  ];

  it("deducts for open disputes, bounded by the maximum", () => {
    const base = computeTrust(inputs({ proofs: inspected() })).score;
    const one = computeTrust(inputs({ proofs: inspected(), openDisputes: 1 }));
    const many = computeTrust(inputs({ proofs: inspected(), openDisputes: 10 }));
    expect(one.score).toBe(base - 15);
    expect(many.deductions.find((d) => d.code === "OPEN_DISPUTES")).toMatchObject({
      points: 30,
      count: 10,
    });
  });

  it("excludes and deducts for contradicted claims", () => {
    const contradicted = proof({
      type: "INSPECTION",
      source: "VERIFIER",
      sourceId: "v-b",
      result: "CONTRADICTED",
    });
    const result = computeTrust(inputs({ proofs: [...inspected(), contradicted] }));
    expect(result.excludedProofs).toContainEqual({
      proofId: contradicted.id,
      reason: "CONTRADICTED",
    });
    expect(result.deductions.find((d) => d.code === "CONTRADICTED_CLAIMS")).toMatchObject({
      points: 20,
      proofIds: [contradicted.id],
    });
  });

  it("excludes and deducts for revoked attestations while keeping them in the output", () => {
    const revoked = proof({ type: "AUTHENTICATION", source: "VERIFIER", status: "REVOKED" });
    const result = computeTrust(inputs({ proofs: [...inspected(), revoked] }));
    expect(result.excludedProofs).toContainEqual({ proofId: revoked.id, reason: "REVOKED" });
    expect(result.deductions.map((d) => d.code)).toContain("REVOKED_PROOFS");
    expect(result.verificationLevel).toBe("INSPECTED");
  });

  it("re-weights proofs from a suspended verifier and ignores them for tier caps", () => {
    const suspended = computeTrust(
      inputs({
        proofs: [
          proof({ type: "RECEIPT", source: "OWNER" }),
          proof({ type: "INSPECTION", source: "VERIFIER", sourceStatus: "SUSPENDED" }),
        ],
      }),
    );
    const factor = suspended.factors.find((f) => f.code === "PROOF_INSPECTION");
    expect(factor?.detail?.suspendedMultiplier).toBe(DEFAULT_WEIGHTS.suspendedSourceMultiplier);
    expect(suspended.deductions.map((d) => d.code)).toContain("SUSPENDED_SOURCE");
    expect(suspended.verificationLevel).toBe("SELF_DOCUMENTED");
    expect(suspended.score).toBeLessThanOrEqual(
      DEFAULT_WEIGHTS.caps.selfDocumentedIdentityVerified,
    );
  });

  it("excludes proofs from revoked verifiers", () => {
    const p = proof({ type: "INSPECTION", source: "VERIFIER", sourceStatus: "REVOKED" });
    const result = computeTrust(inputs({ proofs: [p] }));
    expect(result.excludedProofs).toEqual([{ proofId: p.id, reason: "SOURCE_REVOKED" }]);
  });

  it("excludes expired verification and deducts for stale verification", () => {
    const expired = proof({
      type: "INSPECTION",
      source: "VERIFIER",
      issuedAt: daysAgo(800),
      expiresAt: daysAgo(70),
    });
    const result = computeTrust(inputs({ proofs: [expired] }));
    expect(result.excludedProofs).toEqual([{ proofId: expired.id, reason: "EXPIRED" }]);
    expect(result.deductions.map((d) => d.code)).toContain("STALE_VERIFICATION");
    expect(result.verificationLevel).toBe("UNVERIFIED");
  });

  it("deducts for broken custody instead of awarding continuity", () => {
    const result = computeTrust(inputs({ custodyContinuous: false }));
    expect(result.factors.map((f) => f.code)).not.toContain("CUSTODY_CONTINUITY");
    expect(result.deductions.map((d) => d.code)).toContain("BROKEN_CUSTODY");
  });

  it("deducts for missing template-required evidence", () => {
    const result = computeTrust(inputs({ proofs: inspected(), missingRequiredEvidence: 2 }));
    expect(result.deductions.find((d) => d.code === "MISSING_REQUIRED_EVIDENCE")?.points).toBe(6);
  });
});

describe("computeTrust: custody and transfer", () => {
  it("stops counting possession and condition claims from before the current custody period", () => {
    const oldPossession = proof({ type: "POSSESSION", source: "VERIFIER", issuedAt: daysAgo(30) });
    const oldCondition = proof({ type: "CONDITION", source: "VERIFIER", issuedAt: daysAgo(30) });
    const receipt = proof({ type: "RECEIPT", source: "OWNER", issuedAt: daysAgo(30) });
    const result = computeTrust(
      inputs({ currentCustodySince: daysAgo(5), proofs: [oldPossession, oldCondition, receipt] }),
    );
    expect(result.excludedProofs).toEqual([
      { proofId: oldPossession.id, reason: "PREDATES_CURRENT_CUSTODY" },
      { proofId: oldCondition.id, reason: "PREDATES_CURRENT_CUSTODY" },
    ]);
    expect(result.factors.map((f) => f.proofId)).toContain(receipt.id);
  });

  it("stops counting presenter identity and ownership claims from before the current custody period", () => {
    const oldPresenter = proof({
      type: "IDENTITY_OF_PRESENTER",
      source: "VERIFIER",
      issuedAt: daysAgo(30),
    });
    const oldOwnership = proof({
      type: "OWNERSHIP_CLAIM",
      source: "VERIFIER",
      issuedAt: daysAgo(30),
    });
    const existence = proof({
      type: "PHYSICAL_EXISTENCE",
      source: "VERIFIER",
      issuedAt: daysAgo(30),
    });
    const result = computeTrust(
      inputs({ currentCustodySince: daysAgo(5), proofs: [oldPresenter, oldOwnership, existence] }),
    );
    expect(result.excludedProofs).toEqual([
      { proofId: oldPresenter.id, reason: "PREDATES_CURRENT_CUSTODY" },
      { proofId: oldOwnership.id, reason: "PREDATES_CURRENT_CUSTODY" },
    ]);
    expect(result.factors.map((f) => f.proofId)).toContain(existence.id);
  });

  it("ignores proofs issued after the evaluation time", () => {
    const future = proof({
      type: "INSPECTION",
      source: "VERIFIER",
      issuedAt: "2027-01-01T00:00:00Z",
    });
    const result = computeTrust(inputs({ proofs: [future] }));
    expect(result.excludedProofs).toEqual([
      { proofId: future.id, reason: "ISSUED_AFTER_EVALUATION" },
    ]);
  });
});

describe("computeTrust: reproducibility", () => {
  const proofs = [
    proof({ type: "RECEIPT", source: "OWNER" }),
    ...ownerPhotos(4),
    proof({ type: "INSPECTION", source: "VERIFIER", sourceId: "v-a" }),
    proof({ type: "AUTHENTICATION", source: "VERIFIER", sourceId: "v-b" }),
  ];

  it("returns an identical result regardless of proof order", () => {
    const a = computeTrust(inputs({ proofs }));
    const b = computeTrust(inputs({ proofs: [...proofs].reverse() }));
    expect(b).toEqual(a);
  });

  it("changes the inputs hash when inputs or weights change", () => {
    const a = computeTrust(inputs({ proofs }));
    const b = computeTrust(inputs({ proofs, openDisputes: 1 }));
    const c = computeTrust(inputs({ proofs }), {
      ...DEFAULT_WEIGHTS,
      version: "test-weights",
      repeatDecay: 0.4,
    });
    expect(new Set([a.inputsHash, b.inputsHash, c.inputsHash]).size).toBe(3);
    expect(c.weightsVersion).toBe("test-weights");
  });

  it("does not mutate its inputs", () => {
    const input = inputs({ proofs: [...proofs] });
    const snapshot = structuredClone(input);
    computeTrust(input);
    expect(input).toEqual(snapshot);
  });
});

describe("computeTrust: input validation", () => {
  it.each([
    ["an invalid evaluatedAt", inputs({ evaluatedAt: "yesterday" })],
    ["an invalid currentCustodySince", inputs({ currentCustodySince: "" })],
    ["a negative dispute count", inputs({ openDisputes: -1 })],
    ["a fractional missing-evidence count", inputs({ missingRequiredEvidence: 1.5 })],
    ["a negative failed-check count", inputs({ failedAutomatedChecks: -1 })],
    [
      "an invalid proof timestamp",
      inputs({ proofs: [proof({ type: "PHOTO", source: "OWNER", issuedAt: "not-a-date" })] }),
    ],
    [
      "duplicate proof ids",
      inputs({
        proofs: [
          proof({ id: "dup", type: "PHOTO", source: "OWNER" }),
          proof({ id: "dup", type: "RECEIPT", source: "OWNER" }),
        ],
      }),
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => computeTrust(input)).toThrow(TrustInputError);
  });
});
