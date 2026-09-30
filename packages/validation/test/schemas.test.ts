import { randomUUID } from "node:crypto";
import type { TemplateRequirements } from "@worthybound/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  assetConditionRequestSchema,
  assetConditionUpdateSchema,
  assetParamsSchema,
  assetStatusChangeSchema,
  assetStatusRequestSchema,
  attestationDraftSchema,
  attestationRevokeSchema,
  attestationSubmissionSchema,
  authNonceRequestSchema,
  authVerifyRequestSchema,
  automatedCheckListQuerySchema,
  automatedChecksConsentSchema,
  categoryPermissionChangeSchema,
  EVIDENCE_MAX_BYTES,
  evidenceParamsSchema,
  evidenceReviewSchema,
  evidenceUploadParamsSchema,
  evidenceUploadSchema,
  evidenceVisibilitySchema,
  idempotencyKeySchema,
  openDisputeSchema,
  registerAssetSchema,
  resolveDisputeSchema,
  roleAssignmentParamsSchema,
  roleGrantSchema,
  roleListQuerySchema,
  templateCreateSchema,
  templateRequirementsSchema,
  templateVersionStatusSchema,
  ownerConfirmationSchema,
  purchaseCheckPhotoParamsSchema,
  transferParamsSchema,
  transferRequestSchema,
  transferSignatureSchema,
  updateDraftAssetSchema,
  verificationRequestSchema,
  verifierApplicationSchema,
  verifierCategoryParamsSchema,
  verifierCategoryRequestSchema,
  verifierListQuerySchema,
  verifierParamsSchema,
  verifierEvidenceUploadSchema,
  verifierRequestListQuerySchema,
  verifierStatusChangeSchema,
} from "../src/index.js";

const SHA = "a".repeat(64);
const UUID = "0199d2a0-0000-7000-8000-000000000001";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SIGNATURE = "5".repeat(88);

function issues(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => [i.code, ...i.path].join(":"));
}

describe("registerAssetSchema", () => {
  const valid = {
    category: "LUXURY_WATCH",
    brand: "  Rolex ",
    model: "Submariner",
    serialNumber: "X123",
    attributes: { year: 2019, dial: "black", boxAndPapers: true },
  };

  it("accepts a valid registration and trims text", () => {
    const parsed = registerAssetSchema.parse(valid);
    expect(parsed.brand).toBe("Rolex");
  });

  it.each([
    "wbId",
    "status",
    "ownerId",
    "currentTrustScore",
    "verificationLevel",
    "chainAssetAddress",
  ])("rejects the backend-controlled field %s", (field) => {
    expect(issues(registerAssetSchema, { ...valid, [field]: "x" })).toEqual(["unrecognized_keys"]);
  });

  it("rejects unknown categories and empty text", () => {
    expect(issues(registerAssetSchema, { ...valid, category: "SPACESHIP" })).toEqual([
      "invalid_value:category",
    ]);
    expect(issues(registerAssetSchema, { ...valid, brand: "   " })).toEqual(["too_small:brand"]);
  });

  it("limits attributes to flat scalar values", () => {
    expect(issues(registerAssetSchema, { ...valid, attributes: { nested: { a: 1 } } })).not.toEqual(
      [],
    );
    expect(
      issues(registerAssetSchema, { ...valid, attributes: { n: Number.POSITIVE_INFINITY } }),
    ).not.toEqual([]);
    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]));
    expect(issues(registerAssetSchema, { ...valid, attributes: tooMany })).toEqual([
      "custom:attributes",
    ]);
  });

  it("requires at least one field for draft updates", () => {
    expect(issues(updateDraftAssetSchema, {})).toEqual(["custom"]);
    expect(updateDraftAssetSchema.parse({ model: "GMT" })).toEqual({ model: "GMT" });
  });

  it("accepts an owner-stated condition and rejects unknown grades", () => {
    expect(registerAssetSchema.parse({ ...valid, condition: "VERY_GOOD" }).condition).toBe(
      "VERY_GOOD",
    );
    expect(issues(registerAssetSchema, { ...valid, condition: "MINT" })).toEqual([
      "invalid_value:condition",
    ]);
    expect(updateDraftAssetSchema.parse({ condition: "FAIR" })).toEqual({ condition: "FAIR" });
  });

  it("validates condition updates on published assets", () => {
    expect(assetConditionUpdateSchema.parse({ assetId: "wb-7f93a281", condition: "POOR" })).toEqual(
      {
        assetId: "WB-7F93A281",
        condition: "POOR",
      },
    );
    expect(issues(assetConditionUpdateSchema, { assetId: "WB-7F93A281" })).toEqual([
      "invalid_value:condition",
    ]);
  });

  it("normalizes the asset ID in status changes", () => {
    expect(
      assetStatusChangeSchema.parse({ assetId: "wb-7f93a281", toStatus: "REPORTED_STOLEN" })
        .assetId,
    ).toBe("WB-7F93A281");
    expect(issues(assetStatusChangeSchema, { assetId: "WB-1", toStatus: "ACTIVE" })).toEqual([
      "invalid_format:assetId",
    ]);
  });
});

describe("evidenceUploadSchema", () => {
  const valid = { type: "RECEIPT", sha256: SHA, mimeType: "application/pdf", sizeBytes: 120_000 };

  it("defaults visibility to PRIVATE and parses capture time", () => {
    const parsed = evidenceUploadSchema.parse({
      ...valid,
      capturedAt: "2026-01-01T10:00:00+01:00",
    });
    expect(parsed.visibility).toBe("PRIVATE");
    expect(parsed.capturedAt?.toISOString()).toBe("2026-01-01T09:00:00.000Z");
  });

  it("rejects backend-controlled fields", () => {
    for (const field of ["storageKey", "uploaderId", "source", "reviewStatus"]) {
      expect(issues(evidenceUploadSchema, { ...valid, [field]: "x" }), field).toEqual([
        "unrecognized_keys",
      ]);
    }
  });

  it.each([
    ["upper-case hash", { sha256: "A".repeat(64) }, "invalid_format:sha256"],
    ["short hash", { sha256: "a".repeat(63) }, "invalid_format:sha256"],
    ["unsupported file type", { mimeType: "application/x-msdownload" }, "invalid_value:mimeType"],
    ["empty file", { sizeBytes: 0 }, "too_small:sizeBytes"],
    ["fractional size", { sizeBytes: 1.5 }, "invalid_type:sizeBytes"],
    ["oversized PDF", { sizeBytes: EVIDENCE_MAX_BYTES["application/pdf"] + 1 }, "custom:sizeBytes"],
    ["path in file name", { originalFilename: "../../etc/passwd" }, "custom:originalFilename"],
    [
      "control character in file name",
      { originalFilename: "a\u0000.pdf" },
      "custom:originalFilename",
    ],
    [
      "timestamp without offset",
      { capturedAt: "2026-01-01T10:00:00" },
      "invalid_format:capturedAt",
    ],
  ])("rejects %s", (_label, change, issue) => {
    expect(issues(evidenceUploadSchema, { ...valid, ...change })).toEqual([issue]);
  });

  it("allows large videos", () => {
    expect(
      evidenceUploadSchema.safeParse({
        ...valid,
        type: "VIDEO",
        mimeType: "video/mp4",
        sizeBytes: 400 * 1024 * 1024,
      }).success,
    ).toBe(true);
  });

  it("accepts capture shots only as photos, or the video shot as a video, with both fields and no client time", () => {
    const shot = {
      ...valid,
      type: "PHOTO",
      mimeType: "image/jpeg",
      captureSessionId: "0199a000-0000-7000-8000-000000000c01",
      captureShot: "DIAL",
    };
    expect(issues(evidenceUploadSchema, shot)).toEqual([]);
    expect(issues(evidenceUploadSchema, { ...shot, captureShot: "SELFIE" })).toEqual([
      "invalid_value:captureShot",
    ]);
    expect(issues(evidenceUploadSchema, { ...shot, captureShot: undefined })).toEqual([
      "custom:captureShot",
    ]);
    expect(issues(evidenceUploadSchema, { ...shot, type: "RECEIPT" })).toEqual([
      "custom:captureShot",
    ]);
    expect(issues(evidenceUploadSchema, { ...shot, mimeType: "image/heic" })).toEqual([
      "custom:captureShot",
    ]);
    expect(issues(evidenceUploadSchema, { ...shot, capturedAt: "2026-01-01T10:00:00Z" })).toEqual([
      "custom:captureShot",
    ]);
    const video = { ...shot, type: "VIDEO", mimeType: "video/mp4", captureShot: "VIDEO" };
    expect(issues(evidenceUploadSchema, video)).toEqual([]);
    expect(issues(evidenceUploadSchema, { ...video, mimeType: "video/quicktime" })).toEqual([]);
    expect(issues(evidenceUploadSchema, { ...video, captureShot: "DIAL" })).toEqual([
      "custom:captureShot",
    ]);
    expect(issues(evidenceUploadSchema, { ...shot, captureShot: "VIDEO" })).toEqual([
      "custom:captureShot",
    ]);
  });

  it("allows only JPEG, PNG and WebP photos to be public", () => {
    const photo = { ...valid, type: "PHOTO", mimeType: "image/jpeg", visibility: "PUBLIC" };
    expect(issues(evidenceUploadSchema, photo)).toEqual([]);
    expect(issues(evidenceUploadSchema, { ...photo, mimeType: "image/heic" })).toEqual([
      "custom:visibility",
    ]);
    expect(issues(evidenceUploadSchema, { ...photo, type: "RECEIPT" })).toEqual([
      "custom:visibility",
    ]);
    expect(issues(evidenceUploadSchema, { ...valid, visibility: "PUBLIC" })).toEqual([
      "custom:visibility",
    ]);
  });

  it("accepts the evidence types from the master plan", () => {
    for (const type of ["SERVICE_RECORD", "OWNERSHIP_DOCUMENT", "MANUFACTURER_DOCUMENT", "VIDEO"]) {
      expect(issues(evidenceUploadSchema, { ...valid, type }), type).toEqual([]);
    }
  });
});

describe("evidence request schemas", () => {
  it("accepts only a visibility change", () => {
    expect(issues(evidenceVisibilitySchema, { visibility: "PUBLIC" })).toEqual([]);
    expect(issues(evidenceVisibilitySchema, { visibility: "PUBLIC", sha256: SHA })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it("accepts only a yes or no for AI checks", () => {
    expect(issues(automatedChecksConsentSchema, { enabled: true })).toEqual([]);
    expect(issues(automatedChecksConsentSchema, { enabled: "true" })).toEqual([
      "invalid_type:enabled",
    ]);
    expect(issues(automatedChecksConsentSchema, { enabled: false, at: "now" })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it("filters the admin list of AI checks by result", () => {
    expect(automatedCheckListQuerySchema.parse({ result: "FAILED" })).toEqual({
      result: "FAILED",
      limit: 20,
    });
    expect(issues(automatedCheckListQuerySchema, { result: "UNKNOWN" })).toEqual([
      "invalid_value:result",
    ]);
    expect(issues(automatedCheckListQuerySchema, { limit: "500" })).toEqual(["too_big:limit"]);
  });

  it("validates evidence and upload IDs", () => {
    expect(issues(evidenceParamsSchema, { wbId: "WB-7F93A281", evidenceId: UUID })).toEqual([]);
    expect(issues(evidenceParamsSchema, { wbId: "WB-7F93A281", evidenceId: "../x" })).toEqual([
      "invalid_format:evidenceId",
    ]);
    expect(issues(evidenceUploadParamsSchema, { uploadId: "1" })).toEqual([
      "invalid_format:uploadId",
    ]);
  });
});

describe("verifierApplicationSchema", () => {
  it("accepts an individual without a business name", () => {
    expect(
      verifierApplicationSchema.safeParse({
        entityType: "INDIVIDUAL",
        categories: ["LUXURY_WATCH"],
      }).success,
    ).toBe(true);
  });

  it("requires a business name for organizations", () => {
    expect(
      issues(verifierApplicationSchema, { entityType: "LABORATORY", categories: ["FINE_ART"] }),
    ).toEqual(["custom:businessName"]);
  });

  it("requires at least one unique category and an https website", () => {
    const base = { entityType: "INDIVIDUAL" };
    expect(issues(verifierApplicationSchema, { ...base, categories: [] })).toEqual([
      "too_small:categories",
    ]);
    expect(
      issues(verifierApplicationSchema, { ...base, categories: ["JEWELRY", "JEWELRY"] }),
    ).toEqual(["custom:categories"]);
    expect(
      issues(verifierApplicationSchema, {
        ...base,
        categories: ["JEWELRY"],
        website: "http://example.com",
      }),
    ).toEqual(["custom:website"]);
  });
});

describe("verifier review schemas", () => {
  it.each(["REJECTED", "SUSPENDED", "REVOKED"])(
    "requires a reason to set a verifier %s",
    (status) => {
      expect(issues(verifierStatusChangeSchema, { status })).toEqual(["custom:reason"]);
      expect(issues(verifierStatusChangeSchema, { status, reason: "   " })).toContain(
        "too_small:reason",
      );
      expect(
        issues(verifierStatusChangeSchema, { status, reason: "Credentials not verifiable" }),
      ).toEqual([]);
    },
  );

  it("does not require a reason to start a review or approve", () => {
    expect(issues(verifierStatusChangeSchema, { status: "UNDER_REVIEW" })).toEqual([]);
    expect(issues(verifierStatusChangeSchema, { status: "APPROVED" })).toEqual([]);
  });

  it("requires a reason to suspend or revoke a category, not to approve it", () => {
    expect(issues(categoryPermissionChangeSchema, { status: "SUSPENDED" })).toEqual([
      "custom:reason",
    ]);
    expect(issues(categoryPermissionChangeSchema, { status: "REVOKED" })).toEqual([
      "custom:reason",
    ]);
    expect(issues(categoryPermissionChangeSchema, { status: "APPROVED" })).toEqual([]);
  });

  it.each(["approvedById", "verifierId", "actorId", "approvedAt"])(
    "rejects the backend-controlled field %s",
    (field) => {
      expect(issues(verifierStatusChangeSchema, { status: "APPROVED", [field]: UUID })).toEqual([
        "unrecognized_keys",
      ]);
      expect(issues(categoryPermissionChangeSchema, { status: "APPROVED", [field]: UUID })).toEqual(
        ["unrecognized_keys"],
      );
    },
  );

  it("requests at least one new, unique category", () => {
    expect(issues(verifierCategoryRequestSchema, { categories: ["FINE_ART"] })).toEqual([]);
    expect(issues(verifierCategoryRequestSchema, { categories: [] })).toEqual([
      "too_small:categories",
    ]);
    expect(issues(verifierCategoryRequestSchema, { categories: ["FINE_ART", "FINE_ART"] })).toEqual(
      ["custom:categories"],
    );
  });

  it("validates verifier IDs, categories and the review queue query", () => {
    expect(issues(verifierParamsSchema, { verifierId: UUID })).toEqual([]);
    expect(issues(verifierParamsSchema, { verifierId: "1" })).toEqual([
      "invalid_format:verifierId",
    ]);
    expect(
      issues(verifierCategoryParamsSchema, { verifierId: UUID, category: "SPACESHIP" }),
    ).toEqual(["invalid_value:category"]);
    expect(verifierListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(verifierListQuerySchema.parse({ status: "APPLIED", limit: "5" })).toEqual({
      status: "APPLIED",
      limit: 5,
    });
    expect(issues(verifierListQuerySchema, { limit: "101" })).toEqual(["too_big:limit"]);
  });
});

describe("role schemas", () => {
  it("grants only roles managed through the API", () => {
    expect(issues(roleGrantSchema, { walletAddress: WALLET, role: "VERIFIER_REVIEWER" })).toEqual(
      [],
    );
    for (const role of ["ADMIN", "VERIFIER", "USER"]) {
      expect(issues(roleGrantSchema, { walletAddress: WALLET, role })).toEqual([
        "invalid_value:role",
      ]);
      expect(issues(roleListQuerySchema, { role })).toEqual(["invalid_value:role"]);
    }
  });

  it("rejects malformed wallets, unknown fields and assignment IDs", () => {
    expect(issues(roleGrantSchema, { walletAddress: "0xabc", role: "VERIFIER_REVIEWER" })).toEqual([
      "invalid_format:walletAddress",
    ]);
    expect(
      issues(roleGrantSchema, {
        walletAddress: WALLET,
        role: "VERIFIER_REVIEWER",
        grantedById: UUID,
      }),
    ).toEqual(["unrecognized_keys"]);
    expect(issues(roleAssignmentParamsSchema, { assignmentId: "x" })).toEqual([
      "invalid_format:assignmentId",
    ]);
  });
});

describe("templateRequirementsSchema", () => {
  const valid = {
    requiredClaims: ["SERIAL_NUMBER", "AUTHENTICATION"],
    requiredEvidence: [{ type: "PHOTO", minCount: 3 }],
    allowedMethods: ["IN_PERSON"],
    minVerifiers: 1,
  };

  it("produces the shared TemplateRequirements type", () => {
    const requirements: TemplateRequirements = templateRequirementsSchema.parse(valid);
    expect(requirements.requiredClaims).toEqual(["SERIAL_NUMBER", "AUTHENTICATION"]);
  });

  it("defaults attestation validity to five years", () => {
    expect(templateRequirementsSchema.parse(valid).validityMonths).toBe(60);
    expect(templateRequirementsSchema.parse({ ...valid, validityMonths: 12 }).validityMonths).toBe(
      12,
    );
  });

  it.each([
    ["no claims", { requiredClaims: [] }, "too_small:requiredClaims"],
    ["duplicate claims", { requiredClaims: ["POSSESSION", "POSSESSION"] }, "custom:requiredClaims"],
    [
      "duplicate evidence types",
      {
        requiredEvidence: [
          { type: "PHOTO", minCount: 1 },
          { type: "PHOTO", minCount: 2 },
        ],
      },
      "custom:requiredEvidence",
    ],
    ["no methods", { allowedMethods: [] }, "too_small:allowedMethods"],
    ["zero verifiers", { minVerifiers: 0 }, "too_small:minVerifiers"],
    ["too many verifiers", { minVerifiers: 6 }, "too_big:minVerifiers"],
    ["zero validity", { validityMonths: 0 }, "too_small:validityMonths"],
    ["validity over ten years", { validityMonths: 121 }, "too_big:validityMonths"],
    ["fractional validity", { validityMonths: 1.5 }, "invalid_type:validityMonths"],
  ])("rejects %s", (_label, change, issue) => {
    expect(issues(templateRequirementsSchema, { ...valid, ...change })).toEqual([issue]);
  });
});

describe("attestationSubmissionSchema", () => {
  const valid = {
    claimType: "AUTHENTICATION",
    result: "CONFIRMED",
    method: "IN_PERSON",
    assuranceLevel: "HIGH",
    issuedAt: "2026-03-01T00:00:00Z",
    expiresAt: "2031-03-01T00:00:00Z",
    evidence: [{ evidenceId: UUID, sha256: SHA }],
    nonce: "f".repeat(32),
    signature: SIGNATURE,
  };

  it("accepts a valid submission", () => {
    const parsed = attestationSubmissionSchema.parse(valid);
    expect(parsed.issuedAt).toBeInstanceOf(Date);
  });

  it("accepts condition claims with a grade, or inconclusive ones without", () => {
    const condition = { ...valid, claimType: "CONDITION" };
    expect(
      attestationSubmissionSchema.parse({ ...condition, conditionGrade: "FOR_PARTS" })
        .conditionGrade,
    ).toBe("FOR_PARTS");
    expect(
      attestationSubmissionSchema.safeParse({ ...condition, result: "INCONCLUSIVE" }).success,
    ).toBe(true);
  });

  it("takes the claim without a signature when preparing the message to sign", () => {
    const draft: Partial<typeof valid> = { ...valid };
    delete draft.signature;
    expect(attestationDraftSchema.safeParse(draft).success).toBe(true);
    expect(issues(attestationDraftSchema, valid)).toEqual(["unrecognized_keys"]);
    expect(issues(attestationDraftSchema, { ...draft, claimType: "CONDITION" })).toEqual([
      "custom:conditionGrade",
    ]);
  });

  it.each([
    "verifierId",
    "status",
    "chainAttestationAddress",
    "trustScore",
    "verified",
    "assetId",
    "templateVersionId",
    "verificationRequestId",
    "signedMessage",
  ])("rejects the backend-controlled field %s", (field) => {
    expect(issues(attestationSubmissionSchema, { ...valid, [field]: "x" })).toEqual([
      "unrecognized_keys",
    ]);
  });

  it.each([
    ["an expiry before issuance", { expiresAt: "2026-02-01T00:00:00Z" }, "custom:expiresAt"],
    ["an unknown claim type", { claimType: "VERIFIED" }, "invalid_value:claimType"],
    ["duplicate evidence", { evidence: [valid.evidence[0], valid.evidence[0]] }, "custom:evidence"],
    ["a short nonce", { nonce: "f".repeat(16) }, "invalid_format:nonce"],
    ["a malformed signature", { signature: "0".repeat(88) }, "invalid_format:signature"],
    [
      "a condition grade on a non-condition claim",
      { conditionGrade: "GOOD" },
      "custom:conditionGrade",
    ],
    [
      "a confirmed condition claim without a grade",
      { claimType: "CONDITION" },
      "custom:conditionGrade",
    ],
    [
      "an unknown condition grade",
      { claimType: "CONDITION", conditionGrade: "MINT" },
      "invalid_value:conditionGrade",
    ],
  ])("rejects %s", (_label, change, issue) => {
    expect(issues(attestationSubmissionSchema, { ...valid, ...change })).toEqual([issue]);
  });
});

describe("requests, transfers and disputes", () => {
  it("validates verification requests; the asset comes from the path", () => {
    expect(verificationRequestSchema.safeParse({ templateVersionId: UUID }).success).toBe(true);
    expect(issues(verificationRequestSchema, { templateVersionId: "1" })).toEqual([
      "invalid_format:templateVersionId",
    ]);
    expect(
      issues(verificationRequestSchema, { templateVersionId: UUID, assetId: "WB-7F93A281" }),
    ).toEqual(["unrecognized_keys"]);
  });

  it("validates transfers and defaults the expiry", () => {
    expect(
      transferRequestSchema.parse({ assetId: "WB-7F93A281", toWalletAddress: WALLET })
        .expiresInHours,
    ).toBe(72);
    expect(
      issues(transferRequestSchema, { assetId: "WB-7F93A281", toWalletAddress: "0xabc" }),
    ).toEqual(["invalid_format:toWalletAddress"]);
    expect(
      issues(transferRequestSchema, {
        assetId: "WB-7F93A281",
        toWalletAddress: WALLET,
        expiresInHours: 1000,
      }),
    ).toEqual(["too_big:expiresInHours"]);
    const base = { assetId: "WB-7F93A281", toWalletAddress: WALLET };
    expect(transferRequestSchema.parse(base).priceLamports).toBe("0");
    expect(
      transferRequestSchema.parse({ ...base, priceLamports: "1500000000" }).priceLamports,
    ).toBe("1500000000");
    for (const priceLamports of ["-1", "1.5", "01", "1000000000000000000", ""]) {
      expect(issues(transferRequestSchema, { ...base, priceLamports }), priceLamports).toEqual([
        "invalid_format:priceLamports",
      ]);
    }
    expect(transferSignatureSchema.safeParse({ signedTransaction: "AQID" }).success).toBe(true);
    const signature = "5".repeat(88);
    expect(ownerConfirmationSchema.parse({ code: " k7p 2qx ", signature }).code).toBe("K7P2QX");
    expect(issues(ownerConfirmationSchema, { code: "K7P2Q0", signature })).toEqual([
      "invalid_format:code",
    ]);
    expect(issues(ownerConfirmationSchema, { code: "K7P2QX", signature: "0x" })).toEqual([
      "invalid_format:signature",
    ]);
    expect(purchaseCheckPhotoParamsSchema.safeParse({ checkId: UUID, shot: "DIAL" }).success).toBe(
      true,
    );
    expect(issues(purchaseCheckPhotoParamsSchema, { checkId: UUID, shot: "SELFIE" })).toEqual([
      "invalid_value:shot",
    ]);
    expect(issues(transferSignatureSchema, { signedTransaction: "not base64!" })).toEqual([
      "invalid_format:signedTransaction",
    ]);
    expect(issues(transferParamsSchema, { transferId: "1" })).toEqual([
      "invalid_format:transferId",
    ]);
  });

  it("lets a dispute target an attestation or evidence, not both", () => {
    const base = { assetId: "WB-7F93A281", reason: "Serial does not match" };
    expect(openDisputeSchema.safeParse({ ...base, attestationId: UUID }).success).toBe(true);
    expect(issues(openDisputeSchema, { ...base, attestationId: UUID, evidenceId: UUID })).toEqual([
      "custom:evidenceId",
    ]);
  });

  it("only resolves disputes as upheld or rejected, with a written resolution", () => {
    expect(issues(resolveDisputeSchema, { outcome: "WITHDRAWN", resolution: "x" })).toEqual([
      "invalid_value:outcome",
    ]);
    expect(issues(resolveDisputeSchema, { outcome: "UPHELD", resolution: " " })).toEqual([
      "too_small:resolution",
    ]);
  });
});

describe("wallet sign-in", () => {
  const verify = { address: WALLET, message: "bG9jYWxob3N0", signature: "A".repeat(86) + "==" };

  it("accepts a nonce request and a verify request", () => {
    expect(authNonceRequestSchema.parse({ address: WALLET })).toEqual({ address: WALLET });
    expect(authVerifyRequestSchema.parse(verify)).toEqual(verify);
  });

  it.each([
    ["a non-base58 address", { address: "0OIl" + WALLET.slice(4) }, "invalid_format:address"],
    ["a non-base64 message", { message: "not base64!" }, "invalid_format:message"],
    ["an oversized signature", { signature: "A".repeat(89) }, "too_big:signature"],
    ["an extra field", { userId: UUID }, "unrecognized_keys"],
  ])("rejects %s", (_name, override, issue) => {
    expect(issues(authVerifyRequestSchema, { ...verify, ...override })).toEqual([issue]);
  });
});

describe("asset endpoint inputs", () => {
  it("accepts idempotency keys such as UUIDs and rejects others", () => {
    expect(idempotencyKeySchema.safeParse(randomUUID()).success).toBe(true);
    for (const key of ["short", "has space in it", "x".repeat(129), "semi;colon12"]) {
      expect(idempotencyKeySchema.safeParse(key).success, key).toBe(false);
    }
  });

  it("normalizes the asset ID in paths", () => {
    expect(assetParamsSchema.parse({ wbId: " wb-7f93a281 " })).toEqual({ wbId: "WB-7F93A281" });
    expect(assetParamsSchema.safeParse({ wbId: "../etc" }).success).toBe(false);
  });

  it("rejects extra fields in status and condition bodies", () => {
    expect(assetStatusRequestSchema.safeParse({ toStatus: "REPORTED_LOST" }).success).toBe(true);
    expect(
      assetStatusRequestSchema.safeParse({ toStatus: "REPORTED_LOST", actor: "ADMIN" }).success,
    ).toBe(false);
    expect(assetConditionRequestSchema.safeParse({ condition: "GOOD" }).success).toBe(true);
    expect(
      assetConditionRequestSchema.safeParse({ condition: "GOOD", assetId: "WB-7F93A281" }).success,
    ).toBe(false);
  });
});

describe("verification templates", () => {
  it("accepts a template with a readable code", () => {
    expect(
      templateCreateSchema.safeParse({
        code: "luxury-watch-standard",
        category: "LUXURY_WATCH",
        name: "Luxury watch — standard",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an upper-case code", { code: "Watch" }, "invalid_format:code"],
    ["a short code", { code: "ab" }, "invalid_format:code"],
    ["an unknown category", { category: "CARS" }, "invalid_value:category"],
    ["a status", { status: "PUBLISHED" }, "unrecognized_keys"],
  ])("rejects %s", (_label, change, issue) => {
    const valid = { code: "watch-basic", category: "LUXURY_WATCH", name: "Basic" };
    expect(issues(templateCreateSchema, { ...valid, ...change })).toEqual([issue]);
  });

  it("only publishes or retires versions", () => {
    expect(templateVersionStatusSchema.safeParse({ status: "PUBLISHED" }).success).toBe(true);
    expect(issues(templateVersionStatusSchema, { status: "DRAFT" })).toEqual([
      "invalid_value:status",
    ]);
  });
});

describe("verifier work", () => {
  it("defaults the request list to the open queue", () => {
    expect(verifierRequestListQuerySchema.parse({})).toEqual({ scope: "open", limit: 20 });
    expect(issues(verifierRequestListQuerySchema, { scope: "all" })).toEqual([
      "invalid_value:scope",
    ]);
  });

  it("requires a reason to reject evidence and never sets it back to pending", () => {
    expect(evidenceReviewSchema.safeParse({ status: "ACCEPTED" }).success).toBe(true);
    expect(issues(evidenceReviewSchema, { status: "REJECTED" })).toEqual(["custom:reason"]);
    expect(issues(evidenceReviewSchema, { status: "PENDING" })).toEqual(["invalid_value:status"]);
  });

  it("requires a reason to revoke an attestation", () => {
    expect(issues(attestationRevokeSchema, {})).toEqual(["invalid_type:reason"]);
  });

  it("keeps verifier evidence private and limits its types", () => {
    const valid = {
      type: "INSPECTION_REPORT",
      sha256: SHA,
      mimeType: "application/pdf",
      sizeBytes: 10,
    };
    expect(verifierEvidenceUploadSchema.safeParse(valid).success).toBe(true);
    expect(issues(verifierEvidenceUploadSchema, { ...valid, visibility: "PUBLIC" })).toEqual([
      "unrecognized_keys",
    ]);
    expect(issues(verifierEvidenceUploadSchema, { ...valid, type: "RECEIPT" })).toEqual([
      "invalid_value:type",
    ]);
  });
});
