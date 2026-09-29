import type { PublicPassport } from "@worthybound/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerAsset } from "../src/types.js";
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
    const { container } = renderAt(`/assets/${WB}`);
    await screen.findByText("Add evidence");
    const file = new File([new Uint8Array([104, 101, 108, 108, 111])], "front.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
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
    const { container } = renderAt(`/assets/${WB}`);
    await screen.findByText("Add evidence");
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByText("Add evidence"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/text\/plain are not accepted/);
    expect(calls.some((c) => c.url.includes("/evidence/uploads"))).toBe(false);
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
