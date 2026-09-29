import type { Asset, Prisma, PrismaClient, VerificationRequestStatus } from "@worthybound/database";
import { assertTransition, VERIFICATION_REQUEST_LIFECYCLE } from "@worthybound/shared";
import { writeAudit } from "../audit.js";
import { notFound } from "../errors.js";

type Tx = Prisma.TransactionClient;

/** Why the system released or closed a request; shown to the owner and the verifier. */
export type SystemReason =
  | "verifier_suspended"
  | "verifier_revoked"
  | "verifier_identity_not_verified"
  | "category_permission_withdrawn"
  | "asset_unavailable"
  | "template_retired"
  | "request_expired";

/**
 * Moves requests to `to` as the SYSTEM actor, recording a status event and an audit entry for
 * each. Used when the facts behind a request change: the verifier loses their authority
 * (ASSIGNED -> OPEN), the asset or template can no longer be used (-> CANCELLED) or the request
 * has run out of time (-> EXPIRED).
 */
export async function closeRequestsAsSystem(
  tx: Tx,
  where: Prisma.VerificationRequestWhereInput,
  to: Extract<VerificationRequestStatus, "OPEN" | "CANCELLED" | "EXPIRED">,
  reason: SystemReason,
  at: Date,
): Promise<number> {
  const requests = await tx.verificationRequest.findMany({
    where: { ...where, status: { in: to === "OPEN" ? ["ASSIGNED"] : ["OPEN", "ASSIGNED"] } },
    select: { id: true, status: true, assetId: true, assignedVerifierId: true },
  });
  for (const request of requests) {
    assertTransition(VERIFICATION_REQUEST_LIFECYCLE, request.status, to, "SYSTEM");
    await tx.verificationRequest.update({
      where: { id: request.id },
      data:
        to === "OPEN"
          ? { status: to, assignedVerifierId: null, assignedAt: null, updatedAt: at }
          : { status: to, closedReason: reason, updatedAt: at },
    });
    await tx.verificationRequestStatusEvent.create({
      data: {
        requestId: request.id,
        fromStatus: request.status,
        toStatus: to,
        verifierId: to === "OPEN" ? null : request.assignedVerifierId,
        reason,
        actorId: null,
        createdAt: at,
      },
    });
    await writeAudit(
      tx,
      {
        actorId: null,
        action: "verification_request.status_changed",
        targetType: "verification_request",
        targetId: request.id,
        metadata: { fromStatus: request.status, toStatus: to, reason, via: "system" },
      },
      null,
    );
  }
  return requests.length;
}

/** Releases every request assigned to the verifier, e.g. on suspension. */
export const releaseVerifierRequests = (
  tx: Tx,
  verifierId: string,
  reason: SystemReason,
  at: Date,
  where: Prisma.VerificationRequestWhereInput = {},
) => closeRequestsAsSystem(tx, { ...where, assignedVerifierId: verifierId }, "OPEN", reason, at);

/**
 * Locks, in this order, the request's asset, the verifier (shared, so a concurrent suspension
 * waits) and the request, and returns them if the request is assigned to the user's verifier.
 * Every write that relies on an assignment takes the locks in the same order. Requests the user
 * is not assigned to answer 404, as for unknown IDs.
 */
export async function lockAssignedRequest(tx: Tx, requestId: string, userId: string) {
  const found = await tx.verificationRequest.findUnique({
    where: { id: requestId },
    select: { assetId: true },
  });
  if (!found) throw notFound("Verification request");
  await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${found.assetId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT 1 FROM "verifiers" WHERE "userId" = ${userId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT 1 FROM "verification_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
  const request = await tx.verificationRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      asset: true,
      assignedVerifier: {
        include: { user: { select: { walletAddress: true, identityStatus: true } } },
      },
    },
  });
  if (request.status !== "ASSIGNED" || request.assignedVerifier?.userId !== userId) {
    throw notFound("Verification request");
  }
  const { asset, assignedVerifier: verifier, ...rest } = request;
  return { request: rest, asset: asset as Asset, verifier };
}

/** The request if it is assigned to the user's verifier, for reads; otherwise 404. */
export async function findAssignedRequest(
  db: Tx | PrismaClient,
  requestId: string,
  userId: string,
) {
  const request = await db.verificationRequest.findUnique({
    where: { id: requestId },
    include: { asset: true, assignedVerifier: { select: { userId: true } } },
  });
  if (request?.status !== "ASSIGNED" || request.assignedVerifier?.userId !== userId) {
    throw notFound("Verification request");
  }
  return request;
}
