import { DomainError } from "./errors.js";

/** Same format as the `assets_wb_id_format_ck` database constraint. */
export const WB_ID_PATTERN = /^WB-[0-9A-F]{8}$/;

export type WbId = `WB-${string}`;

/**
 * Generates a random WorthyBound asset ID, e.g. `WB-7F93A281`.
 * The space is 32 bits: callers must rely on the database unique constraint and retry on conflict.
 */
export function generateWbId(): WbId {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `WB-${hex.toUpperCase()}`;
}

export function isWbId(value: unknown): value is WbId {
  return typeof value === "string" && WB_ID_PATTERN.test(value);
}

/** Normalizes user input (surrounding whitespace, lower case) to a canonical ID. */
export function parseWbId(input: string): WbId {
  const normalized = input.trim().toUpperCase();
  if (!isWbId(normalized)) {
    throw new DomainError("INVALID_WB_ID", "expected an asset ID like WB-7F93A281");
  }
  return normalized;
}
