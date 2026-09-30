import type { PublicPassport } from "@worthybound/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerAsset, OwnerEvidence } from "../src/types.js";
import { me, mockFetch, renderAt, unauthenticated } from "./helpers.js";

const WB = "WB-7F93A281";

const passport = (overrides: Partial<PublicPassport> = {}): PublicPassport => ({
  wbId: WB,
  category: "LUXURY_WATCH",
  brand: "Rolex",
  model: "Submariner",
  description: "Black dial, 2012.",
  status: "VERIFIED",
  publishedAt: "2026-09-29T10:00:00.000Z",
  verificationLevel: "PROFESSIONALLY_VERIFIED" as PublicPassport["verificationLevel"],
  lastVerifiedAt: "2026-09-29T11:00:00.000Z",
  condition: { ownerStated: "EXCELLENT", verified: null },
  trust: {
    score: 72,
    computedAt: "2026-09-29T11:00:00.000Z",
    engineVersion: "1.1.0",
    weightsVersion: "weights-2026.2",
    disclaimer: "Not a guarantee.",
  },
  tokenization: {
    status: "TOKENIZED",
    chainAssetAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    chainRecordAddress: "5stfBCcoD9mpW3514ycoKZBQ4Xzav3KpbZHTC9AUGMem",
  },
  custody: { currentSince: "2026-09-29T10:00:00.000Z", transferCount: 0 },
  publicEvidence: [],
  evidenceCommitments: [],
  attestations: [
    {
      id: "a1",
      claimType: "AUTHENTICATION",
      result: "CONFIRMED",
      method: "IN_PERSON",
      assuranceLevel: "HIGH",
      conditionGrade: null,
      status: "ACTIVE",
      issuedAt: "2026-09-29T11:00:00.000Z",
      expiresAt: null,
      signedPayloadHash: "h",
      signature: "s",
      chainAttestationAddress: null,
      verifier: {
        id: "v1",
        publicName: "Geneva Watch Lab",
        entityType: "COMPANY" as never,
        status: "APPROVED" as never,
      },
    },
  ],
  provenance: [
    {
      sequence: 1,
      type: "REGISTERED",
      occurredAt: "2026-09-29T10:00:00.000Z",
      hash: "abcdef0123456789abcdef0123456789",
      prevHash: null,
    },
  ],
  chainTransactions: [],
  ...overrides,
});

const asset = (overrides: Partial<OwnerAsset> = {}): OwnerAsset => ({
  wbId: WB,
  category: "LUXURY_WATCH",
  brand: "Rolex",
  model: "Submariner",
  serialNumber: "SECRET-SERIAL",
  description: null,
  publicDescription: null,
  attributes: {},
  condition: null,
  status: "ACTIVE",
  tokenizationStatus: "NOT_TOKENIZED",
  chainAssetAddress: null,
  chainRecordAddress: null,
  verificationLevel: "UNVERIFIED",
  trustScore: 10,
  publishedAt: "2026-09-29T10:00:00.000Z",
  createdAt: "2026-09-29T09:00:00.000Z",
  updatedAt: "2026-09-29T10:00:00.000Z",
  passportUrl: `http://localhost/passport/${WB}`,
  missingForPublish: [],
  ...overrides,
});

const evidence = (overrides: Partial<OwnerEvidence> = {}): OwnerEvidence => ({
  id: "0199a000-0000-7000-8000-00000000e001",
  type: "PHOTO",
  source: "OWNER",
  mimeType: "image/jpeg",
  sizeBytes: 5,
  sha256: "a".repeat(64),
  visibility: "PRIVATE",
  reviewStatus: "PENDING",
  reviewReason: null,
  originalFilename: "front.jpg",
  description: null,
  createdAt: "2026-09-29T10:00:00.000Z",
  publicPath: null,
  ...overrides,
});

/** The file input of the form whose submit button reads `label`. */
const fileInputOf = (label: string) =>
  (screen.getByText(label).closest("form") as HTMLFormElement).querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;

const ownerRoutes = (a: OwnerAsset) => ({
  "GET /auth/me": { json: me() },
  [`GET /assets/${WB}`]: { json: a },
  [`GET /assets/${WB}/evidence`]: { json: { items: [] } },
  [`GET /assets/${WB}/trust`]: { json: null },
  [`GET /assets/${WB}/verification-requests`]: { json: { items: [] } },
  "GET /templates": { json: { items: [] } },
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.phantom;
});

describe("public passport", () => {
  it("shows the item, score, verifier and chain record without signing in", async () => {
    mockFetch({
      "GET /auth/me": unauthenticated,
      [`GET /passport/${WB}`]: { json: { passport: passport(), url: "" } },
    });
    renderAt(`/passport/${WB}`);
    expect(await screen.findByText("Submariner")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Trust Score 72 of 100" })).toBeTruthy();
    expect(screen.getByText("Not a guarantee.")).toBeTruthy();
    expect(screen.getByText(/Geneva Watch Lab/)).toBeTruthy();
    const record = screen.getByText("5stf…GMem ↗") as HTMLAnchorElement;
    expect(record.getAttribute("href")).toBe(
      "https://explorer.solana.com/address/5stfBCcoD9mpW3514ycoKZBQ4Xzav3KpbZHTC9AUGMem?cluster=devnet",
    );
  });

  it("warns prominently when the item is reported stolen", async () => {
    mockFetch({
      "GET /auth/me": unauthenticated,
      [`GET /passport/${WB}`]: {
        json: { passport: passport({ status: "REPORTED_STOLEN" }), url: "" },
      },
    });
    renderAt(`/passport/${WB}`);
    expect((await screen.findByRole("alert")).textContent).toMatch(/reported stolen/i);
  });

  it("says when there is no passport", async () => {
    mockFetch({ "GET /auth/me": unauthenticated });
    renderAt(`/passport/${WB}`);
    expect(await screen.findByText(`No public passport with WB ID ${WB}.`)).toBeTruthy();
  });

  it("looks up a WB ID from the home page", async () => {
    mockFetch({
      "GET /auth/me": unauthenticated,
      [`GET /passport/${WB}`]: { json: { passport: passport(), url: "" } },
    });
    renderAt("/");
    fireEvent.change(screen.getByLabelText("WB ID"), { target: { value: "wb-7f93a281" } });
    fireEvent.click(screen.getByText("Check"));
    expect(await screen.findByText("Submariner")).toBeTruthy();
    expect(window.location.pathname).toBe(`/passport/${WB}`);
  });
});

describe("sign-in", () => {
  it("signs the exact message from the API and sends base64 message and signature", async () => {
    const message = "localhost wants you to sign in with your Solana account:\n4WFo…";
    const signMessage = vi.fn(async (_message: Uint8Array) => ({
      signature: new Uint8Array([1, 2, 3]),
    }));
    window.phantom = {
      solana: {
        connect: async () => ({ publicKey: { toString: () => me().user.walletAddress } }),
        signMessage,
      },
    };
    const calls = mockFetch({
      "GET /auth/me": unauthenticated,
      "POST /auth/nonce": { json: { input: {}, message, expiresAt: "" } },
      "POST /auth/verify": { json: me() },
    });
    renderAt("/");
    fireEvent.click(screen.getByText("Connect wallet"));
    expect(await screen.findByText(/Sign out/)).toBeTruthy();
    expect(new TextDecoder().decode(signMessage.mock.calls[0]?.[0] as Uint8Array)).toBe(message);
    const verify = calls.find((c) => c.url === "/auth/verify");
    expect(verify?.body).toEqual({
      address: me().user.walletAddress,
      message: btoa(unescape(encodeURIComponent(message))),
      signature: "AQID",
    });
  });

  it("explains when no wallet is installed", async () => {
    mockFetch({ "GET /auth/me": unauthenticated });
    renderAt("/");
    fireEvent.click(screen.getByText("Connect wallet"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Install Phantom/);
  });

  it("asks to connect before showing owner pages", async () => {
    mockFetch({ "GET /auth/me": unauthenticated });
    renderAt("/assets");
    expect(await screen.findByText("Connect your wallet to continue.")).toBeTruthy();
  });
});

describe("owner asset page", () => {
  it("tokenizes a published asset and polls until the mint is confirmed", async () => {
    let state: OwnerAsset = asset();
    const calls = mockFetch({
      ...ownerRoutes(state),
      [`GET /assets/${WB}`]: () => ({ json: state }),
      [`POST /assets/${WB}/tokenize`]: () => (
        (state = asset({ tokenizationStatus: "PENDING" })),
        { status: 202, json: state }
      ),
    });
    renderAt(`/assets/${WB}`);
    fireEvent.click(await screen.findByText("Tokenize on Solana devnet"));
    expect(await screen.findByText(/Minting on devnet/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === `/assets/${WB}/tokenize`)).toBe(true);
    state = asset({
      tokenizationStatus: "TOKENIZED",
      chainAssetAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    });
    await waitFor(() => expect(screen.getByText("9xQe…VFin ↗")).toBeTruthy(), { timeout: 5000 });
  });

  it("blocks tokenization until the owner's identity is verified", async () => {
    mockFetch({ ...ownerRoutes(asset()), "GET /auth/me": { json: me(["USER"], "UNVERIFIED") } });
    renderAt(`/assets/${WB}`);
    const button = (await screen.findByText("Tokenize on Solana devnet")) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Needs a verified identity/)).toBeTruthy();
  });

  it("lists what is missing before a draft can be published", async () => {
    mockFetch(
      ownerRoutes(asset({ status: "DRAFT", publishedAt: null, missingForPublish: ["model"] })),
    );
    renderAt(`/assets/${WB}`);
    expect(await screen.findByText("To publish, add: model.")).toBeTruthy();
    expect(screen.queryByText("Publish passport")).toBeNull();
  });

  it("hashes, uploads straight to storage and completes an evidence upload", async () => {
    const calls = mockFetch({
      ...ownerRoutes(asset()),
      [`POST /assets/${WB}/evidence/uploads`]: {
        status: 201,
        json: {
          uploadId: "up1",
          upload: {
            url: "https://r2.example/bucket/staging/up1",
            method: "PUT",
            headers: { "Content-Type": "image/jpeg", "Content-Length": "5" },
          },
          expiresAt: "",
        },
      },
      "PUT https://r2.example/bucket/staging/up1": { json: undefined },
      "POST /evidence/uploads/up1/complete": { status: 201, json: {} },
    });
    renderAt(`/assets/${WB}`);
    await screen.findByText("Add evidence");
    const file = new File([new Uint8Array([104, 101, 108, 108, 111])], "front.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(fileInputOf("Add evidence"), { target: { files: [file] } });
    fireEvent.click(screen.getByLabelText(/Show this photo on the public passport/));
    fireEvent.click(screen.getByText("Add evidence"));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/evidence/uploads/up1/complete")).toBe(true),
    );

    const request = calls.find((c) => c.url === `/assets/${WB}/evidence/uploads`);
    expect(request?.body).toEqual({
      type: "PHOTO",
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      mimeType: "image/jpeg",
      sizeBytes: 5,
      originalFilename: "front.jpg",
      visibility: "PUBLIC",
    });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(put?.body).toBe(file);
  });

  it("rejects file types the vault does not accept before uploading", async () => {
    const calls = mockFetch(ownerRoutes(asset()));
    renderAt(`/assets/${WB}`);
    await screen.findByText("Add evidence");
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.change(fileInputOf("Add evidence"), { target: { files: [file] } });
    fireEvent.click(screen.getByText("Add evidence"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/text\/plain are not accepted/);
    expect(calls.some((c) => c.url.includes("/evidence/uploads"))).toBe(false);
  });

  it("offers public sharing only for photos, not for images of receipts", async () => {
    mockFetch(ownerRoutes(asset()));
    renderAt(`/assets/${WB}`);
    await screen.findByText("Add evidence");
    const form = screen.getByText("Add evidence").closest("form") as HTMLFormElement;
    fireEvent.change(fileInputOf("Add evidence"), {
      target: { files: [new File(["x"], "receipt.jpg", { type: "image/jpeg" })] },
    });
    expect(within(form).queryByLabelText(/on the public passport/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Type"), { target: { value: "RECEIPT" } });
    expect(within(form).queryByLabelText(/on the public passport/)).toBeNull();
  });

  it("asks for photos until the item has one, and uploads several at once", async () => {
    let items: OwnerEvidence[] = [];
    let n = 0;
    const calls = mockFetch({
      ...ownerRoutes(asset()),
      [`GET /assets/${WB}/evidence`]: () => ({ json: { items } }),
      [`POST /assets/${WB}/evidence/uploads`]: () => (
        n++,
        {
          status: 201,
          json: {
            uploadId: `up${n}`,
            upload: { url: `https://r2.example/up${n}`, method: "PUT", headers: {} },
            expiresAt: "",
          },
        }
      ),
      "PUT https://r2.example/up1": { json: undefined },
      "PUT https://r2.example/up2": { json: undefined },
      "POST /evidence/uploads/up1/complete": { status: 201, json: {} },
      "POST /evidence/uploads/up2/complete": () => (
        (items = [evidence()]),
        { status: 201, json: {} }
      ),
    });
    renderAt(`/assets/${WB}`);
    await screen.findByText("Add photos of your item");
    fireEvent.change(fileInputOf("Add photos"), {
      target: {
        files: [
          new File(["front"], "front.jpg", { type: "image/jpeg" }),
          new File(["back"], "back.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.click(screen.getByText("Add photos"));
    await waitFor(() => expect(screen.queryByText("Add photos of your item")).toBeNull());
    const requests = calls.filter((c) => c.url === `/assets/${WB}/evidence/uploads`);
    expect(
      requests.map((c) => {
        const body = c.body as { type: string; originalFilename: string };
        return [body.type, body.originalFilename];
      }),
    ).toEqual([
      ["PHOTO", "front.jpg"],
      ["PHOTO", "back.png"],
    ]);
  });

  it("shows private previews of images and a label for other files", async () => {
    mockFetch({
      ...ownerRoutes(asset()),
      [`GET /assets/${WB}/evidence`]: {
        json: {
          items: [
            evidence(),
            evidence({
              id: "0199a000-0000-7000-8000-00000000e002",
              type: "RECEIPT",
              mimeType: "application/pdf",
              originalFilename: "receipt.pdf",
            }),
          ],
        },
      },
    });
    const { container } = renderAt(`/assets/${WB}`);
    await screen.findByText("receipt.pdf", { exact: false });
    expect(screen.queryByText("Add photos of your item")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("img.thumb")).map((i) => i.getAttribute("src")),
    ).toEqual([`/assets/${WB}/evidence/0199a000-0000-7000-8000-00000000e001/preview`]);
    expect(container.querySelector(".thumb.file")?.textContent).toBe("PDF");
  });
});

describe("my assets", () => {
  it("shows each asset's photo thumbnail, or a placeholder", async () => {
    mockFetch({
      "GET /auth/me": { json: me() },
      "GET /assets": {
        json: {
          items: [
            { ...asset(), thumbnailPath: `/assets/${WB}/evidence/e1/preview` },
            { ...asset({ wbId: "WB-00000002", model: "Daytona" }), thumbnailPath: null },
          ],
          nextCursor: null,
        },
      },
    });
    const { container } = renderAt("/assets");
    await screen.findByText("Daytona", { exact: false });
    expect(container.querySelector("img.tile-photo")?.getAttribute("src")).toBe(
      `/assets/${WB}/evidence/e1/preview`,
    );
    expect(screen.getByText("No photo yet")).toBeTruthy();
  });
});

describe("verifier attestation", () => {
  const VERIFIER = "Ver1f1erWa11etAddress1111111111111111111111";
  const request = {
    id: "0199a000-0000-7000-8000-000000000001",
    status: "ASSIGNED",
    assignedToYou: true,
    template: {
      templateId: "t",
      templateVersionId: "tv",
      code: "watch-standard",
      name: "Luxury watch — standard",
      version: 1,
      validityMonths: 24,
      requiredClaims: ["AUTHENTICATION"],
      requiredEvidence: [],
      allowedMethods: ["IN_PERSON"],
      minVerifiers: 1,
    },
    closedReason: null,
    assignedAt: "2026-09-29T10:00:00.000Z",
    completedAt: null,
    expiresAt: "2026-10-29T10:00:00.000Z",
    createdAt: "2026-09-29T09:00:00.000Z",
    attestations: [],
    asset: {
      wbId: WB,
      category: "LUXURY_WATCH",
      brand: "Rolex",
      model: "Submariner",
      status: "ACTIVE",
      publicDescription: null,
      ownerStatedCondition: null,
      serialNumber: "SECRET-SERIAL",
      attributes: {},
    },
  };
  const base = `/verifier/requests/${request.id}`;
  const routes = (message: string) => ({
    "GET /auth/me": { json: me(["USER", "VERIFIER"]) },
    [`GET ${base}`]: { json: request },
    [`GET ${base}/evidence`]: { json: { items: [] } },
    [`POST ${base}/attestations/message`]: { json: { message, verifierAddress: VERIFIER } },
    [`POST ${base}/attestations`]: { status: 201, json: {} },
  });
  const wallet = (address: string) => {
    const signMessage = vi.fn(async (_message: Uint8Array) => ({
      signature: new Uint8Array(64).fill(7),
    }));
    window.phantom = {
      solana: { connect: async () => ({ publicKey: { toString: () => address } }), signMessage },
    };
    return signMessage;
  };

  it("signs the message the API built and submits the same claim with a base58 signature", async () => {
    const signMessage = wallet(VERIFIER);
    const calls = mockFetch(routes("wb-attestation-v1\nclaim: AUTHENTICATION"));
    renderAt(base);
    fireEvent.click(await screen.findByText("Sign and submit"));
    await waitFor(() => expect(calls.some((c) => c.url === `${base}/attestations`)).toBe(true));

    const draft = calls.find((c) => c.url === `${base}/attestations/message`)?.body as Record<
      string,
      unknown
    >;
    expect(draft).toMatchObject({
      claimType: "AUTHENTICATION",
      result: "CONFIRMED",
      method: "IN_PERSON",
      assuranceLevel: "HIGH",
      evidence: [],
    });
    const months =
      (new Date(draft.expiresAt as string).getTime() -
        new Date(draft.issuedAt as string).getTime()) /
      (30 * 86_400_000);
    expect(Math.round(months)).toBe(24);
    expect(new TextDecoder().decode(signMessage.mock.calls[0]?.[0] as Uint8Array)).toBe(
      "wb-attestation-v1\nclaim: AUTHENTICATION",
    );
    const submitted = calls.find((c) => c.url === `${base}/attestations`)?.body as Record<
      string,
      unknown
    >;
    expect(submitted).toEqual({
      ...draft,
      signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
    });
  });

  it("refuses to sign with a wallet other than the verifier's", async () => {
    const signMessage = wallet(me().user.walletAddress);
    const calls = mockFetch(routes("wb-attestation-v1"));
    renderAt(base);
    fireEvent.click(await screen.findByText("Sign and submit"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Switch your wallet/);
    expect(signMessage).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === `${base}/attestations`)).toBe(false);
  });

  it("keeps Mark complete disabled until every required claim is attested", async () => {
    mockFetch(routes(""));
    renderAt(base);
    expect(((await screen.findByText("Mark complete")) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("admin", () => {
  const VID = "0199a000-0000-7000-8000-0000000000a1";
  const applicant = (overrides: Record<string, unknown> = {}) => ({
    id: VID,
    status: "UNDER_REVIEW",
    entityType: "BUSINESS",
    businessName: "Geneva Watch Lab",
    website: null,
    bio: null,
    approvedAt: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    identityStatus: "VERIFIED",
    walletAddress: "Ver1f1erWa11etAddress1111111111111111111111",
    identityProvider: "manual",
    identityVerifiedAt: "2026-09-29T10:00:00.000Z",
    approvedById: null,
    categories: [
      {
        id: "p1",
        category: "LUXURY_WATCH",
        status: "PENDING",
        reason: null,
        approvedById: null,
        approvedAt: null,
        revokedAt: null,
        createdAt: "2026-09-29T10:00:00.000Z",
        history: [],
      },
    ],
    history: [],
    ...overrides,
  });

  it("shows the Admin link only to administrators and reviewers", async () => {
    mockFetch({ "GET /auth/me": { json: me(["USER"]) } });
    const user = renderAt("/");
    expect(await screen.findByText("Become a verifier")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    user.unmount();
    mockFetch({
      "GET /auth/me": { json: me(["USER", "ADMIN"]) },
      "GET /review/verifiers": { json: { items: [], nextCursor: null } },
    });
    renderAt("/");
    fireEvent.click(await screen.findByRole("link", { name: "Admin" }));
    expect(await screen.findByText("No verifiers with this status.")).toBeTruthy();
  });

  it("keeps other signed-in users out of the admin pages", async () => {
    mockFetch({ "GET /auth/me": { json: me(["USER"]) } });
    renderAt("/admin/templates");
    expect(await screen.findByText("This page is for administrators.")).toBeTruthy();
  });

  it("asks for a reason before rejecting, then approves a verifier and a category", async () => {
    let state = applicant();
    const calls = mockFetch({
      "GET /auth/me": { json: me(["USER", "ADMIN"]) },
      [`GET /review/verifiers/${VID}`]: () => ({ json: state }),
      [`POST /review/verifiers/${VID}/status`]: () => (
        (state = applicant({ status: "APPROVED" })),
        { json: state }
      ),
      [`POST /review/verifiers/${VID}/categories/LUXURY_WATCH`]: { json: applicant() },
    });
    renderAt(`/admin/verifiers/${VID}`);
    fireEvent.click(await screen.findByText("Reject"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Enter a reason/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(screen.getByText("Approve"));
    await screen.findByText("Suspend");
    expect(calls.find((c) => c.url.endsWith("/status"))?.body).toEqual({ status: "APPROVED" });

    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/categories/LUXURY_WATCH"))?.body).toEqual({
        status: "APPROVED",
      }),
    );
  });

  it("warns when the applicant's identity is not verified", async () => {
    mockFetch({
      "GET /auth/me": { json: me(["USER", "ADMIN"]) },
      [`GET /review/verifiers/${VID}`]: { json: applicant({ identityStatus: "UNVERIFIED" }) },
    });
    renderAt(`/admin/verifiers/${VID}`);
    expect((await screen.findByText(/Identity not verified\./)).textContent).toMatch(/KYC/);
  });

  it("creates a draft template version and publishes it", async () => {
    const draft = {
      id: "0199a000-0000-7000-8000-0000000000b2",
      version: 1,
      validityMonths: 60,
      status: "DRAFT",
      requiredClaims: ["AUTHENTICATION"],
      requiredEvidence: [{ type: "PHOTO", minCount: 4 }],
      allowedMethods: ["IN_PERSON"],
      minVerifiers: 1,
      createdById: "u1",
      publishedById: null,
      publishedAt: null,
      createdAt: "2026-09-29T10:00:00.000Z",
    };
    const template = {
      id: "0199a000-0000-7000-8000-0000000000b1",
      code: "luxury-watch",
      category: "LUXURY_WATCH",
      name: "Luxury watch check",
      description: null,
      createdAt: "2026-09-29T10:00:00.000Z",
      versions: [] as (typeof draft)[],
    };
    const calls = mockFetch({
      "GET /auth/me": { json: me(["USER", "ADMIN"]) },
      "GET /admin/templates": () => ({ json: { items: [template] } }),
      [`POST /admin/templates/${template.id}/versions`]: () => (
        (template.versions = [draft]),
        { status: 201, json: draft }
      ),
      [`POST /admin/template-versions/${draft.id}/status`]: { json: draft },
    });
    vi.stubGlobal("confirm", () => true);
    renderAt("/admin/templates");
    fireEvent.click(await screen.findByText("Add a version"));
    fireEvent.click(screen.getByLabelText("Authentication"));
    fireEvent.click(screen.getByLabelText("In person"));
    fireEvent.change(screen.getByLabelText("Photo"), { target: { value: "4" } });
    fireEvent.click(screen.getByText("Save draft"));
    fireEvent.click(await screen.findByText("Publish"));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/status"))?.body).toEqual({ status: "PUBLISHED" }),
    );
    expect(calls.find((c) => c.url.endsWith("/versions"))?.body).toEqual({
      requiredClaims: ["AUTHENTICATION"],
      requiredEvidence: [{ type: "PHOTO", minCount: 4 }],
      allowedMethods: ["IN_PERSON"],
      minVerifiers: 1,
      validityMonths: 60,
    });
  });

  it("adds and removes a verifier reviewer", async () => {
    const assignment = {
      id: "0199a000-0000-7000-8000-0000000000c1",
      walletAddress: "Rev1ewerWa11etAddress111111111111111111111",
      role: "VERIFIER_REVIEWER",
      grantedById: "u1",
      grantedAt: "2026-09-29T10:00:00.000Z",
      revokedAt: null,
    };
    let items: (typeof assignment)[] = [];
    const calls = mockFetch({
      "GET /auth/me": { json: me(["USER", "ADMIN"]) },
      "GET /admin/roles": () => ({ json: { items } }),
      "POST /admin/roles": () => ((items = [assignment]), { status: 201, json: assignment }),
      [`DELETE /admin/roles/${assignment.id}`]: () => ((items = []), { json: assignment }),
    });
    vi.stubGlobal("confirm", () => true);
    renderAt("/admin/roles");
    await screen.findByText("No reviewers.");
    fireEvent.change(screen.getByLabelText("Wallet address"), {
      target: { value: assignment.walletAddress },
    });
    fireEvent.click(screen.getByText("Add reviewer"));
    fireEvent.click(await screen.findByText("Remove"));
    expect(await screen.findByText("No reviewers.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      walletAddress: assignment.walletAddress,
      role: "VERIFIER_REVIEWER",
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("verifier application", () => {
  it("sends an application and then shows its status", async () => {
    let mine: unknown = null;
    const calls = mockFetch({
      "GET /auth/me": { json: me(["USER"]) },
      "GET /verifier/me": () =>
        mine
          ? { json: mine }
          : { status: 404, json: { error: { code: "not_found", message: "Not found" } } },
      "POST /verifier/application": () => (
        (mine = {
          id: "v1",
          status: "APPLIED",
          entityType: "BUSINESS",
          businessName: "Geneva Watch Lab",
          website: null,
          bio: null,
          approvedAt: null,
          createdAt: "2026-09-29T10:00:00.000Z",
          updatedAt: "2026-09-29T10:00:00.000Z",
          identityStatus: "UNVERIFIED",
          identityRequired: true,
          canApplyAgainAt: null,
          categories: [],
          history: [],
        }),
        { status: 201, json: mine }
      ),
    });
    renderAt("/verifier/apply");
    fireEvent.change(await screen.findByLabelText("You are"), { target: { value: "BUSINESS" } });
    fireEvent.change(screen.getByLabelText("Business name (shown publicly)"), {
      target: { value: "Geneva Watch Lab" },
    });
    fireEvent.click(screen.getByLabelText("Luxury watch"));
    fireEvent.click(screen.getByText("Send application"));
    expect(await screen.findByText("Your application")).toBeTruthy();
    expect(screen.queryByText("Send application")).toBeNull();
    expect(screen.getByText(/identity has not been verified/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      entityType: "BUSINESS",
      businessName: "Geneva Watch Lab",
      categories: ["LUXURY_WATCH"],
    });
  });
});
