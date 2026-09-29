import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_STATUSES, VERIFICATION_LEVELS } from "@worthybound/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadKeypairSigner, toChainAssetStatus, toChainVerificationLevel } from "../src/index.js";

describe("enum mapping", () => {
  it("maps every asset status to the on-chain value in the same order", () => {
    ASSET_STATUSES.forEach((status, index) => expect(toChainAssetStatus(status)).toBe(index));
  });

  it("maps every verification level to the on-chain value in the same order", () => {
    VERIFICATION_LEVELS.forEach((level, index) =>
      expect(toChainVerificationLevel(level)).toBe(index),
    );
  });
});

describe("loadKeypairSigner", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wb-keypair-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a Solana CLI keypair file", async () => {
    // RFC 8032 test vector 1: secret key, then its public key.
    const secret = Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    );
    const pub = Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    );
    const path = join(dir, "ok.json");
    await writeFile(path, JSON.stringify([...secret, ...pub]));
    const signer = await loadKeypairSigner(path);
    expect(signer.address).toBe("FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z");
  });

  it("rejects files that are not 64-byte arrays without echoing their contents", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, JSON.stringify([1, 2, 3]));
    await expect(loadKeypairSigner(path)).rejects.toThrow(/not a 64-byte JSON array/);
    await expect(loadKeypairSigner(join(dir, "missing.json"))).rejects.toThrow(/Cannot read/);
  });
});
