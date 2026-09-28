import { describe, expect, it } from "vitest";
import {
  buildSignInInput,
  matchesIssuedInput,
  parseSignedMessage,
  signInMessageText,
  verifyWalletSignature,
} from "../src/auth/siws.js";
import { testConfig, TestWallet } from "./helpers.js";

const wallet = new TestWallet();
const issuedAt = new Date("2026-09-28T12:00:00.000Z");
const input = buildSignInInput(testConfig(), {
  walletAddress: wallet.address,
  nonce: "a1b2c3d4e5f60718a1b2c3d4e5f60718",
  issuedAt,
  expiresAt: new Date(issuedAt.getTime() + 300_000),
});
const text = signInMessageText(input);

describe("Sign In With Solana", () => {
  it("round-trips the issued message", () => {
    const parsed = parseSignedMessage(Buffer.from(text));
    expect(parsed).not.toBeNull();
    expect(matchesIssuedInput(parsed!, input)).toBe(true);
  });

  it("rejects invalid UTF-8 and non-SIWS text", () => {
    expect(parseSignedMessage(Uint8Array.from([0xff, 0xfe, 0xfd]))).toBeNull();
    expect(parseSignedMessage(Buffer.from("hello"))).toBeNull();
  });

  it.each([
    ["Not Before", `${text}\nNot Before: 2026-09-28T12:00:00.000Z`],
    ["Request ID", `${text}\nRequest ID: 1`],
  ])("rejects an added %s field", (_name, extended) => {
    const parsed = parseSignedMessage(Buffer.from(extended));
    expect(parsed && matchesIssuedInput(parsed, input)).toBe(false);
  });

  it("verifies Ed25519 signatures by the wallet only", () => {
    const message = Buffer.from(text);
    const signature = wallet.sign(message);
    expect(verifyWalletSignature(wallet.address, message, signature)).toBe(true);
    expect(verifyWalletSignature(new TestWallet().address, message, signature)).toBe(false);
    expect(verifyWalletSignature(wallet.address, Buffer.from(`${text} `), signature)).toBe(false);
    expect(verifyWalletSignature(wallet.address, message, signature.subarray(0, 63))).toBe(false);
    expect(verifyWalletSignature("not-an-address", message, signature)).toBe(false);
  });
});
