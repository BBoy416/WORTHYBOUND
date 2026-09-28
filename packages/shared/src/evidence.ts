import type { EvidenceType } from "./enums.js";

const MiB = 1024 * 1024;

/** Accepted evidence file types and their maximum size in bytes. */
export const EVIDENCE_MAX_BYTES = {
  "image/jpeg": 25 * MiB,
  "image/png": 25 * MiB,
  "image/webp": 25 * MiB,
  "image/heic": 25 * MiB,
  "application/pdf": 25 * MiB,
  "video/mp4": 500 * MiB,
  "video/quicktime": 500 * MiB,
} as const;
export type EvidenceMimeType = keyof typeof EVIDENCE_MAX_BYTES;
export const EVIDENCE_MIME_TYPES = Object.keys(EVIDENCE_MAX_BYTES) as [
  EvidenceMimeType,
  ...EvidenceMimeType[],
];

/** Photos in these formats can be made public; the public copy has its metadata removed. */
export const PUBLIC_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PublicPhotoMimeType = (typeof PUBLIC_PHOTO_MIME_TYPES)[number];

export const MAX_EVIDENCE_PER_ASSET = 100;

/** Only photos in a format whose metadata can be removed may be public. */
export function canBePublic(type: EvidenceType, mimeType: string): boolean {
  return type === "PHOTO" && (PUBLIC_PHOTO_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Path of a public evidence photo on the API, relative to its origin. */
export const publicEvidencePath = (wbId: string, evidenceId: string) =>
  `/passport/${wbId}/evidence/${evidenceId}`;

// ─── Evidence seal (Merkle root) ──────────────────────────────────────────────

export const MERKLE_ALGORITHM = "sha256-merkle-v1";

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(prefix: number, ...parts: Uint8Array[]): Promise<Uint8Array> {
  const data = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0));
  data[0] = prefix;
  let offset = 1;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
}

/**
 * Merkle root over evidence file hashes, in the given order (`sha256-merkle-v1`).
 *
 * - leaf = SHA-256(0x00 ‖ file hash), node = SHA-256(0x01 ‖ left ‖ right), so a leaf can never
 *   be passed off as a node;
 * - an unpaired node moves up unchanged instead of being duplicated, so two different lists
 *   cannot produce the same root.
 */
export async function merkleRoot(fileHashes: readonly string[]): Promise<string> {
  if (fileHashes.length === 0) throw new RangeError("a Merkle root needs at least one hash");
  let level = await Promise.all(
    fileHashes.map((hash) => {
      if (!SHA256_HEX.test(hash)) throw new TypeError("expected lowercase SHA-256 hex");
      return sha256(LEAF_PREFIX, fromHex(hash));
    }),
  );
  while (level.length > 1) {
    const next: Promise<Uint8Array>[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const [left, right] = [level[i] as Uint8Array, level[i + 1]];
      next.push(right ? sha256(NODE_PREFIX, left, right) : Promise.resolve(left));
    }
    level = await Promise.all(next);
  }
  return toHex(level[0] as Uint8Array);
}

export interface MerkleProofStep {
  /** Sibling node hash. */
  hash: string;
  /** Whether the sibling is on the left. */
  left: boolean;
}

/** Proof that the hash at `index` is part of the root, without revealing the other files. */
export async function merkleProof(
  fileHashes: readonly string[],
  index: number,
): Promise<MerkleProofStep[]> {
  if (!Number.isInteger(index) || index < 0 || index >= fileHashes.length) {
    throw new RangeError("index out of range");
  }
  let level = await Promise.all(fileHashes.map((h) => sha256(LEAF_PREFIX, fromHex(h))));
  const proof: MerkleProofStep[] = [];
  let position = index;
  while (level.length > 1) {
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    const node = level[sibling];
    if (node) proof.push({ hash: toHex(node), left: sibling < position });
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const [left, right] = [level[i] as Uint8Array, level[i + 1]];
      next.push(right ? await sha256(NODE_PREFIX, left, right) : left);
    }
    level = next;
    position = Math.floor(position / 2);
  }
  return proof;
}

export async function verifyMerkleProof(
  fileHash: string,
  proof: readonly MerkleProofStep[],
  root: string,
): Promise<boolean> {
  if (!SHA256_HEX.test(fileHash) || !SHA256_HEX.test(root)) return false;
  let node = await sha256(LEAF_PREFIX, fromHex(fileHash));
  for (const step of proof) {
    if (!SHA256_HEX.test(step.hash)) return false;
    const sibling = fromHex(step.hash);
    node = step.left
      ? await sha256(NODE_PREFIX, sibling, node)
      : await sha256(NODE_PREFIX, node, sibling);
  }
  return toHex(node) === root;
}
