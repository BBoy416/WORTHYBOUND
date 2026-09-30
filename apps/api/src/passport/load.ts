import type { Prisma, PrismaClient } from "@worthybound/database";
import { type PassportSource, verifierPublicName } from "@worthybound/shared";
import { CHECK_PROOF_PREFIX } from "../trust/record.js";

/**
 * Passed automated checks counted in a Trust Score snapshot, unless a failed check deducted
 * (ADR 0013). Read from the snapshot so the passport states what the score was computed from.
 */
async function passedAutomatedChecks(
  prisma: PrismaClient,
  snapshot: { factors: Prisma.JsonValue; deductions: Prisma.JsonValue },
): Promise<PassportSource["automatedChecks"]> {
  const deductions = snapshot.deductions as { code: string }[];
  if (deductions.some((d) => d.code === "FAILED_AUTOMATED_CHECKS")) return null;
  const ids = (snapshot.factors as { proofId?: string }[]).flatMap((f) =>
    f.proofId?.startsWith(CHECK_PROOF_PREFIX) ? [f.proofId.slice(CHECK_PROOF_PREFIX.length)] : [],
  );
  if (ids.length === 0) return null;
  const checks = await prisma.automatedCheck.findMany({
    where: { id: { in: ids }, result: "PASSED" },
    select: { evidenceId: true, createdAt: true },
  });
  if (checks.length === 0) return null;
  return {
    filesPassed: new Set(checks.map((c) => c.evidenceId)).size,
    lastPassedAt: new Date(Math.max(...checks.map((c) => c.createdAt.getTime()))),
  };
}

/**
 * Reads only the columns the public passport may show. Private columns (serials, storage keys,
 * notes, owner) are never selected, so they cannot reach the response by mistake.
 */
export async function loadPassportSource(
  prisma: PrismaClient,
  wbId: string,
): Promise<PassportSource | null> {
  const asset = await prisma.asset.findUnique({
    where: { wbId },
    select: {
      id: true,
      wbId: true,
      category: true,
      brand: true,
      model: true,
      publicDescription: true,
      status: true,
      tokenizationStatus: true,
      chainAssetAddress: true,
      chainRecordAddress: true,
      verificationLevel: true,
      condition: true,
      publishedAt: true,
    },
  });
  if (!asset?.publishedAt) return null;
  const { id, ...publicAsset } = asset;

  const [trust, custody, transferCount, evidence, commitments, attestations, provenance, chain] =
    await Promise.all([
      prisma.trustScoreSnapshot.findFirst({
        where: { assetId: id },
        orderBy: [{ computedAt: "desc" }, { id: "desc" }],
        select: {
          score: true,
          computedAt: true,
          engineVersion: true,
          weightsVersion: true,
          factors: true,
          deductions: true,
        },
      }),
      prisma.ownership.findFirst({
        where: { assetId: id, endedAt: null },
        select: { startedAt: true },
      }),
      prisma.ownership.count({ where: { assetId: id, reason: "TRANSFER" } }),
      prisma.evidence.findMany({
        where: { assetId: id, visibility: "PUBLIC", reviewStatus: { not: "REJECTED" } },
        select: {
          id: true,
          type: true,
          source: true,
          visibility: true,
          reviewStatus: true,
          sha256: true,
          mimeType: true,
          capturedAt: true,
          createdAt: true,
        },
      }),
      prisma.evidenceCommitment.findMany({
        where: { assetId: id },
        select: { merkleRoot: true, evidenceCount: true, createdAt: true },
      }),
      prisma.attestation.findMany({
        where: { assetId: id },
        select: {
          id: true,
          claimType: true,
          result: true,
          method: true,
          assuranceLevel: true,
          conditionGrade: true,
          status: true,
          issuedAt: true,
          expiresAt: true,
          signedPayloadHash: true,
          signature: true,
          chainAttestationAddress: true,
          verifier: { select: { id: true, businessName: true, entityType: true, status: true } },
        },
      }),
      prisma.provenanceEvent.findMany({
        where: { assetId: id },
        orderBy: { sequence: "asc" },
        select: { sequence: true, type: true, occurredAt: true, hash: true, prevHash: true },
      }),
      prisma.chainTransaction.findMany({
        where: { entityType: "ASSET", entityId: id, status: { in: ["CONFIRMED", "FINALIZED"] } },
        select: { kind: true, cluster: true, status: true, signature: true, confirmedAt: true },
      }),
    ]);

  return {
    asset: publicAsset,
    trust: trust && {
      score: trust.score,
      computedAt: trust.computedAt,
      engineVersion: trust.engineVersion,
      weightsVersion: trust.weightsVersion,
    },
    automatedChecks: trust ? await passedAutomatedChecks(prisma, trust) : null,
    custody: { currentSince: custody?.startedAt ?? null, transferCount },
    evidence,
    evidenceCommitments: commitments,
    attestations: attestations.map(({ verifier, ...a }) => ({
      ...a,
      verifier: {
        id: verifier.id,
        publicName: verifierPublicName(verifier),
        entityType: verifier.entityType,
        status: verifier.status,
      },
    })),
    provenance,
    chainTransactions: chain,
  };
}
