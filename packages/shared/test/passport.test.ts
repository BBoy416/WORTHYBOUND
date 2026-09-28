import { describe, expect, it } from "vitest";
import {
  ASSET_STATUSES,
  isPassportPublic,
  type PassportSource,
  passportPath,
  passportUrl,
  toPublicPassport,
  TRUST_SCORE_DISCLAIMER,
} from "../src/index.js";

const SECRET = "PRIVATE-SENTINEL";
const d = (iso: string) => new Date(iso);
const hash = (c: string) => c.repeat(64);

/** A source built like a database row: private fields sit next to the public ones. */
function source(overrides: Partial<PassportSource> = {}): PassportSource {
  const asset = {
    wbId: "WB-7F93A281",
    category: "LUXURY_WATCH",
    brand: "Rolex",
    model: "Submariner",
    publicDescription: "Stainless steel diver's watch",
    status: "VERIFIED",
    tokenizationStatus: "TOKENIZED",
    chainAssetAddress: "AssetAddr1111111111111111111111111111111111",
    verificationLevel: "AUTHENTICATED",
    id: `${SECRET}-asset-uuid`,
    ownerId: `${SECRET}-owner`,
    serialNumber: `${SECRET}-serial`,
    serialFingerprint: `${SECRET}-fingerprint`,
    description: `${SECRET}-private-description`,
    attributes: { purchasePrice: `${SECRET}-price` },
    currentTrustScore: 71,
  } as const;
  const privateEvidence = {
    id: `${SECRET}-evidence-private`,
    type: "RECEIPT",
    visibility: "PRIVATE",
    reviewStatus: "ACCEPTED",
    sha256: hash("a"),
    mimeType: "application/pdf",
    capturedAt: null,
    createdAt: d("2026-01-02T00:00:00Z"),
    storageKey: `${SECRET}/receipt.pdf`,
    originalFilename: `${SECRET}-receipt.pdf`,
    uploaderId: `${SECRET}-uploader`,
    description: `${SECRET}-evidence-description`,
  } as const;
  const publicPhoto = {
    id: "ev-photo",
    type: "PHOTO",
    visibility: "PUBLIC",
    reviewStatus: "ACCEPTED",
    sha256: hash("b"),
    mimeType: "image/jpeg",
    capturedAt: d("2026-01-01T12:00:00Z"),
    createdAt: d("2026-01-03T00:00:00Z"),
    storageKey: `${SECRET}/photo.jpg`,
  } as const;
  const rejectedPublic = {
    ...publicPhoto,
    id: `${SECRET}-evidence-rejected`,
    reviewStatus: "REJECTED",
  } as const;
  const verifier = {
    id: "verifier-1",
    publicName: "Geneva Watch Lab",
    entityType: "LABORATORY",
    status: "APPROVED",
    userId: `${SECRET}-verifier-user`,
  } as const;
  const attestation = {
    id: "att-1",
    claimType: "AUTHENTICATION",
    result: "CONFIRMED",
    method: "IN_PERSON",
    assuranceLevel: "HIGH",
    status: "ACTIVE",
    issuedAt: d("2026-03-01T00:00:00Z"),
    expiresAt: d("2031-03-01T00:00:00Z"),
    signedPayloadHash: hash("c"),
    signature: "sig-1",
    chainAttestationAddress: null,
    verifier,
    notes: `${SECRET}-notes`,
    nonce: `${SECRET}-nonce`,
  } as const;
  const revoked = {
    ...attestation,
    id: "att-0",
    status: "REVOKED",
    issuedAt: d("2026-04-01T00:00:00Z"),
  } as const;
  const provenance = [
    {
      sequence: 2,
      type: "EVIDENCE_ADDED",
      occurredAt: d("2026-01-02T00:00:00Z"),
      hash: hash("f"),
      prevHash: hash("e"),
      actorId: `${SECRET}-actor`,
      payload: { serial: `${SECRET}-payload` },
    },
    {
      sequence: 1,
      type: "REGISTERED",
      occurredAt: d("2026-01-01T00:00:00Z"),
      hash: hash("e"),
      prevHash: null,
    },
  ] as const;
  const chainTransactions = [
    {
      kind: "MINT_ASSET",
      cluster: "DEVNET",
      status: "FINALIZED",
      signature: "chain-sig-1",
      confirmedAt: d("2026-01-05T00:00:00Z"),
      lastError: `${SECRET}-rpc-error`,
    },
    {
      kind: "SUBMIT_ATTESTATION",
      cluster: "DEVNET",
      status: "FAILED",
      signature: `${SECRET}-failed-sig`,
      confirmedAt: null,
    },
    {
      kind: "COMMIT_TRUST_SCORE",
      cluster: "DEVNET",
      status: "PENDING",
      signature: null,
      confirmedAt: null,
    },
  ] as const;
  return {
    asset,
    trust: {
      score: 71,
      computedAt: d("2026-04-02T00:00:00Z"),
      engineVersion: "1.1.0",
      weightsVersion: "weights-2026.2",
    },
    custody: { currentSince: d("2025-12-01T00:00:00Z"), transferCount: 0 },
    evidence: [privateEvidence, publicPhoto, rejectedPublic],
    evidenceCommitments: [
      { merkleRoot: hash("d"), evidenceCount: 3, createdAt: d("2026-01-04T00:00:00Z") },
    ],
    attestations: [attestation, revoked],
    provenance,
    chainTransactions,
    ...overrides,
  };
}

describe("toPublicPassport", () => {
  it("never exposes private fields", () => {
    const passport = toPublicPassport(source());
    expect(passport).not.toBeNull();
    expect(JSON.stringify(passport)).not.toContain(SECRET);
  });

  it("shows only public, non-rejected evidence, without storage keys", () => {
    expect(toPublicPassport(source())?.publicEvidence).toEqual([
      {
        evidenceId: "ev-photo",
        type: "PHOTO",
        sha256: hash("b"),
        mimeType: "image/jpeg",
        capturedAt: "2026-01-01T12:00:00.000Z",
      },
    ]);
  });

  it("keeps revoked attestations visible, newest first, with verifier accountability", () => {
    const attestations = toPublicPassport(source())?.attestations ?? [];
    expect(attestations.map((a) => [a.id, a.status])).toEqual([
      ["att-0", "REVOKED"],
      ["att-1", "ACTIVE"],
    ]);
    expect(attestations[1]?.verifier).toEqual({
      id: "verifier-1",
      publicName: "Geneva Watch Lab",
      entityType: "LABORATORY",
      status: "APPROVED",
    });
  });

  it("dates the last verification from confirmed attestations that were not revoked", () => {
    expect(toPublicPassport(source())?.lastVerifiedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("orders provenance by sequence and keeps the hash chain, without actors or payloads", () => {
    expect(toPublicPassport(source())?.provenance).toEqual([
      {
        sequence: 1,
        type: "REGISTERED",
        occurredAt: "2026-01-01T00:00:00.000Z",
        hash: hash("e"),
        prevHash: null,
      },
      {
        sequence: 2,
        type: "EVIDENCE_ADDED",
        occurredAt: "2026-01-02T00:00:00.000Z",
        hash: hash("f"),
        prevHash: hash("e"),
      },
    ]);
  });

  it("lists only confirmed or finalized chain transactions", () => {
    expect(toPublicPassport(source())?.chainTransactions).toEqual([
      {
        kind: "MINT_ASSET",
        cluster: "DEVNET",
        signature: "chain-sig-1",
        confirmedAt: "2026-01-05T00:00:00.000Z",
      },
    ]);
  });

  it("always shows the Trust Score with its disclaimer and versions", () => {
    expect(toPublicPassport(source())?.trust).toEqual({
      score: 71,
      computedAt: "2026-04-02T00:00:00.000Z",
      engineVersion: "1.1.0",
      weightsVersion: "weights-2026.2",
      disclaimer: TRUST_SCORE_DISCLAIMER,
    });
    expect(toPublicPassport(source({ trust: null }))?.trust).toBeNull();
  });

  it("returns null for assets that are not published", () => {
    for (const status of ["DRAFT", "TOKENIZED"] as const) {
      const base = source();
      expect(toPublicPassport({ ...base, asset: { ...base.asset, status } })).toBeNull();
    }
  });

  it("still publishes revoked, disputed and stolen assets so their history stays visible", () => {
    expect(ASSET_STATUSES.filter(isPassportPublic)).toEqual([
      "ACTIVE",
      "VERIFIED",
      "TRANSFER_PENDING",
      "REVERIFICATION_REQUIRED",
      "DISPUTED",
      "REPORTED_LOST",
      "REPORTED_STOLEN",
      "REVOKED",
    ]);
  });
});

describe("passport URLs", () => {
  it("builds a QR-friendly path and URL", () => {
    expect(passportPath("wb-7f93a281")).toBe("/passport/WB-7F93A281");
    expect(passportUrl("https://worthybound.example", "WB-7F93A281")).toBe(
      "https://worthybound.example/passport/WB-7F93A281",
    );
  });

  it("rejects invalid IDs and non-web base URLs", () => {
    expect(() => passportPath("WB-123/../../admin")).toThrow();
    expect(() => passportUrl("javascript:alert(1)", "WB-7F93A281")).toThrow(TypeError);
  });
});
