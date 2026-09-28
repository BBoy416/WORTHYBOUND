import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canBePublic,
  EVIDENCE_MAX_BYTES,
  merkleProof,
  merkleRoot,
  publicEvidencePath,
  verifyMerkleProof,
} from "../src/index.js";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const leaf = (hash: string) => sha(Buffer.concat([Buffer.from([0]), Buffer.from(hash, "hex")]));
const node = (l: string, r: string) =>
  sha(Buffer.concat([Buffer.from([1]), Buffer.from(l, "hex"), Buffer.from(r, "hex")]));
const files = (n: number) => Array.from({ length: n }, (_, i) => sha(`file-${i}`));

describe("canBePublic", () => {
  it("allows only photos whose metadata can be removed", () => {
    expect(canBePublic("PHOTO", "image/jpeg")).toBe(true);
    expect(canBePublic("PHOTO", "image/png")).toBe(true);
    expect(canBePublic("PHOTO", "image/webp")).toBe(true);
    expect(canBePublic("PHOTO", "image/heic")).toBe(false);
    expect(canBePublic("RECEIPT", "image/jpeg")).toBe(false);
    expect(canBePublic("VIDEO", "video/mp4")).toBe(false);
  });

  it("keeps size limits per type", () => {
    expect(EVIDENCE_MAX_BYTES["image/jpeg"]).toBe(25 * 1024 * 1024);
    expect(EVIDENCE_MAX_BYTES["video/mp4"]).toBe(500 * 1024 * 1024);
  });

  it("builds the public photo path", () => {
    expect(publicEvidencePath("WB-7F93A281", "abc")).toBe("/passport/WB-7F93A281/evidence/abc");
  });
});

describe("merkleRoot (sha256-merkle-v1)", () => {
  it("matches an independent calculation", async () => {
    const [a, b, c] = files(3) as [string, string, string];
    expect(await merkleRoot([a])).toBe(leaf(a));
    expect(await merkleRoot([a, b])).toBe(node(leaf(a), leaf(b)));
    // The unpaired third leaf moves up unchanged.
    expect(await merkleRoot([a, b, c])).toBe(node(node(leaf(a), leaf(b)), leaf(c)));
  });

  it("changes when a file is changed, added, removed or reordered", async () => {
    const list = files(5);
    const root = await merkleRoot(list);
    expect(await merkleRoot([...list.slice(0, 4), sha("swapped")])).not.toBe(root);
    expect(await merkleRoot([...list, sha("extra")])).not.toBe(root);
    expect(await merkleRoot(list.slice(0, 4))).not.toBe(root);
    expect(await merkleRoot([list[1], list[0], ...list.slice(2)] as string[])).not.toBe(root);
  });

  it("does not let a duplicated last file produce the same root", async () => {
    const list = files(3);
    expect(await merkleRoot([...list, list[2] as string])).not.toBe(await merkleRoot(list));
  });

  it("does not accept a node as a leaf", async () => {
    const [a, b] = files(2) as [string, string];
    expect(await merkleRoot([node(leaf(a), leaf(b))])).not.toBe(await merkleRoot([a, b]));
  });

  it("rejects empty lists and malformed hashes", async () => {
    await expect(merkleRoot([])).rejects.toThrow(RangeError);
    await expect(merkleRoot(["ABC"])).rejects.toThrow(TypeError);
    await expect(merkleRoot([sha("x").toUpperCase()])).rejects.toThrow(TypeError);
  });
});

describe("merkleProof", () => {
  it.each([1, 2, 3, 5, 8, 13])("proves every file of a %i-file seal", async (n) => {
    const list = files(n);
    const root = await merkleRoot(list);
    for (let i = 0; i < n; i++) {
      const proof = await merkleProof(list, i);
      expect(await verifyMerkleProof(list[i] as string, proof, root)).toBe(true);
    }
  });

  it("rejects a proof for a different file or root", async () => {
    const list = files(6);
    const root = await merkleRoot(list);
    const proof = await merkleProof(list, 2);
    expect(await verifyMerkleProof(list[3] as string, proof, root)).toBe(false);
    expect(await verifyMerkleProof(list[2] as string, proof, sha("other"))).toBe(false);
    expect(await verifyMerkleProof("not-a-hash", proof, root)).toBe(false);
  });

  it("rejects an index outside the list", async () => {
    await expect(merkleProof(files(2), 2)).rejects.toThrow(RangeError);
  });
});
