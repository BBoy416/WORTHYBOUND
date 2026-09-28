import { createPublicKey, verify } from "node:crypto";
import { getAddressEncoder, isAddress } from "@solana/addresses";
import { createSignInMessageText, parseSignInMessage } from "@solana/wallet-standard-util";
import type { Config } from "../config.js";

/** Every field WorthyBound sets in a sign-in request. */
export interface SignInInput {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: "1";
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}
export type ParsedSignIn = NonNullable<ReturnType<typeof parseSignInMessage>>;

export const SIGN_IN_STATEMENT =
  "Sign in to WorthyBound. This request does not trigger a blockchain transaction or cost any fees.";

export const NONCE_TTL_MS = 5 * 60 * 1000;

export type SignInFailure =
  | "malformed_message"
  | "unknown_nonce"
  | "field_mismatch"
  | "address_mismatch"
  | "invalid_signature"
  | "expired"
  | "nonce_used";

/** The exact Sign In With Solana request the wallet is asked to sign. */
export function buildSignInInput(
  config: Pick<Config, "AUTH_DOMAIN" | "authUri" | "chainId">,
  nonce: { walletAddress: string; nonce: string; issuedAt: Date; expiresAt: Date },
): SignInInput {
  return {
    domain: config.AUTH_DOMAIN,
    address: nonce.walletAddress,
    statement: SIGN_IN_STATEMENT,
    uri: config.authUri,
    version: "1",
    chainId: config.chainId,
    nonce: nonce.nonce,
    issuedAt: nonce.issuedAt.toISOString(),
    expirationTime: nonce.expiresAt.toISOString(),
  };
}

/** The text a wallet without the `signIn` feature signs with `signMessage`. */
export const signInMessageText = (input: SignInInput): string => createSignInMessageText(input);

/** Parses the signed bytes as a SIWS message; null if they are not valid UTF-8 or not SIWS. */
export function parseSignedMessage(message: Uint8Array): ParsedSignIn | null {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(message);
  } catch {
    return null;
  }
  return parseSignInMessage(message);
}

const ISSUED_FIELDS = [
  "domain",
  "address",
  "statement",
  "uri",
  "version",
  "chainId",
  "nonce",
  "issuedAt",
  "expirationTime",
] as const;

/** True only if every field of the signed message equals the issued request, and none were added. */
export function matchesIssuedInput(parsed: ParsedSignIn, expected: SignInInput): boolean {
  return (
    ISSUED_FIELDS.every((field) => parsed[field] === expected[field]) &&
    parsed.notBefore === undefined &&
    parsed.requestId === undefined &&
    parsed.resources === undefined
  );
}

/** Verifies an Ed25519 signature by the wallet's public key over the exact message bytes. */
export function verifyWalletSignature(
  address: string,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (!isAddress(address) || signature.length !== 64) return false;
  const publicKey = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(getAddressEncoder().encode(address)).toString("base64url"),
    },
    format: "jwk",
  });
  try {
    return verify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}
