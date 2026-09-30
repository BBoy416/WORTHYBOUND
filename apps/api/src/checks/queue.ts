import { CHECK_VERSION } from "@worthybound/automated-checks";
import type { Asset, Evidence, Prisma } from "@worthybound/database";
import { isCheckable } from "@worthybound/shared";

type Tx = Prisma.TransactionClient;

/** Owner uploads of a type the checks examine. Verifier evidence is never checked. */
export const isCheckedEvidence = (e: Pick<Evidence, "source" | "type" | "mimeType">) =>
  e.source === "OWNER" && isCheckable(e.type, e.mimeType);

/** Checks run on every asset except revoked ones (ADR 0013). */
export const checksAllowed = (asset: Pick<Asset, "status">) => asset.status !== "REVOKED";

/**
 * Queues a check of each of the asset's owner files that has no result of the current check
 * version and no pending check. Returns how many were queued. Run in the transaction that locked
 * the asset.
 */
export async function enqueueEvidenceChecks(
  tx: Tx,
  assetId: string,
  requestedById: string | null,
  at: Date,
): Promise<number> {
  const asset = await tx.asset.findUniqueOrThrow({ where: { id: assetId } });
  if (!checksAllowed(asset)) return 0;
  const evidence = await tx.evidence.findMany({
    where: { assetId, source: "OWNER" },
    select: {
      id: true,
      source: true,
      type: true,
      mimeType: true,
      automatedChecks: { where: { checkVersion: CHECK_VERSION }, select: { id: true }, take: 1 },
    },
  });
  const unchecked = evidence.filter((e) => isCheckedEvidence(e) && e.automatedChecks.length === 0);
  if (unchecked.length === 0) return 0;
  const { count } = await tx.automatedJob.createMany({
    data: unchecked.map((e) => ({
      kind: "EVIDENCE_CHECK" as const,
      entityId: e.id,
      requestedById,
      runAfter: at,
      createdAt: at,
      updatedAt: at,
    })),
    // At most one pending check per file.
    skipDuplicates: true,
  });
  return count;
}

/** Queues a report on the verifier's application, unless one is pending. */
export async function enqueueVerifierReport(
  tx: Tx,
  verifierId: string,
  requestedById: string | null,
  at: Date,
): Promise<boolean> {
  const { count } = await tx.automatedJob.createMany({
    data: [
      {
        kind: "VERIFIER_REPORT",
        entityId: verifierId,
        requestedById,
        runAfter: at,
        createdAt: at,
        updatedAt: at,
      },
    ],
    skipDuplicates: true,
  });
  return count > 0;
}
