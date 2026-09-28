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
