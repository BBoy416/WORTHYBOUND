import type { AssetStatus, EvidenceType, Prisma, VerifierStatus } from "@worthybound/database";
import {
  ASSET_LIFECYCLE,
  type AttestationFact,
  canTransition,
  evaluateTemplate,
  type TemplateEvaluation,
} from "@worthybound/shared";
import {
  computeTrust,
  type Proof,
  type ProofType,
  type SourceStatus,
  type TrustResult,
} from "@worthybound/trust-engine";
import { enqueueChainSync } from "../chain/sync.js";
import { requirementsOf } from "../templates/view.js";

type Tx = Prisma.TransactionClient;

/** Proof IDs of passed automated checks: the prefix followed by the check's ID. */
export const CHECK_PROOF_PREFIX = "check:";

/**
 * What each evidence type proves. Evidence never proves an inspection or authentication on its
 * own; only attestations do. `OTHER` does not count.
 */
export const EVIDENCE_PROOF_TYPES: Record<EvidenceType, ProofType | null> = {
  PHOTO: "PHOTO",
  VIDEO: "PHOTO",
  RECEIPT: "RECEIPT",
  CERTIFICATE: "CERTIFICATE",
  PROVENANCE_DOCUMENT: "PROVENANCE",
  SERIAL_NUMBER: "SERIAL_NUMBER",
  OWNERSHIP_DOCUMENT: "OWNERSHIP_CLAIM",
  INSPECTION_REPORT: "DOCUMENTATION",
  APPRAISAL_DOCUMENT: "DOCUMENTATION",
  CONDITION_REPORT: "DOCUMENTATION",
  SERVICE_RECORD: "DOCUMENTATION",
  MANUFACTURER_DOCUMENT: "DOCUMENTATION",
  OTHER: null,
};

const SOURCE_STATUS: Partial<Record<VerifierStatus, SourceStatus>> = {
  APPROVED: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  REVOKED: "REVOKED",
};

/** Statuses in which template evaluation moves an asset to or from VERIFIED. */
const EVALUATED_STATUSES: readonly AssetStatus[] = [
  "ACTIVE",
  "VERIFIED",
  "REVERIFICATION_REQUIRED",
];

export interface TrustRecord {
  result: TrustResult;
  status: AssetStatus;
  evaluations: TemplateEvaluation[];
}

/**
 * Recomputes an asset's Trust Score from its recorded facts, stores a snapshot and updates the
 * asset. Templates are those the owner requested verification against (open, completed or
 * attested requests), in their current published version. Sets VERIFIED when one is met, and
 * returns a VERIFIED asset to ACTIVE when none is met any more (ADR 0006: only the system sets
 * VERIFIED). For tokenized assets, queues mirroring of the status and score on-chain (ADR 0016).
 * Run inside the transaction that changed the facts, after locking the asset.
 */
export async function recordTrust(tx: Tx, assetId: string, at: Date): Promise<TrustRecord> {
  const asset = await tx.asset.findUniqueOrThrow({
    where: { id: assetId },
    select: {
      id: true,
      wbId: true,
      category: true,
      status: true,
      owner: { select: { identityStatus: true } },
    },
  });
  const [ownerships, recorded, attestations, openDisputes, requests] = await Promise.all([
    tx.ownership.findMany({
      where: { assetId },
      orderBy: { startedAt: "asc" },
      select: { startedAt: true, endedAt: true },
    }),
    tx.evidence.findMany({
      where: { assetId },
      select: {
        id: true,
        type: true,
        source: true,
        uploaderId: true,
        reviewStatus: true,
        duplicateOfId: true,
        createdAt: true,
        captureSession: { select: { status: true } },
        disputes: { where: { status: "UPHELD" }, select: { id: true }, take: 1 },
        automatedChecks: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { id: true, result: true, createdAt: true },
        },
      },
    }),
    tx.attestation.findMany({
      where: { assetId },
      select: {
        id: true,
        claimType: true,
        result: true,
        status: true,
        method: true,
        verifierId: true,
        issuedAt: true,
        expiresAt: true,
        createdAt: true,
        verifier: { select: { status: true } },
      },
    }),
    tx.dispute.count({ where: { assetId, status: { in: ["OPEN", "UNDER_REVIEW"] } } }),
    tx.verificationRequest.findMany({
      where: {
        assetId,
        OR: [{ status: { in: ["OPEN", "ASSIGNED", "COMPLETED"] } }, { attestations: { some: {} } }],
      },
      select: { templateVersion: { select: { templateId: true } } },
    }),
  ]);

  // Evidence an upheld dispute found misleading counts as rejected (ADR 0017).
  const evidence = recorded.map((e) =>
    e.disputes.length > 0 ? { ...e, reviewStatus: "REJECTED" as const } : e,
  );

  const templateIds = [...new Set(requests.map((r) => r.templateVersion.templateId))];
  const versions = await tx.verificationTemplateVersion.findMany({
    where: { templateId: { in: templateIds }, status: "PUBLISHED" },
  });

  // A recovered or reverification-required asset meets a template only with attestations
  // recorded since.
  let attestedSince: Date | null = null;
  if (asset.status === "REVERIFICATION_REQUIRED") {
    const entered = await tx.assetStatusEvent.findFirst({
      where: { assetId, toStatus: "REVERIFICATION_REQUIRED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    attestedSince = entered?.createdAt ?? null;
  }
  const facts: AttestationFact[] = attestations
    .filter((a) => attestedSince === null || a.createdAt >= attestedSince)
    .map((a) => ({
      claimType: a.claimType,
      result: a.result,
      status: a.status,
      method: a.method,
      verifierId: a.verifierId,
      verifierStatus: a.verifier.status,
      expiresAt: a.expiresAt,
    }));
  const evaluations = versions.map((v) =>
    evaluateTemplate(requirementsOf(v), { attestations: facts, evidence, at }),
  );
  // Owner files whose latest automated check failed deduct and block templates until a verifier
  // accepts them (ADR 0013).
  const failedAutomatedChecks = evidence.filter(
    (e) => e.automatedChecks[0]?.result === "FAILED" && e.reviewStatus !== "ACCEPTED",
  ).length;
  const satisfied = failedAutomatedChecks === 0 && evaluations.some((e) => e.satisfied);
  const missingRequiredEvidence =
    evaluations.length > 0 ? Math.min(...evaluations.map((e) => e.missingEvidenceCount)) : 0;

  const proofs: Proof[] = [];
  for (const e of evidence) {
    const type = EVIDENCE_PROOF_TYPES[e.type];
    // Verifier evidence supports the verifier's attestation and counts through it; copies of
    // files already on another asset prove nothing about this one (ADR 0010).
    if (type === null || e.source === "VERIFIER" || e.duplicateOfId !== null) continue;
    proofs.push({
      id: `evidence:${e.id}`,
      type,
      source: e.source,
      sourceId: e.uploaderId,
      issuedAt: e.createdAt.toISOString(),
      status: e.reviewStatus === "REJECTED" ? "REJECTED" : "ACTIVE",
    });
    const check = e.automatedChecks[0];
    if (check?.result === "PASSED") {
      proofs.push({
        id: `${CHECK_PROOF_PREFIX}${check.id}`,
        type,
        source: "AUTOMATED",
        sourceId: "automated-checks",
        issuedAt: check.createdAt.toISOString(),
        status: e.reviewStatus === "REJECTED" ? "REJECTED" : "ACTIVE",
        // Photos taken live in a completed guided capture session (ADR 0013).
        ...(e.captureSession?.status === "COMPLETED" ? { captured: true } : {}),
      });
    }
  }
  for (const a of attestations) {
    // Inconclusive findings prove nothing either way; disputed ones wait for the outcome.
    if (a.result === "INCONCLUSIVE" || a.status === "DISPUTED") continue;
    proofs.push({
      id: `attestation:${a.id}`,
      type: a.claimType,
      source: "VERIFIER",
      sourceId: a.verifierId,
      issuedAt: a.issuedAt.toISOString(),
      ...(a.expiresAt ? { expiresAt: a.expiresAt.toISOString() } : {}),
      status:
        a.status === "REVOKED" ? "REVOKED" : a.status === "SUPERSEDED" ? "SUPERSEDED" : "ACTIVE",
      result: a.result,
      ...(SOURCE_STATUS[a.verifier.status]
        ? { sourceStatus: SOURCE_STATUS[a.verifier.status] }
        : {}),
    });
  }

  const current = ownerships.find((o) => o.endedAt === null) ?? ownerships.at(-1);
  const custodyContinuous = ownerships.every(
    (o, i) => i === 0 || ownerships[i - 1]?.endedAt?.getTime() === o.startedAt.getTime(),
  );

  let status = asset.status;
  if (EVALUATED_STATUSES.includes(status)) {
    const target: AssetStatus | null =
      satisfied && status !== "VERIFIED"
        ? "VERIFIED"
        : !satisfied && status === "VERIFIED"
          ? "ACTIVE"
          : null;
    if (target && canTransition(ASSET_LIFECYCLE, status, target, "SYSTEM")) {
      await tx.assetStatusEvent.create({
        data: {
          assetId,
          fromStatus: status,
          toStatus: target,
          reason: target === "VERIFIED" ? "template_satisfied" : "template_no_longer_satisfied",
          actorId: null,
          createdAt: at,
        },
      });
      await tx.provenanceEvent.create({
        data: {
          assetId,
          type: "STATUS_CHANGED",
          actorId: null,
          occurredAt: at,
          payload: { fromStatus: status, toStatus: target },
        },
      });
      status = target;
    }
  }

  const result = computeTrust({
    assetId: asset.id,
    category: asset.category,
    status,
    owner: { walletVerified: true, identityVerified: asset.owner.identityStatus === "VERIFIED" },
    currentCustodySince: (current?.startedAt ?? at).toISOString(),
    custodyContinuous,
    proofs,
    openDisputes,
    missingRequiredEvidence,
    failedAutomatedChecks,
    evaluatedAt: at.toISOString(),
  });

  await tx.trustScoreSnapshot.create({
    data: {
      assetId,
      score: result.score,
      verificationLevel: result.verificationLevel,
      factors: result.factors as unknown as Prisma.InputJsonValue,
      deductions: result.deductions as unknown as Prisma.InputJsonValue,
      capsApplied: result.capsApplied as unknown as Prisma.InputJsonValue,
      excludedProofs: result.excludedProofs as unknown as Prisma.InputJsonValue,
      engineVersion: result.engineVersion,
      weightsVersion: result.weightsVersion,
      inputsHash: result.inputsHash,
      computedAt: at,
    },
  });
  await tx.asset.update({
    where: { id: assetId },
    data: { status, currentTrustScore: result.score, verificationLevel: result.verificationLevel },
  });
  await enqueueChainSync(tx, assetId);
  return { result, status, evaluations };
}

/** Recomputes several assets in a stable order (locking each first), e.g. after a verifier changes. */
export async function recordTrustForAssets(tx: Tx, assetIds: Iterable<string>, at: Date) {
  for (const id of [...new Set(assetIds)].sort()) {
    await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${id}::uuid FOR UPDATE`;
    await recordTrust(tx, id, at);
  }
}
