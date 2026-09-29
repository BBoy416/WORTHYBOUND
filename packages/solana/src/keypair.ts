import { readFile } from "node:fs/promises";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

/**
 * Loads a Solana CLI keypair file (JSON array of 64 bytes). Errors never include the file
 * contents.
 */
export async function loadKeypairSigner(path: string): Promise<KeyPairSigner> {
  let bytes: unknown;
  try {
    bytes = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Cannot read the keypair file at ${path}`);
  }
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new Error(`The keypair file at ${path} is not a 64-byte JSON array`);
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(bytes));
}
