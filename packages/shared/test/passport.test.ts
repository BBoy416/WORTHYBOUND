import { describe, expect, it } from "vitest";
import {
  ASSET_STATUSES,
  encodeQr,
  forEachDataModule,
  formatBits,
  gfMultiply,
  isPassportPublic,
  type PassportSource,
  passportPath,
  passportUrl,
  QR_MASKS,
  passportLabelSvg,
  rsRemainder,
  toPublicPassport,
  TRUST_SCORE_DISCLAIMER,
  wbIdFromScan,
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
    chainRecordAddress: "RecordAddr111111111111111111111111111111111",
    verificationLevel: "AUTHENTICATED",
    condition: "EXCELLENT",
    publishedAt: d("2025-12-01T00:00:00Z"),
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
    source: "OWNER",
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
    source: "VERIFIER",
    visibility: "PUBLIC",
    reviewStatus: "ACCEPTED",
    reviewReason: `${SECRET}-review-reason`,
    verificationRequestId: `${SECRET}-request`,
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
    conditionGrade: null,
    status: "ACTIVE",
    issuedAt: d("2026-03-01T00:00:00Z"),
    expiresAt: d("2031-03-01T00:00:00Z"),
    signedPayloadHash: hash("c"),
    signature: "sig-1",
    chainAttestationAddress: null,
    verifier,
    notes: `${SECRET}-notes`,
    nonce: `${SECRET}-nonce`,
    signedMessage: `${SECRET}-signed-message`,
    verificationRequestId: `${SECRET}-request`,
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
    automatedChecks: {
      filesPassed: 2,
      lastPassedAt: d("2026-04-01T00:00:00Z"),
      summary: `${SECRET}-check-details`,
    } as PassportSource["automatedChecks"],
    custody: { currentSince: d("2025-12-01T00:00:00Z"), transferCount: 0 },
    openDisputes: 1,
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
        source: "VERIFIER",
        sha256: hash("b"),
        mimeType: "image/jpeg",
        capturedAt: "2026-01-01T12:00:00.000Z",
        path: "/passport/WB-7F93A281/evidence/ev-photo",
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

  it("shows the token and record addresses only once tokenized", () => {
    expect(toPublicPassport(source())?.tokenization).toEqual({
      status: "TOKENIZED",
      chainAssetAddress: "AssetAddr1111111111111111111111111111111111",
      chainRecordAddress: "RecordAddr111111111111111111111111111111111",
    });
    const pending = source();
    const passport = toPublicPassport({
      ...pending,
      asset: { ...pending.asset, tokenizationStatus: "PENDING" },
    });
    expect(passport?.tokenization).toEqual({
      status: "PENDING",
      chainAssetAddress: null,
      chainRecordAddress: null,
    });
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

  it("shows only that automated checks passed, and when", () => {
    expect(toPublicPassport(source())?.openDisputes).toBe(1);
    expect(toPublicPassport(source())?.automatedChecks).toEqual({
      filesPassed: 2,
      lastPassedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(toPublicPassport(source({ automatedChecks: null }))?.automatedChecks).toBeNull();
  });

  it("returns null for assets that are not published", () => {
    for (const status of ["DRAFT", "TOKENIZED"] as const) {
      const base = source();
      expect(toPublicPassport({ ...base, asset: { ...base.asset, status } })).toBeNull();
    }
  });

  it("returns null for a discarded draft that was never published", () => {
    const base = source();
    expect(
      toPublicPassport({ ...base, asset: { ...base.asset, status: "REVOKED", publishedAt: null } }),
    ).toBeNull();
    expect(
      toPublicPassport({ ...base, asset: { ...base.asset, status: "REVOKED" } })?.publishedAt,
    ).toBe("2025-12-01T00:00:00.000Z");
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
  describe("condition", () => {
    const conditionCheck = (overrides: {
      id: string;
      grade: "NEW" | "VERY_GOOD" | "GOOD" | "FAIR";
      issuedAt: string;
      status?: "ACTIVE" | "REVOKED";
    }) => {
      const base = source().attestations[0];
      if (!base) throw new Error("fixture has no attestation");
      return {
        ...base,
        id: overrides.id,
        claimType: "CONDITION" as const,
        conditionGrade: overrides.grade,
        issuedAt: d(overrides.issuedAt),
        status: overrides.status ?? ("ACTIVE" as const),
      };
    };

    it("shows the owner-stated condition separately when nothing is verified", () => {
      expect(toPublicPassport(source())?.condition).toEqual({
        ownerStated: "EXCELLENT",
        verified: null,
      });
    });

    it("shows the latest active verified grade with its verifier and date", () => {
      const passport = toPublicPassport(
        source({
          attestations: [
            conditionCheck({ id: "c-old", grade: "VERY_GOOD", issuedAt: "2026-02-01T00:00:00Z" }),
            conditionCheck({ id: "c-new", grade: "GOOD", issuedAt: "2026-05-01T00:00:00Z" }),
            conditionCheck({
              id: "c-revoked",
              grade: "NEW",
              issuedAt: "2026-06-01T00:00:00Z",
              status: "REVOKED",
            }),
          ],
        }),
      );
      expect(passport?.condition).toEqual({
        ownerStated: "EXCELLENT",
        verified: {
          grade: "GOOD",
          assessedAt: "2026-05-01T00:00:00.000Z",
          attestationId: "c-new",
          verifier: { id: "verifier-1", publicName: "Geneva Watch Lab" },
          fromPreviousCustody: false,
        },
      });
      expect(passport?.attestations.map((a) => a.conditionGrade)).toEqual([
        "NEW",
        "GOOD",
        "VERY_GOOD",
      ]);
    });

    it("flags a grade assessed before the current owner's custody", () => {
      const passport = toPublicPassport(
        source({
          custody: { currentSince: d("2026-07-01T00:00:00Z"), transferCount: 1 },
          attestations: [
            conditionCheck({ id: "c-1", grade: "FAIR", issuedAt: "2026-05-01T00:00:00Z" }),
          ],
        }),
      );
      expect(passport?.condition.verified?.fromPreviousCustody).toBe(true);
    });
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

describe("passport QR codes", () => {
  const URL_TEXT = "https://worthybound.com/passport/WB-59D6C372";

  it("adds Reed–Solomon codewords that make every syndrome zero", () => {
    const data = [...new TextEncoder().encode(URL_TEXT)];
    const ecc = rsRemainder(data, 18);
    const codeword = [...data, ...ecc];
    for (let i = 0, root = 1; i < 18; i++, root = gfMultiply(root, 2)) {
      expect(codeword.reduce((acc, c) => gfMultiply(acc, root) ^ c, 0)).toBe(0);
    }
  });

  it("draws finder patterns and the format bits of the chosen mask", () => {
    const { modules, version, mask } = encodeQr(URL_TEXT);
    expect(version).toBe(4);
    expect(modules).toHaveLength(33);
    expect(modules[0]!.slice(0, 7)).toEqual(new Array(7).fill(true));
    expect(modules[1]!.slice(0, 7)).toEqual([true, false, false, false, false, false, true]);
    const bits = formatBits(mask);
    const read = [0, 1, 2, 3, 4, 5, 7, 8].map((y) => modules[y]![8]);
    expect(read).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ((bits >>> i) & 1) === 1));
  });

  it("stores the text so it reads back from a version 1 code", () => {
    const text = "WB-7F93A281";
    const { modules, version, mask } = encodeQr(text);
    expect(version).toBe(1);
    const size = modules.length;
    const reserved = modules.map((row, y) =>
      row.map(
        (_, x) =>
          x === 6 ||
          y === 6 ||
          (x < 9 && y < 9) ||
          (x > size - 9 && y < 9) ||
          (x < 9 && y > size - 9),
      ),
    );
    const bits: number[] = [];
    forEachDataModule(size, reserved, (x, y) => {
      bits.push(Number(modules[y]![x]! !== QR_MASKS[mask]!(x, y)));
    });
    const byte = (offset: number) => bits.slice(offset, offset + 8).reduce((a, b) => a * 2 + b, 0);
    expect(bits.slice(0, 4)).toEqual([0, 1, 0, 0]);
    expect(byte(4)).toBe(text.length);
    const decoded = String.fromCharCode(...[...text].map((_, i) => byte(12 + i * 8)));
    expect(decoded).toBe(text);
  });

  describe("printable label", () => {
    const label = (itemName?: string) =>
      passportLabelSvg({ url: URL_TEXT, wbId: "WB-59D6C372", itemName });

    it("is a 2 × 2 inch label with a dashed cut line inside a 2.5 inch sheet", () => {
      const svg = label("Rolex Submariner");
      expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 250 250" width="2.5in" height="2.5in"/);
      expect(svg).toContain(
        '<rect x="25" y="25" width="200" height="200" fill="none" stroke="#555" stroke-width="0.7" stroke-dasharray="4 2.5"/>',
      );
      expect(svg).toContain("WB-59D6C372");
      expect(svg).toContain("Rolex Submariner");
      expect(svg).toContain("worthybound.com");
      expect(svg).toContain("Cut along the dashed line");
    });

    it("draws exactly the QR code of the passport link", () => {
      const { modules } = encodeQr(URL_TEXT);
      const dark = modules.flat().filter(Boolean).length;
      const path = /scale\([^)]+\)" d="([^"]+)"/.exec(label())![1]!;
      expect(path.split("M").length - 1).toBe(dark);
      expect(path).toContain(`M4 4h1v1h-1z`);
    });

    it("escapes the item name and shortens a long one", () => {
      expect(label('A <b> & "c"')).toContain("A &#60;b&#62; &#38; &#34;c&#34;");
      expect(label("x".repeat(60))).toContain(`${"x".repeat(33)}…`);
      expect(label("<script>")).not.toContain("<script");
      expect(label()).not.toContain('font-size="6.2"');
    });
  });

  it("rejects text that does not fit", () => {
    expect(() => encodeQr("x".repeat(214))).toThrow(RangeError);
  });

  describe("scanning", () => {
    const origins = ["https://worthybound.com"];

    it.each([
      ["https://worthybound.com/passport/WB-59D6C372", "WB-59D6C372"],
      ["https://worthybound.com/passport/wb-59d6c372/", "WB-59D6C372"],
      ["  wb-59d6c372 ", "WB-59D6C372"],
    ])("opens a WorthyBound passport: %s", (scanned, wbId) => {
      expect(wbIdFromScan(scanned, origins)).toBe(wbId);
    });

    it.each([
      "https://worthyb0und.com/passport/WB-59D6C372",
      "https://worthybound.com.evil.example/passport/WB-59D6C372",
      "http://worthybound.com/passport/WB-59D6C372",
      "https://worthybound.com/assets/WB-59D6C372",
      "https://worthybound.com/passport/WB-59D6C37",
      "javascript:alert(1)",
      "WIFI:S:home;T:WPA;P:secret;;",
    ])("refuses anything else: %s", (scanned) => {
      expect(wbIdFromScan(scanned, origins)).toBeNull();
    });
  });
});
