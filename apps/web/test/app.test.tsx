import type { PublicPassport } from "@worthybound/shared";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureShot } from "@worthybound/shared";
import type {
  AdminTransfer,
  CaptureSession,
  OwnerAsset,
  OwnerEvidence,
  PurchaseCheck,
  Transfer,
  TransferEscrow,
} from "../src/types.js";
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
  automatedChecks: null,
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
  captureShot: null,
  publicPath: null,
  automatedCheck: null,
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
  [`GET /assets/${WB}/capture-sessions`]: { json: { items: [] } },
  [`GET /assets/${WB}/remote-checks`]: { json: { items: [] } },
  "GET /templates": { json: { items: [] } },
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.phantom;
});

describe("public passport", () => {
  it("states that automated checks passed, and when", async () => {
    mockFetch({
      "GET /auth/me": unauthenticated,
      [`GET /passport/${WB}`]: {
        json: {
          passport: passport({
            automatedChecks: { filesPassed: 2, lastPassedAt: "2026-09-29T12:00:00.000Z" },
          }),
          url: "",
        },
      },
    });
    renderAt(`/passport/${WB}`);
    expect(await screen.findByText("Automated checks passed")).toBeTruthy();
    expect(screen.getByText(/2 photos and documents/)).toBeTruthy();
  });

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

  it("shows AI check results and that the checks are on", async () => {
    mockFetch({
      ...ownerRoutes(asset()),
      [`GET /assets/${WB}/evidence`]: {
        json: {
          items: [
            evidence({
              automatedCheck: {
                status: "FAILED",
                problems: ["SCREEN_OR_PRINT"],
                checkedAt: "2026-09-29T10:05:00.000Z",
              },
            }),
          ],
        },
      },
      [`GET /assets/${WB}/automated-checks`]: { json: { available: true } },
    });
    renderAt(`/assets/${WB}`);
    await screen.findByText("AI check failed");
    expect(screen.getByText("This looks like a photo of a screen or a print")).toBeTruthy();
    await screen.findByText("AI checks on");
    expect(screen.queryByText("Turn off")).toBeNull();
  });

  it("hides the AI checks when they are not available", async () => {
    mockFetch({
      ...ownerRoutes(asset()),
      [`GET /assets/${WB}/evidence`]: { json: { items: [evidence()] } },
      [`GET /assets/${WB}/automated-checks`]: { json: { available: false } },
    });
    renderAt(`/assets/${WB}`);
    await screen.findByText("front.jpg", { exact: false });
    expect(screen.queryByText("AI checks on")).toBeNull();
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

  it("lists failed AI checks with their details and filters by asset", async () => {
    const check = {
      id: "c1",
      evidenceId: "e1",
      result: "FAILED",
      problems: ["SCREEN_OR_PRINT"],
      summary: "Moire pattern across the dial.",
      confidence: 0.85,
      engine: "openai",
      model: "gpt-6.1-sol",
      checkVersion: "evidence-check-v1",
      sha256: "a".repeat(64),
      createdAt: "2026-09-29T10:00:00.000Z",
      wbId: WB,
      evidence: { type: "PHOTO", mimeType: "image/jpeg", reviewStatus: "PENDING" },
    };
    const calls = mockFetch({
      "GET /auth/me": { json: me(["USER", "ADMIN"]) },
      "GET /admin/automated-checks?limit=100&result=FAILED": {
        json: { items: [check], nextCursor: null },
      },
      [`GET /admin/assets/${WB}/automated-checks`]: { json: { items: [check] } },
    });
    renderAt("/admin/checks");
    expect(await screen.findByText("Moire pattern across the dial.")).toBeTruthy();
    expect(screen.getByText(/confidence 85%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: WB }));
    await waitFor(() =>
      expect(calls.map((c) => c.url)).toContain(`/admin/assets/${WB}/automated-checks`),
    );
  });

  it("shows the advisory AI report and requests a new one", async () => {
    const report = {
      id: "r1",
      recommendation: "NEEDS_MORE_INFORMATION",
      summary: "An established watch laboratory.",
      strengths: ["Specialised in Swiss watches"],
      concerns: ["No certifications named"],
      questions: ["Ask for a sample report"],
      sources: ["https://lab.example/about"],
      engine: "openai",
      model: "gpt-6.1-sol",
      reportVersion: "verifier-report-v1",
      createdAt: "2026-09-29T10:00:00.000Z",
    };
    let pending = false;
    const calls = mockFetch({
      "GET /auth/me": { json: me(["USER", "ADMIN"]) },
      [`GET /review/verifiers/${VID}`]: { json: applicant() },
      [`GET /review/verifiers/${VID}/ai-reports`]: () => ({
        json: { available: true, pending, lastError: null, items: [report] },
      }),
      [`POST /review/verifiers/${VID}/ai-reports`]: () => (
        (pending = true),
        { status: 202, json: { available: true, pending, lastError: null, items: [report] } }
      ),
    });
    renderAt(`/admin/verifiers/${VID}`);
    expect(await screen.findByText("Needs more information")).toBeTruthy();
    expect(screen.getByText("No certifications named")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://lab.example/about" })).toBeTruthy();
    fireEvent.click(screen.getByText("Write a new report"));
    await screen.findByText(/Writing a report/);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `/review/verifiers/${VID}/ai-reports`,
    ]);
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

describe("guided capture", () => {
  const session = (taken: string[] = []): CaptureSession => ({
    id: "0199a000-0000-7000-8000-000000000c01",
    code: "H4RT9Z",
    status: "OPEN",
    shots: [
      { shot: "DIAL", instruction: "The dial, face on" },
      { shot: "CODE", instruction: "The item next to the code written on paper" },
    ].map((s) => ({
      ...(s as { shot: CaptureShot; instruction: string }),
      evidenceId: taken.includes(s.shot)
        ? `0199a000-0000-7000-8000-00000000e0${s.shot.length}`
        : null,
      receivedAt: taken.includes(s.shot) ? "2026-09-30T10:01:00.000Z" : null,
    })),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    completedAt: null,
    createdAt: "2026-09-30T10:00:00.000Z",
  });

  /** A camera that delivers 640×480 frames, and a canvas that turns them into a JPEG. */
  const camera = () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2])], { type: "image/jpeg" })),
    );
    return { getUserMedia, stop };
  };
  afterEach(() => vi.restoreAllMocks());

  it("starts a session, shows the code and uploads each shot from the camera", async () => {
    const { getUserMedia, stop } = camera();
    let state: CaptureSession[] = [];
    const calls = mockFetch({
      ...ownerRoutes(asset()),
      [`GET /assets/${WB}/capture-sessions`]: () => ({ json: { items: state } }),
      [`POST /assets/${WB}/capture-sessions`]: () => (
        (state = [session()]),
        { status: 201, json: state[0] }
      ),
      [`POST /assets/${WB}/evidence/uploads`]: {
        status: 201,
        json: {
          uploadId: "up1",
          upload: { url: "https://r2.example/bucket/staging/up1", method: "PUT", headers: {} },
          expiresAt: "",
        },
      },
      "PUT https://r2.example/bucket/staging/up1": { json: undefined },
      "POST /evidence/uploads/up1/complete": () => {
        state = [
          state[0]?.shots[0]?.evidenceId
            ? {
                ...session(["DIAL", "CODE"]),
                status: "COMPLETED",
                completedAt: "2026-09-30T10:02:00.000Z",
              }
            : session(["DIAL"]),
        ];
        return { status: 201, json: evidence({ captureShot: "DIAL" }) };
      },
    });
    renderAt(`/assets/${WB}`);
    fireEvent.click(await screen.findByText("Start guided capture"));
    expect(await screen.findByText("H4RT9Z")).toBeTruthy();
    expect(screen.getByText(/Expires in \d+:\d\d/)).toBeTruthy();
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({ facingMode: "environment" }),
      }),
    );

    fireEvent.click(await screen.findByText("Take photo: Dial"));
    expect(await screen.findByText("Take photo: Code")).toBeTruthy();
    const request = calls.find((c) => c.url === `/assets/${WB}/evidence/uploads`);
    expect(request?.body).toMatchObject({
      type: "PHOTO",
      mimeType: "image/jpeg",
      sizeBytes: 5,
      originalFilename: "dial.jpg",
      captureSessionId: session().id,
      captureShot: "DIAL",
    });
    expect(request?.body).not.toHaveProperty("capturedAt");
    expect(calls.some((c) => c.method === "PUT")).toBe(true);

    fireEvent.click(screen.getByText("Take photo: Code"));
    expect(await screen.findByText(/Last completed/)).toBeTruthy();
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it("explains when the browser has no camera", async () => {
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: undefined });
    mockFetch({
      ...ownerRoutes(asset()),
      [`GET /assets/${WB}/capture-sessions`]: { json: { items: [session()] } },
    });
    renderAt(`/assets/${WB}`);
    expect(await screen.findByText(/no camera access/)).toBeTruthy();
    expect((screen.getByText("Take photo: Dial") as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks evidence taken in a session", async () => {
    mockFetch({
      ...ownerRoutes(asset()),
      [`GET /assets/${WB}/evidence`]: { json: { items: [evidence({ captureShot: "CASEBACK" })] } },
    });
    renderAt(`/assets/${WB}`);
    expect(await screen.findByText("Guided capture: Caseback")).toBeTruthy();
  });
});

describe("checks before buying", () => {
  const ID = "0199a000-0000-7000-8000-0000000000c9";
  const check = (overrides: Partial<PurchaseCheck> = {}): PurchaseCheck => ({
    id: ID,
    kind: "IN_PERSON",
    status: "OPEN",
    asset: {
      wbId: WB,
      category: "LUXURY_WATCH",
      brand: "Rolex",
      model: "Submariner",
      status: "VERIFIED",
      verificationLevel: "PROFESSIONALLY_VERIFIED" as PurchaseCheck["asset"]["verificationLevel"],
      transferBlocked: false,
    },
    owner: {
      confirmed: false,
      confirmedAt: null,
      code: "K7P2QX",
      codeExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      message: `WorthyBound: I confirm to a buyer that I own ${WB}.\nCode: K7P2QX`,
      codeCheck: null,
    },
    item: {
      shots: [
        { shot: "DIAL", instruction: "The dial, face on", receivedAt: null },
        { shot: "SIDE", instruction: "The side", receivedAt: null },
      ],
      comparing: false,
      videoAvailable: false,
      result: null,
      reason: null,
      checkedAt: null,
      recordedPhotos: [],
    },
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts a check from the passport", async () => {
    mockFetch({
      "GET /auth/me": { json: me() },
      [`GET /passport/${WB}`]: { json: { passport: passport(), url: "" } },
      [`POST /assets/${WB}/purchase-checks`]: { status: 201, json: check() },
      [`GET /purchase-checks/${ID}`]: { json: check() },
    });
    renderAt(`/passport/${WB}`);
    fireEvent.click(await screen.findByText("Start a check"));
    expect(await screen.findByText("K7P2QX")).toBeTruthy();
    expect(window.location.pathname).toBe(`/checks/${ID}`);
    expect(screen.getByText(/Expires in \d+:\d\d/)).toBeTruthy();
  });

  it("uploads each photo from the camera and shows the result", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" })),
    );
    const confirmed = {
      confirmed: true,
      confirmedAt: "2026-09-30T10:01:00.000Z",
      code: null,
      codeExpiresAt: null,
      message: null,
      codeCheck: null,
    };
    const shots = (taken: string[]) =>
      check().item.shots.map((s) => ({
        ...s,
        receivedAt: taken.includes(s.shot) ? "2026-09-30T10:02:00.000Z" : null,
      }));
    const first = check({ owner: confirmed });
    const routes = {
      "GET /auth/me": { json: me() },
      [`GET /purchase-checks/${ID}`]: { json: first },
      [`POST /purchase-checks/${ID}/photos/DIAL`]: {
        json: check({ owner: confirmed, item: { ...check().item, shots: shots(["DIAL"]) } }),
      },
    };
    const sent = mockFetch(routes);
    renderAt(`/checks/${ID}`);
    expect(await screen.findByText("Confirmed current owner")).toBeTruthy();
    fireEvent.click(await screen.findByText("Take photo: Dial"));
    expect(await screen.findByText("Take photo: Side")).toBeTruthy();
    const upload = sent.find((c) => c.url === `/purchase-checks/${ID}/photos/DIAL`);
    expect(upload?.headers["content-type"]).toBe("image/jpeg");
    expect(upload?.body).toBeInstanceOf(Blob);
    expect(screen.getByAltText("Dial").getAttribute("src")).toBe(
      `/purchase-checks/${ID}/photos/DIAL`,
    );
  });

  it("warns when the item does not match or cannot be transferred", async () => {
    mockFetch({
      "GET /auth/me": { json: me() },
      [`GET /purchase-checks/${ID}`]: {
        json: check({
          status: "COMPLETED",
          asset: { ...check().asset, status: "REPORTED_STOLEN", transferBlocked: true },
          owner: { ...check().owner, code: null, codeExpiresAt: null, message: null },
          item: {
            ...check().item,
            result: "NO_MATCH",
            recordedPhotos: [{ path: `/passport/${WB}/evidence/e1` }],
          },
        }),
      },
    });
    renderAt(`/checks/${ID}`);
    expect((await screen.findByRole("alert")).textContent).toMatch(/reported stolen.*Do not buy/);
    expect(screen.getByText(/does not match the recorded item/)).toBeTruthy();
    expect(screen.getByText("The seller did not confirm ownership.")).toBeTruthy();
  });

  it("lets the owner sign a buyer's code with their wallet", async () => {
    const signMessage = vi.fn(async (_message: Uint8Array) => ({
      signature: new Uint8Array(64).fill(7),
    }));
    window.phantom = {
      solana: {
        connect: async () => ({ publicKey: { toString: () => me().user.walletAddress } }),
        signMessage,
      },
    };
    const calls = mockFetch({
      ...ownerRoutes(asset()),
      [`POST /assets/${WB}/owner-confirmations`]: {
        json: { confirmed: true, confirmedAt: "2026-09-30T10:01:00.000Z" },
      },
    });
    renderAt(`/assets/${WB}`);
    const input = await screen.findByPlaceholderText("e.g. K7P2QX");
    fireEvent.change(input, { target: { value: "k7p 2qx" } });
    fireEvent.click(screen.getByText("Confirm to buyer"));
    expect(await screen.findByText(/Confirmed. The buyer/)).toBeTruthy();
    expect(new TextDecoder().decode(signMessage.mock.calls[0]?.[0] as Uint8Array)).toBe(
      `WorthyBound: I confirm to a buyer that I own ${WB}.\nCode: K7P2QX`,
    );
    const sent = calls.find((c) => c.url === `/assets/${WB}/owner-confirmations`);
    expect(sent?.body).toEqual({
      code: "K7P2QX",
      signature: expect.stringMatching(/^[1-9A-Za-z]+$/),
    });
  });

  describe("remotely", () => {
    const remote = (overrides: Partial<PurchaseCheck> = {}): PurchaseCheck =>
      check({
        kind: "REMOTE",
        owner: {
          confirmed: false,
          confirmedAt: null,
          code: "K7P2QX",
          codeExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          message: null,
          codeCheck: null,
        },
        item: {
          ...check().item,
          shots: [
            { shot: "DIAL", instruction: "The dial, face on", receivedAt: null },
            {
              shot: "VIDEO",
              instruction: "A short video turning the item around",
              receivedAt: null,
            },
          ],
        },
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        ...overrides,
      });

    const request = (session: CaptureSession | null = null, filmed = false) => ({
      id: ID,
      code: "K7P2QX",
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      filmed,
      session,
      createdAt: "2026-09-30T10:00:00.000Z",
    });
    const filming = (taken: string[] = []): CaptureSession => ({
      id: "0199a000-0000-7000-8000-000000000c02",
      code: "K7P2QX",
      status: taken.length === 2 ? "COMPLETED" : "OPEN",
      shots: (["DIAL", "VIDEO"] as CaptureShot[]).map((shot) => ({
        shot,
        instruction:
          shot === "DIAL" ? "The dial, face on" : "A short video turning the item around",
        evidenceId: taken.includes(shot)
          ? `0199a000-0000-7000-8000-00000000e0${shot.length}`
          : null,
        receivedAt: taken.includes(shot) ? "2026-09-30T10:01:00.000Z" : null,
      })),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      completedAt: taken.length === 2 ? "2026-09-30T10:02:00.000Z" : null,
      createdAt: "2026-09-30T10:00:00.000Z",
    });

    /** A camera, and a recorder that delivers an 8-byte MP4 when stopped. */
    const recording = (mp4 = true) => {
      vi.stubGlobal("navigator", {
        ...navigator,
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
        },
      });
      vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
      vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage: vi.fn(),
      } as never);
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
        callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" })),
      );
      const options: MediaRecorderOptions[] = [];
      class FakeRecorder {
        static isTypeSupported = (type: string) => mp4 && type.startsWith("video/mp4");
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        constructor(_stream: unknown, init: MediaRecorderOptions) {
          options.push(init);
        }
        start() {}
        stop() {
          this.ondataavailable?.({ data: new Blob([new Uint8Array(8)], { type: "video/mp4" }) });
          this.onstop?.();
        }
      }
      vi.stubGlobal("MediaRecorder", FakeRecorder);
      return options;
    };

    it("requests a remote check from the passport", async () => {
      mockFetch({
        "GET /auth/me": { json: me() },
        [`GET /passport/${WB}`]: { json: { passport: passport(), url: "" } },
        [`POST /assets/${WB}/remote-checks`]: { status: 201, json: remote() },
        [`GET /purchase-checks/${ID}`]: { json: remote() },
      });
      renderAt(`/passport/${WB}`);
      fireEvent.click(await screen.findByText("Request a remote check"));
      expect(await screen.findByText("K7P2QX")).toBeTruthy();
      expect(window.location.pathname).toBe(`/checks/${ID}`);
      expect(screen.getByText(/Open until/)).toBeTruthy();
      expect(screen.queryByText(/Take photo/)).toBeNull();
    });

    it("shows the buyer the seller's progress, then the code check, video and result", async () => {
      let current = remote({
        item: {
          ...remote().item,
          shots: remote().item.shots.map((s, i) => ({
            ...s,
            receivedAt: i === 0 ? "2026-09-30T10:01:00.000Z" : null,
          })),
        },
      });
      mockFetch({
        "GET /auth/me": { json: me() },
        [`GET /purchase-checks/${ID}`]: () => ({ json: current }),
        [`POST /purchase-checks/${ID}/video`]: {
          json: { url: "https://r2.example/bucket/remote-check-videos/v", expiresAt: "" },
        },
      });
      const view = renderAt(`/checks/${ID}`);
      expect(await screen.findByText(/The seller is filming: 1 of 2/)).toBeTruthy();
      expect(screen.queryByText("Watch the seller's video")).toBeNull();
      view.unmount();

      current = remote({
        status: "COMPLETED",
        owner: {
          ...remote().owner,
          confirmed: true,
          confirmedAt: "2026-09-30T10:02:00.000Z",
          codeExpiresAt: null,
          codeCheck: "SHOWN",
        },
        item: { ...remote().item, videoAvailable: true, result: "MATCH" },
      });
      renderAt(`/checks/${ID}`);
      expect(await screen.findByText("Confirmed current owner")).toBeTruthy();
      expect(screen.getByText(/shows your code next to the item/)).toBeTruthy();
      expect(screen.getByText("The filmed item matches the recorded item.")).toBeTruthy();
      fireEvent.click(screen.getByText("Watch the seller's video"));
      await waitFor(() =>
        expect(document.querySelector("video.check-video")?.getAttribute("src")).toBe(
          "https://r2.example/bucket/remote-check-videos/v",
        ),
      );
    });

    it("warns the buyer when the seller's photo shows another code", async () => {
      mockFetch({
        "GET /auth/me": { json: me() },
        [`GET /purchase-checks/${ID}`]: {
          json: remote({
            owner: { ...remote().owner, confirmed: true, codeCheck: "MISMATCH" },
          }),
        },
      });
      renderAt(`/checks/${ID}`);
      expect(await screen.findByText(/shows a different code/)).toBeTruthy();
    });

    it("lets the owner film the item for a buyer: photos, then a video", async () => {
      const options = recording();
      let state = request();
      let uploads = 0;
      const calls = mockFetch({
        ...ownerRoutes(asset()),
        [`GET /assets/${WB}/remote-checks`]: () => ({ json: { items: [state] } }),
        [`POST /assets/${WB}/remote-checks/${ID}/capture-session`]: () => (
          (state = request(filming())),
          { status: 201, json: filming() }
        ),
        [`POST /assets/${WB}/evidence/uploads`]: {
          status: 201,
          json: {
            uploadId: "up1",
            upload: { url: "https://r2.example/bucket/staging/up1", method: "PUT", headers: {} },
            expiresAt: "",
          },
        },
        "PUT https://r2.example/bucket/staging/up1": { json: undefined },
        "POST /evidence/uploads/up1/complete": () => {
          uploads++;
          state =
            uploads === 1 ? request(filming(["DIAL"])) : request(filming(["DIAL", "VIDEO"]), true);
          return { status: 201, json: evidence() };
        },
      });
      renderAt(`/assets/${WB}`);
      expect(await screen.findByText("Remote checks from buyers")).toBeTruthy();
      fireEvent.click(screen.getByText("Film for this buyer"));
      const enabled = async (text: string) => {
        const button = (await screen.findByText(text)) as HTMLButtonElement;
        await waitFor(() => expect(button.disabled).toBe(false));
        return button;
      };
      fireEvent.click(await enabled("Take photo: Dial"));
      fireEvent.click(await enabled("Start recording"));
      fireEvent.click(await screen.findByText(/Stop and upload \(0:00 \/ 1:00\)/));
      expect(await screen.findByText(/Filmed. The buyer can watch/)).toBeTruthy();

      expect(options[0]).toMatchObject({ mimeType: "video/mp4;codecs=avc1" });
      const [photo, video] = calls.filter((c) => c.url === `/assets/${WB}/evidence/uploads`);
      expect(photo?.body).toMatchObject({ type: "PHOTO", captureShot: "DIAL" });
      expect(video?.body).toMatchObject({
        type: "VIDEO",
        mimeType: "video/mp4",
        sizeBytes: 8,
        originalFilename: "video.mp4",
        captureSessionId: filming().id,
        captureShot: "VIDEO",
      });
    });

    it("explains when the browser cannot record MP4 video", async () => {
      recording(false);
      mockFetch({
        ...ownerRoutes(asset()),
        [`GET /assets/${WB}/remote-checks`]: {
          json: { items: [request(filming(["DIAL"]))] },
        },
      });
      renderAt(`/assets/${WB}`);
      expect(await screen.findByText(/cannot record MP4 video/)).toBeTruthy();
      expect((screen.getByText("Start recording") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("asks for photos of the package with the seller's code on delivery, and shows the result", async () => {
    const receipt = (overrides: Partial<PurchaseCheck> = {}) =>
      check({
        kind: "RECEIPT",
        owner: { ...check().owner, code: "PK4Z9M", message: null },
        item: {
          ...check().item,
          shots: [
            { shot: "PACKAGE", instruction: "The sealed package with the code", receivedAt: null },
            { shot: "DIAL", instruction: "The dial, face on", receivedAt: null },
          ],
        },
        ...overrides,
      });
    let state = receipt();
    mockFetch({
      "GET /auth/me": { json: me() },
      [`GET /purchase-checks/${ID}`]: () => ({ json: state }),
    });
    renderAt(`/checks/${ID}`);
    expect(await screen.findByText("PK4Z9M")).toBeTruthy();
    expect(screen.getByText(/Check on delivery/)).toBeTruthy();
    expect(screen.queryByText("1. The seller")).toBeNull();
    expect(screen.getByText("Take photo: Package")).toBeTruthy();

    cleanup();
    state = receipt({
      status: "COMPLETED",
      item: { ...receipt().item, result: "NO_MATCH", checkedAt: "2026-09-30T10:05:00.000Z" },
    });
    renderAt(`/checks/${ID}`);
    expect(await screen.findByText(/The payment is held for an administrator/)).toBeTruthy();
  });
});

describe("transfers", () => {
  const ME = me().user.walletAddress;
  const BUYER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
  const transfer = (overrides: Partial<Transfer> = {}): Transfer => ({
    id: "0199a000-0000-7000-8000-0000000000t1",
    role: "RECIPIENT",
    status: "PENDING",
    closedReason: null,
    asset: { wbId: WB, category: "LUXURY_WATCH", brand: "Rolex", model: "Submariner" },
    fromWalletAddress: BUYER,
    toWalletAddress: ME,
    priceLamports: "0",
    delivery: "IN_PERSON",
    escrow: null,
    transaction: null,
    signedBySeller: false,
    signedByBuyer: false,
    awaitingYourSignature: false,
    chain: null,
    expiresAt: "2026-10-03T10:00:00.000Z",
    acceptedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  });
  const unregister: (() => void)[] = [];
  /** Registers a Wallet Standard wallet with one account, as Phantom does. */
  const standardWallet = (address: string) => {
    const signTransaction = vi.fn(async (..._inputs: unknown[]) => [
      { signedTransaction: new Uint8Array([9, 9]) },
    ]);
    const wallet = {
      name: "Test wallet",
      accounts: [{ address }],
      features: { "solana:signTransaction": { signTransaction } },
    };
    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", {
        detail: (api: { register: (w: unknown) => () => void }) =>
          unregister.push(api.register(wallet)),
      }),
    );
    return signTransaction;
  };
  afterEach(() => unregister.splice(0).forEach((u) => u()));

  it("starts a transfer of a tokenized asset from its page", async () => {
    let state = asset({ tokenizationStatus: "TOKENIZED" });
    const calls = mockFetch({
      ...ownerRoutes(state),
      [`GET /assets/${WB}`]: () => ({ json: state }),
      "POST /transfers": () => (
        (state = asset({ tokenizationStatus: "TOKENIZED", status: "TRANSFER_PENDING" })),
        { status: 201, json: transfer({ role: "SENDER" }) }
      ),
    });
    renderAt(`/assets/${WB}`);
    fireEvent.change(await screen.findByLabelText("Transfer to wallet"), {
      target: { value: ` ${BUYER} ` },
    });
    const price = screen.getByLabelText("Price in SOL (optional)");
    fireEvent.change(price, { target: { value: "1.0000000001" } });
    expect(screen.getByText(/at most 9 decimals/)).toBeTruthy();
    expect((screen.getByText("Start transfer") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(price, { target: { value: "2.5" } });
    fireEvent.click(screen.getByText("Start transfer"));
    expect(await screen.findByText(/A transfer of this item is open/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.url === "/transfers")?.body).toEqual({
      assetId: WB,
      toWalletAddress: BUYER,
      priceLamports: "2500000000",
      delivery: "IN_PERSON",
    });
  });

  it("shows the price the buyer pays when signing", async () => {
    mockFetch({
      "GET /auth/me": { json: me() },
      "GET /transfers": {
        json: {
          items: [
            transfer({
              status: "ACCEPTED",
              transaction: "AQID",
              awaitingYourSignature: true,
              priceLamports: "2500000001",
            }),
          ],
        },
      },
    });
    renderAt("/transfers");
    expect(await screen.findByText(/Price 2\.500000001 SOL/)).toBeTruthy();
    expect(screen.getByText(/Your wallet pays 2\.500000001 SOL to the seller/)).toBeTruthy();
  });

  it("offers no transfer before the asset is tokenized", async () => {
    mockFetch(ownerRoutes(asset()));
    renderAt(`/assets/${WB}`);
    await screen.findByText("Tokenize on Solana devnet");
    expect(screen.queryByText("Start transfer")).toBeNull();
  });

  it("lets the recipient accept, then signs the prepared transaction with the wallet", async () => {
    const signTransaction = standardWallet(ME);
    let state = transfer();
    const calls = mockFetch({
      "GET /auth/me": { json: me() },
      "GET /transfers": () => ({ json: { items: [state] } }),
      [`POST /transfers/${state.id}/accept`]: () => (
        (state = transfer({
          status: "ACCEPTED",
          transaction: "AQID",
          awaitingYourSignature: true,
          signedBySeller: true,
        })),
        { json: state }
      ),
      [`POST /transfers/${state.id}/signature`]: () => (
        (state = transfer({
          status: "ACCEPTED",
          signedBySeller: true,
          signedByBuyer: true,
          chain: { status: "PENDING", signature: null },
        })),
        { json: state }
      ),
    });
    renderAt("/transfers");
    fireEvent.click(await screen.findByText("Accept"));
    fireEvent.click(await screen.findByText("Sign with wallet"));
    expect(await screen.findByText("Completing the transfer on Solana…")).toBeTruthy();
    expect(signTransaction).toHaveBeenCalledWith({
      account: { address: ME },
      transaction: new Uint8Array([1, 2, 3]),
      chain: "solana:devnet",
    });
    expect(calls.find((c) => c.url.endsWith("/signature"))?.body).toEqual({
      signedTransaction: "CQk=",
    });
    expect(screen.queryByText("Cancel transfer")).toBeNull();
  });

  it("asks to switch accounts when the wallet has another account", async () => {
    const signTransaction = standardWallet(BUYER);
    mockFetch({
      "GET /auth/me": { json: me() },
      "GET /transfers": {
        json: {
          items: [
            transfer({ status: "ACCEPTED", transaction: "AQID", awaitingYourSignature: true }),
          ],
        },
      },
    });
    renderAt("/transfers");
    fireEvent.click(await screen.findByText("Sign with wallet"));
    expect(await screen.findByText(/Switch your wallet to the account/)).toBeTruthy();
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("lets the seller cancel, and shows completed and closed transfers", async () => {
    const open = transfer({
      id: "0199a000-0000-7000-8000-0000000000t2",
      role: "SENDER",
      fromWalletAddress: ME,
      toWalletAddress: BUYER,
    });
    const calls = mockFetch({
      "GET /auth/me": { json: me() },
      "GET /transfers": {
        json: {
          items: [
            open,
            transfer({
              status: "COMPLETED",
              completedAt: "2026-09-30T12:00:00.000Z",
              chain: {
                status: "CONFIRMED",
                signature: "5VERYLONGSIGNATUREabcdefghijkmnopqrstuvwxyz",
              },
            }),
            transfer({
              id: "0199a000-0000-7000-8000-0000000000t3",
              status: "CANCELLED",
              closedReason: "cancelled_by_sender",
            }),
          ],
        },
      },
      [`POST /transfers/${open.id}/cancel`]: { json: { ...open, status: "CANCELLED" } },
    });
    vi.stubGlobal("confirm", () => true);
    renderAt("/transfers");
    expect(await screen.findByText("Waiting for the buyer to accept.")).toBeTruthy();
    expect(screen.getByText("5VER…wxyz ↗")).toBeTruthy();
    expect(screen.getByText("View asset")).toBeTruthy();
    expect(screen.getByText("Cancelled by the seller.")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel transfer"));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/cancel"))).toBe(true),
    );
  });

  describe("shipped, with the price in escrow", () => {
    const PRICE = "2500000000";
    const escrow = (overrides: Partial<TransferEscrow> = {}): TransferEscrow => ({
      status: "AWAITING_PAYMENT",
      paymentTransaction: null,
      awaitingYourPayment: false,
      payment: null,
      refund: null,
      paidAt: null,
      shipBy: null,
      shipmentSessionId: null,
      shipmentFilmed: false,
      shippedAt: null,
      carrier: null,
      trackingNumber: null,
      deliveryDueAt: null,
      deliveryExtensions: 0,
      deliveredAt: null,
      receiptCheckId: null,
      releaseAt: null,
      disputedAt: null,
      disputeReason: null,
      resolution: null,
      resolvedAt: null,
      ...overrides,
    });
    const shipped = (e: Partial<TransferEscrow>, overrides: Partial<Transfer> = {}) =>
      transfer({
        status: "ACCEPTED",
        priceLamports: PRICE,
        delivery: "SHIPPED",
        signedBySeller: true,
        signedByBuyer: true,
        escrow: escrow(e),
        ...overrides,
      });
    const seller = { role: "SENDER" as const, fromWalletAddress: ME, toWalletAddress: BUYER };
    const paid = {
      status: "PAID" as const,
      paidAt: "2026-09-30T10:00:00.000Z",
      shipBy: "2026-10-03T10:00:00.000Z",
    };

    it("starts a shipped transfer only with a price", async () => {
      const state = asset({ tokenizationStatus: "TOKENIZED" });
      const calls = mockFetch({
        ...ownerRoutes(state),
        "POST /transfers": { status: 201, json: transfer({ role: "SENDER" }) },
      });
      renderAt(`/assets/${WB}`);
      fireEvent.change(await screen.findByLabelText("Transfer to wallet"), {
        target: { value: BUYER },
      });
      fireEvent.change(screen.getByLabelText("Delivery"), { target: { value: "SHIPPED" } });
      expect(screen.getByText(/The buyer pays the price into escrow/)).toBeTruthy();
      expect((screen.getByText("Start transfer") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Price in SOL"), { target: { value: "2.5" } });
      fireEvent.click(screen.getByText("Start transfer"));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "POST" && c.url === "/transfers")?.body).toEqual({
          assetId: WB,
          toWalletAddress: BUYER,
          priceLamports: PRICE,
          delivery: "SHIPPED",
        }),
      );
    });

    it("lets the buyer pay into escrow once both signed, and sign again after a failed payment", async () => {
      const signTransaction = standardWallet(ME);
      let state = shipped({
        awaitingYourPayment: true,
        paymentTransaction: "AQID",
        payment: { status: "FAILED", signature: null },
      });
      const calls = mockFetch({
        "GET /auth/me": { json: me() },
        "GET /transfers": () => ({ json: { items: [state] } }),
        [`POST /transfers/${state.id}/payment`]: () => (
          (state = shipped({ payment: { status: "PENDING", signature: null } })),
          { json: state }
        ),
      });
      renderAt("/transfers");
      expect(await screen.findByText(/Your last payment did not go through/)).toBeTruthy();
      fireEvent.click(screen.getByText("Pay 2.5 SOL into escrow"));
      expect(await screen.findByText("Sending your payment to escrow on Solana…")).toBeTruthy();
      expect(signTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ transaction: new Uint8Array([1, 2, 3]) }),
      );
      expect(calls.find((c) => c.url.endsWith("/payment"))?.body).toEqual({
        signedTransaction: "CQk=",
      });
      expect(screen.queryByText("Cancel transfer")).toBeNull();
    });

    it("has the seller film the item and the package, then ship", async () => {
      const session: CaptureSession = {
        id: "0199a000-0000-7000-8000-0000000000s1",
        code: "PK4Z9M",
        status: "OPEN",
        shots: [
          { shot: "DIAL", instruction: "The dial, face on", evidenceId: null, receivedAt: null },
          {
            shot: "PACKAGE",
            instruction: "The sealed package with the code",
            evidenceId: null,
            receivedAt: null,
          },
        ],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        completedAt: null,
        createdAt: "2026-09-30T10:00:00.000Z",
      };
      let state = shipped(paid, seller);
      const calls = mockFetch({
        "GET /auth/me": { json: me() },
        "GET /transfers": () => ({ json: { items: [state] } }),
        [`POST /transfers/${state.id}/shipment-session`]: () => (
          (state = shipped({ ...paid, shipmentSessionId: session.id }, seller)),
          { status: 201, json: session }
        ),
        [`GET /transfers/${state.id}/shipment-session`]: { json: session },
        [`POST /transfers/${state.id}/shipment`]: () => (
          (state = shipped(
            {
              ...paid,
              status: "SHIPPED",
              shipmentFilmed: true,
              shippedAt: "2026-09-30T12:00:00.000Z",
              carrier: "DHL",
              trackingNumber: "JD014",
              deliveryDueAt: "2026-10-21T12:00:00.000Z",
            },
            seller,
          )),
          { json: state }
        ),
      });
      renderAt("/transfers");
      expect(await screen.findByText(/Ship by/)).toBeTruthy();
      expect(screen.getByText("Cancel and refund")).toBeTruthy();
      fireEvent.click(screen.getByText("Film the item and the package"));
      expect(await screen.findByText("PK4Z9M", {}, { timeout: 3000 })).toBeTruthy();
      expect(screen.getByText(/Write this code on the package/)).toBeTruthy();
      expect(screen.queryByLabelText("Carrier")).toBeNull();

      cleanup();
      state = shipped({ ...paid, shipmentSessionId: session.id, shipmentFilmed: true }, seller);
      renderAt("/transfers");
      expect(await screen.findByText("Item and package filmed ✓")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Carrier"), { target: { value: "DHL" } });
      fireEvent.change(screen.getByLabelText("Tracking number"), { target: { value: " JD014 " } });
      fireEvent.click(screen.getByText("Mark as shipped"));
      expect(await screen.findByText("JD014")).toBeTruthy();
      expect(calls.find((c) => c.url.endsWith("/shipment"))?.body).toEqual({
        carrier: "DHL",
        trackingNumber: "JD014",
      });
      expect(screen.queryByText("Cancel and refund")).toBeNull();
    });

    it("lets the buyer confirm delivery, wait longer or report a problem", async () => {
      const inTransit = {
        ...paid,
        status: "SHIPPED" as const,
        shipmentFilmed: true,
        shippedAt: "2026-09-30T12:00:00.000Z",
        carrier: "DHL",
        trackingNumber: "JD014",
        deliveryDueAt: new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString(),
      };
      let state = shipped(inTransit);
      const calls = mockFetch({
        "GET /auth/me": { json: me() },
        "GET /transfers": () => ({ json: { items: [state] } }),
        [`POST /transfers/${state.id}/extend`]: { json: shipped(inTransit) },
        [`POST /transfers/${state.id}/dispute`]: () => (
          (state = shipped({ ...inTransit, status: "DISPUTED", disputeReason: "Box crushed" })),
          { json: state }
        ),
        [`POST /transfers/${state.id}/delivered`]: () => (
          (state = shipped({
            ...inTransit,
            status: "DELIVERED",
            deliveredAt: "2026-10-02T12:00:00.000Z",
            releaseAt: "2026-10-09T12:00:00.000Z",
            receiptCheckId: "0199a000-0000-7000-8000-0000000000c9",
          })),
          { json: state }
        ),
      });
      renderAt("/transfers");
      expect(await screen.findByText(/Expected by/)).toBeTruthy();
      // Before the delivery period ends, the buyer waits or reports a problem.
      expect(screen.queryByText("Cancel and refund")).toBeNull();
      fireEvent.click(screen.getByText("Wait 7 more days"));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/extend"))).toBe(true));

      fireEvent.click(screen.getByText("Report a problem"));
      fireEvent.change(screen.getByLabelText("What is wrong?"), {
        target: { value: "Box crushed" },
      });
      fireEvent.click(screen.getByText("Report problem"));
      expect(await screen.findByText(/the buyer reported “Box crushed”/)).toBeTruthy();

      cleanup();
      state = shipped(inTransit);
      renderAt("/transfers");
      fireEvent.click(await screen.findByText("I received it"));
      const link = await screen.findByText("Photograph the package and the item");
      expect(link.getAttribute("href")).toBe("/checks/0199a000-0000-7000-8000-0000000000c9");
    });

    it("lets the buyer cancel for a refund once the delivery period passed", async () => {
      mockFetch({
        "GET /auth/me": { json: me() },
        "GET /transfers": {
          json: {
            items: [
              shipped({
                ...paid,
                status: "SHIPPED",
                shippedAt: "2026-09-01T12:00:00.000Z",
                deliveryDueAt: "2026-09-22T12:00:00.000Z",
                deliveryExtensions: 3,
              }),
              shipped(
                {
                  ...paid,
                  status: "REFUNDED",
                  refund: {
                    status: "CONFIRMED",
                    signature: "5REFUNDSIGNATUREabcdefghijkmnopqrstuvwxyz",
                  },
                },
                {
                  id: "0199a000-0000-7000-8000-0000000000t4",
                  status: "CANCELLED",
                  closedReason: "not_shipped",
                },
              ),
            ],
          },
        },
      });
      renderAt("/transfers");
      expect(await screen.findByText(/The delivery period ended/)).toBeTruthy();
      expect(screen.getByText("Cancel and refund")).toBeTruthy();
      expect(screen.queryByText("Wait 7 more days")).toBeNull();
      expect(screen.getByText("Refunded: the seller did not ship in time.")).toBeTruthy();
      expect(screen.getByText("5REF…wxyz ↗")).toBeTruthy();
    });

    it("lets an administrator pay the seller or refund the buyer of a held sale", async () => {
      const held = (id: string, disputeReason: string): AdminTransfer =>
        shipped(
          { ...paid, status: "DISPUTED", disputedAt: "2026-10-01T10:00:00.000Z", disputeReason },
          { id },
        );
      const noMatch = held("0199a000-0000-7000-8000-0000000000d1", "receipt_no_match");
      const failed = held("0199a000-0000-7000-8000-0000000000d2", "release_failed");
      const calls = mockFetch({
        "GET /auth/me": { json: me(["USER", "ADMIN"]) },
        "GET /admin/transfers/disputes": { json: { items: [noMatch, failed] } },
        [`POST /admin/transfers/${noMatch.id}/resolution`]: { json: noMatch },
      });
      renderAt("/admin/disputes");
      expect(await screen.findByText(/do not match the seller's photos/)).toBeTruthy();
      expect(screen.getByText(/only a refund is possible/)).toBeTruthy();
      expect(screen.getAllByText("Pay the seller")).toHaveLength(1);
      expect(screen.getAllByText("Refund the buyer")).toHaveLength(2);
      const [decision] = screen.getAllByLabelText("Decision, shown to both parties");
      fireEvent.change(decision as HTMLElement, { target: { value: "Matches on inspection." } });
      fireEvent.click(screen.getByText("Pay the seller"));
      await waitFor(() =>
        expect(calls.find((c) => c.url.endsWith("/resolution"))?.body).toEqual({
          outcome: "RELEASE",
          resolution: "Matches on inspection.",
        }),
      );
    });
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
