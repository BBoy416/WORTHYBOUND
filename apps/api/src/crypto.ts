import { createHash, createHmac, randomBytes } from "node:crypto";

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Keyed hash for IP addresses and user agents, so they can be correlated but not read back. */
export const hmacHex = (secret: string, value: string): string =>
  createHmac("sha256", secret).update(value).digest("hex");

/** 32 random bytes, base64url. Only its SHA-256 is stored. */
export const newSessionToken = (): string => randomBytes(32).toString("base64url");

/** SIWS nonces must be alphanumeric and at least 8 characters. */
export const newNonce = (): string => randomBytes(16).toString("hex");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decodes base58 (Bitcoin alphabet, as used by Solana); null if the text is not base58. */
export function decodeBase58(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; value > 0n; value /= 256n) bytes.unshift(Number(value % 256n));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}
