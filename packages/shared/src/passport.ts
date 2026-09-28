import type {
  AssetCategory,
  AssetStatus,
  AssuranceLevel,
  AttestationMethod,
  AttestationResult,
  AttestationStatus,
  ChainTransactionKind,
  ChainTransactionStatus,
  ClaimType,
  EvidenceType,
  EvidenceVisibility,
  ProvenanceEventType,
  ReviewStatus,
  SolanaCluster,
  TokenizationStatus,
  VerificationLevel,
  VerifierEntityType,
  VerifierStatus,
} from "./enums.js";
import { parseWbId } from "./ids.js";
import { TRUST_SCORE_DISCLAIMER } from "./trust.js";

/**
 * Records the passport is built from. Objects may carry more fields (e.g. database rows with
 * serial numbers, storage keys or notes); only the fields named here are ever read.
 */
export interface PassportSource {
  asset: {
    wbId: string;
    category: AssetCategory;
    brand: string | null;
    model: string | null;
    publicDescription: string | null;
    status: AssetStatus;
    tokenizationStatus: TokenizationStatus;
    chainAssetAddress: string | null;
    verificationLevel: VerificationLevel;
  };
  trust: { score: number; computedAt: Date; engineVersion: string; weightsVersion: string } | null;
  custody: { currentSince: Date | null; transferCount: number };
  evidence: readonly {
    id: string;
    type: EvidenceType;
    visibility: EvidenceVisibility;
    reviewStatus: ReviewStatus;
    sha256: string;
    mimeType: string;
    capturedAt: Date | null;
    createdAt: Date;
  }[];
  evidenceCommitments: readonly { merkleRoot: string; evidenceCount: number; createdAt: Date }[];
  attestations: readonly {
    id: string;
    claimType: ClaimType;
    result: AttestationResult;
    method: AttestationMethod;
    assuranceLevel: AssuranceLevel;
    status: AttestationStatus;
    issuedAt: Date;
    expiresAt: Date | null;
    signedPayloadHash: string;
    signature: string;
    chainAttestationAddress: string | null;
    verifier: {
      id: string;
      publicName: string | null;
      entityType: VerifierEntityType;
      status: VerifierStatus;
    };
  }[];
  provenance: readonly {
    sequence: number;
    type: ProvenanceEventType;
    occurredAt: Date;
    hash: string;
    prevHash: string | null;
  }[];
  chainTransactions: readonly {
    kind: ChainTransactionKind;
    cluster: SolanaCluster;
    status: ChainTransactionStatus;
    signature: string | null;
    confirmedAt: Date | null;
  }[];
}

export interface PublicPassport {
  wbId: string;
  category: AssetCategory;
  brand: string | null;
  model: string | null;
  description: string | null;
  status: AssetStatus;
  verificationLevel: VerificationLevel;
  lastVerifiedAt: string | null;
  trust: {
    score: number;
    computedAt: string;
    engineVersion: string;
    weightsVersion: string;
    disclaimer: string;
  } | null;
  tokenization: { status: TokenizationStatus; chainAssetAddress: string | null };
  custody: { currentSince: string | null; transferCount: number };
  publicEvidence: {
    evidenceId: string;
    type: EvidenceType;
    sha256: string;
    mimeType: string;
    capturedAt: string | null;
  }[];
  evidenceCommitments: { merkleRoot: string; evidenceCount: number; createdAt: string }[];
  attestations: {
    id: string;
    claimType: ClaimType;
    result: AttestationResult;
    method: AttestationMethod;
    assuranceLevel: AssuranceLevel;
    status: AttestationStatus;
    issuedAt: string;
    expiresAt: string | null;
    signedPayloadHash: string;
    signature: string;
    chainAttestationAddress: string | null;
    verifier: {
      id: string;
      publicName: string | null;
      entityType: VerifierEntityType;
      status: VerifierStatus;
    };
  }[];
  provenance: {
    sequence: number;
    type: ProvenanceEventType;
    occurredAt: string;
    hash: string;
    prevHash: string | null;
  }[];
  chainTransactions: {
    kind: ChainTransactionKind;
    cluster: SolanaCluster;
    signature: string;
    confirmedAt: string | null;
  }[];
}

/** Draft and tokenized-but-unpublished assets have no public passport. */
export function isPassportPublic(status: AssetStatus): boolean {
  return status !== "DRAFT" && status !== "TOKENIZED";
}

/** Relative, QR-friendly path of an asset's public passport. */
export function passportPath(wbId: string): string {
  return `/passport/${parseWbId(wbId)}`;
}

export function passportUrl(baseUrl: string, wbId: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new TypeError("passport base URL must use http or https");
  }
  return new URL(passportPath(wbId), base).toString();
}

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);
const byTime =
  <T>(get: (item: T) => Date) =>
  (a: T, b: T) =>
    get(a).getTime() - get(b).getTime();

/**
 * Builds the public passport from an explicit allow-list of fields, or returns null if the asset
 * is not published. Private evidence, storage keys, serial numbers, owner identity, attestation
 * notes and provenance payloads are never included. Revoked and disputed attestations stay
 * visible so the history is complete.
 */
export function toPublicPassport(source: PassportSource): PublicPassport | null {
  const { asset } = source;
  if (!isPassportPublic(asset.status)) return null;

  const attestations = [...source.attestations].sort(byTime((a) => a.issuedAt)).reverse();
  const lastVerified = attestations.find(
    (a) => a.result === "CONFIRMED" && ["ACTIVE", "EXPIRED", "SUPERSEDED"].includes(a.status),
  );

  return {
    wbId: parseWbId(asset.wbId),
    category: asset.category,
    brand: asset.brand,
    model: asset.model,
    description: asset.publicDescription,
    status: asset.status,
    verificationLevel: asset.verificationLevel,
    lastVerifiedAt: lastVerified ? iso(lastVerified.issuedAt) : null,
    trust: source.trust && {
      score: source.trust.score,
      computedAt: iso(source.trust.computedAt),
      engineVersion: source.trust.engineVersion,
      weightsVersion: source.trust.weightsVersion,
      disclaimer: TRUST_SCORE_DISCLAIMER,
    },
    tokenization: { status: asset.tokenizationStatus, chainAssetAddress: asset.chainAssetAddress },
    custody: {
      currentSince: isoOrNull(source.custody.currentSince),
      transferCount: source.custody.transferCount,
    },
    publicEvidence: source.evidence
      .filter((e) => e.visibility === "PUBLIC" && e.reviewStatus !== "REJECTED")
      .sort(byTime((e) => e.createdAt))
      .map((e) => ({
        evidenceId: e.id,
        type: e.type,
        sha256: e.sha256,
        mimeType: e.mimeType,
        capturedAt: isoOrNull(e.capturedAt),
      })),
    evidenceCommitments: [...source.evidenceCommitments]
      .sort(byTime((c) => c.createdAt))
      .map((c) => ({
        merkleRoot: c.merkleRoot,
        evidenceCount: c.evidenceCount,
        createdAt: iso(c.createdAt),
      })),
    attestations: attestations.map((a) => ({
      id: a.id,
      claimType: a.claimType,
      result: a.result,
      method: a.method,
      assuranceLevel: a.assuranceLevel,
      status: a.status,
      issuedAt: iso(a.issuedAt),
      expiresAt: isoOrNull(a.expiresAt),
      signedPayloadHash: a.signedPayloadHash,
      signature: a.signature,
      chainAttestationAddress: a.chainAttestationAddress,
      verifier: {
        id: a.verifier.id,
        publicName: a.verifier.publicName,
        entityType: a.verifier.entityType,
        status: a.verifier.status,
      },
    })),
    provenance: [...source.provenance]
      .sort((a, b) => a.sequence - b.sequence)
      .map((p) => ({
        sequence: p.sequence,
        type: p.type,
        occurredAt: iso(p.occurredAt),
        hash: p.hash,
        prevHash: p.prevHash,
      })),
    chainTransactions: source.chainTransactions
      .filter(
        (t): t is typeof t & { signature: string } =>
          (t.status === "CONFIRMED" || t.status === "FINALIZED") && t.signature !== null,
      )
      .map((t) => ({
        kind: t.kind,
        cluster: t.cluster,
        signature: t.signature,
        confirmedAt: isoOrNull(t.confirmedAt),
      })),
  };
}
