import {
  type Asset,
  type Attestation,
  isDatabaseError,
  type Prisma,
  type PrismaClient,
  type VerificationRequestStatus,
} from "@worthybound/database";
import {
  ATTESTABLE_ASSET_STATUSES,
  ATTESTATION_CLOCK_TOLERANCE_MS,
  ATTESTATION_LIFECYCLE,
  assertTransition,
  attestationAuthorityViolations,
  attestationMessage,
  type Lifecycle,
  requestAssignmentViolations,
  sha256Text,
  VERIFICATION_REQUEST_LIFECYCLE,
  VERIFICATION_REQUEST_TTL_MS,
} from "@worthybound/shared";
import type {
  AttestationDraftInput,
  AttestationRevokeInput,
  AttestationSubmissionInput,
  VerificationRequestInput,
  VerifierRequestListQuery,
} from "@worthybound/validation";
import { writeAudit } from "../audit.js";
import type { Actor } from "../assets/service.js";
import { verifyWalletSignature } from "../auth/siws.js";
import type { Config } from "../config.js";
import { decodeBase58, sha256Hex } from "../crypto.js";
import { ApiError, fromDomainError, notFound } from "../errors.js";
import { requirementsOf } from "../templates/view.js";
import { closeRequestsAsSystem, lockAssignedRequest } from "./requests.js";
import { requestInclude, type RequestRecord } from "./view.js";

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

export interface VerificationServiceOptions {
  prisma: PrismaClient;
  config: Pick<Config, "AUTH_DOMAIN" | "chainId">;
  now: () => Date;
}

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown) =>
  isDatabaseError(error, UNIQUE_VIOLATION) || (error as { code?: string })?.code === "P2002";

/** Discarded drafts are hidden from everyone, including their owner. */
const isDiscardedDraft = (asset: Pick<Asset, "status" | "publishedAt">) =>
  asset.status === "REVOKED" && asset.publishedAt === null;

const requestExists = () =>
  new ApiError(
    409,
    "request_exists",
    "A verification request for this template is already open for this asset",
  );

const requestExpired = () =>
  new ApiError(409, "request_expired", "This verification request has expired");

function transition<S extends string, A extends string>(
  lifecycle: Lifecycle<S, A>,
  from: S,
  to: S,
  actor: A,
): void {
  try {
    assertTransition(lifecycle, from, to, actor);
  } catch (error) {
    throw fromDomainError(error);
  }
}

const verifierInclude = {
  user: { select: { walletAddress: true, identityStatus: true } },
  categoryPermissions: { where: { status: "APPROVED" as const }, select: { category: true } },
} satisfies Prisma.VerifierInclude;

type VerifierRecord = Prisma.VerifierGetPayload<{ include: typeof verifierInclude }>;

const authorityOf = (v: VerifierRecord) => ({
  userId: v.userId,
  status: v.status,
  identityStatus: v.user.identityStatus,
  approvedCategories: v.categoryPermissions.map((p) => p.category),
});

export function createVerificationService({ prisma, config, now }: VerificationServiceOptions) {
  const loadRequest = (db: Db, id: string) =>
    db.verificationRequest.findUnique({ where: { id }, include: requestInclude });

  const loadVerifier = (db: Db, userId: string) =>
    db.verifier.findUnique({ where: { userId }, include: verifierInclude });

  /** The caller's verifier record, which must be approved with a verified identity. */
  async function activeVerifier(db: Db, actor: Actor): Promise<VerifierRecord> {
    const verifier = await loadVerifier(db, actor.userId);
    if (!verifier || verifier.status !== "APPROVED") {
      throw new ApiError(403, "verifier_not_approved", "Only approved verifiers can do this");
    }
    if (verifier.user.identityStatus !== "VERIFIED") {
      throw new ApiError(
        403,
        "identity_not_verified",
        "Your identity must be verified (KYC) to verify assets",
      );
    }
    return verifier;
  }

  async function lockOwnedAsset(tx: Tx, wbId: string, actor: Actor): Promise<Asset> {
    await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "wbId" = ${wbId} FOR UPDATE`;
    const asset = await tx.asset.findUnique({ where: { wbId } });
    if (!asset || asset.ownerId !== actor.userId || isDiscardedDraft(asset)) {
      throw notFound("Asset");
    }
    return asset;
  }

  /** Marks requests past their expiry as EXPIRED, in its own transaction. */
  async function expireOverdue(where: Prisma.VerificationRequestWhereInput) {
    const at = now();
    await prisma.$transaction((tx) =>
      closeRequestsAsSystem(
        tx,
        { ...where, expiresAt: { lte: at } },
        "EXPIRED",
        "request_expired",
        at,
      ),
    );
  }

  async function recordRequestStatus(
    tx: Tx,
    request: { id: string; status: VerificationRequestStatus },
    to: VerificationRequestStatus,
    data: Prisma.VerificationRequestUncheckedUpdateInput,
    verifierId: string | null,
    actor: Actor,
    at: Date,
    reason: string | null = null,
  ) {
    await tx.verificationRequest.update({
      where: { id: request.id },
      data: { ...data, status: to, updatedAt: at },
    });
    await tx.verificationRequestStatusEvent.create({
      data: {
        requestId: request.id,
        fromStatus: request.status,
        toStatus: to,
        verifierId,
        reason,
        actorId: actor.userId,
        createdAt: at,
      },
    });
    await writeAudit(
      tx,
      {
        actorId: actor.userId,
        action: "verification_request.status_changed",
        targetType: "verification_request",
        targetId: request.id,
        metadata: { fromStatus: request.status, toStatus: to },
      },
      actor.fp,
    );
  }

  /**
   * Checks the claim against the verifier's authority, the template, the evidence and the
   * verifier's current attestation of the same claim, and builds the exact text to sign.
   */
  async function prepareClaim(
    db: Db,
    request: { id: string; templateVersionId: string; expiresAt: Date },
    asset: Asset,
    verifier: VerifierRecord,
    draft: AttestationDraftInput,
    at: Date,
  ) {
    if (request.expiresAt <= at) throw requestExpired();
    const version = await db.verificationTemplateVersion.findUniqueOrThrow({
      where: { id: request.templateVersionId },
      include: { template: true },
    });
    const violations = attestationAuthorityViolations({
      verifier: authorityOf(verifier),
      asset,
      template: {
        status: version.status,
        category: version.template.category,
        requirements: requirementsOf(version),
      },
      claimType: draft.claimType,
      method: draft.method,
    });
    if (violations.length > 0) {
      throw new ApiError(
        403,
        "attestation_not_allowed",
        `This attestation is not allowed: ${violations.join(", ")}`,
      );
    }
    if (Math.abs(draft.issuedAt.getTime() - at.getTime()) > ATTESTATION_CLOCK_TOLERANCE_MS) {
      throw new ApiError(
        422,
        "issued_at_out_of_range",
        "issuedAt must be within 10 minutes of the current time",
      );
    }
    if (draft.expiresAt && draft.expiresAt <= at) {
      throw new ApiError(422, "already_expired", "expiresAt must be in the future");
    }

    const ids = draft.evidence.map((e) => e.evidenceId);
    const stored = await db.evidence.findMany({
      where: { id: { in: ids }, assetId: asset.id },
      select: { id: true, sha256: true, reviewStatus: true },
    });
    const byId = new Map(stored.map((e) => [e.id, e]));
    for (const item of draft.evidence) {
      const evidence = byId.get(item.evidenceId);
      if (!evidence || evidence.sha256 !== item.sha256) {
        throw new ApiError(
          422,
          "evidence_mismatch",
          "Each evidence item must belong to this asset and match its SHA-256 hash",
        );
      }
      if (evidence.reviewStatus === "REJECTED") {
        throw new ApiError(422, "evidence_rejected", "Rejected evidence cannot support a claim");
      }
    }

    const current = await db.attestation.findFirst({
      where: {
        assetId: asset.id,
        verifierId: verifier.id,
        claimType: draft.claimType,
        status: { in: ["ACTIVE", "DISPUTED"] },
      },
    });
    let superseded: Attestation | null = current;
    if (current?.status === "DISPUTED") {
      throw new ApiError(
        409,
        "attestation_disputed",
        "Your attestation of this claim is disputed and cannot be superseded",
      );
    }
    if (current && draft.supersedesId !== current.id) {
      throw new ApiError(
        409,
        "attestation_exists",
        `You already attested this claim; supersede attestation ${current.id} instead`,
      );
    }
    if (!current && draft.supersedesId) {
      superseded = await db.attestation.findFirst({
        where: {
          id: draft.supersedesId,
          assetId: asset.id,
          verifierId: verifier.id,
          claimType: draft.claimType,
          status: "EXPIRED",
        },
      });
      if (!superseded) {
        throw new ApiError(
          409,
          "invalid_supersedes",
          "Only your own current or expired attestation of the same claim can be superseded",
        );
      }
    }

    const notesSha256 = draft.notes ? await sha256Text(draft.notes) : null;
    const message = attestationMessage({
      domain: config.AUTH_DOMAIN,
      chainId: config.chainId,
      verifierAddress: verifier.user.walletAddress,
      wbId: asset.wbId,
      category: asset.category,
      templateVersionId: request.templateVersionId,
      verificationRequestId: request.id,
      claimType: draft.claimType,
      result: draft.result,
      conditionGrade: draft.conditionGrade ?? null,
      method: draft.method,
      assuranceLevel: draft.assuranceLevel,
      issuedAt: draft.issuedAt,
      expiresAt: draft.expiresAt ?? null,
      supersedesId: draft.supersedesId ?? null,
      notesSha256,
      evidence: draft.evidence,
      nonce: draft.nonce,
    });
    return { message, superseded };
  }

  /** The assigned request, for reads that do not change it. */
  async function assignedToCaller(requestId: string, actor: Actor) {
    const request = await prisma.verificationRequest.findUnique({
      where: { id: requestId },
      include: { asset: true },
    });
    const verifier = await loadVerifier(prisma, actor.userId);
    if (
      !request ||
      !verifier ||
      request.status !== "ASSIGNED" ||
      request.assignedVerifierId !== verifier.id
    ) {
      throw notFound("Verification request");
    }
    return { request, asset: request.asset, verifier };
  }

  return {
    // ─── Owner ────────────────────────────────────────────────────────────────

    async listForAsset(wbId: string, actor: Actor) {
      const asset = await prisma.asset.findUnique({ where: { wbId } });
      if (!asset || asset.ownerId !== actor.userId || isDiscardedDraft(asset)) {
        throw notFound("Asset");
      }
      await expireOverdue({ assetId: asset.id });
      return prisma.verificationRequest.findMany({
        where: { assetId: asset.id },
        include: requestInclude,
        orderBy: { id: "desc" },
      });
    },

    /** The owner asks for verification against a published template for the asset's category. */
    async open(wbId: string, input: VerificationRequestInput, actor: Actor) {
      try {
        return await prisma.$transaction(async (tx) => {
          const asset = await lockOwnedAsset(tx, wbId, actor);
          if (!ATTESTABLE_ASSET_STATUSES.includes(asset.status)) {
            throw new ApiError(
              409,
              "asset_not_verifiable",
              `An asset with status ${asset.status} cannot be verified`,
            );
          }
          const version = await tx.verificationTemplateVersion.findUnique({
            where: { id: input.templateVersionId },
            include: { template: true },
          });
          if (
            !version ||
            version.status !== "PUBLISHED" ||
            version.template.category !== asset.category
          ) {
            throw new ApiError(
              422,
              "template_unavailable",
              "Choose a published template for the asset's category",
            );
          }
          const at = now();
          await closeRequestsAsSystem(
            tx,
            { assetId: asset.id, templateVersionId: version.id, expiresAt: { lte: at } },
            "EXPIRED",
            "request_expired",
            at,
          );
          const existing = await tx.verificationRequest.findFirst({
            where: {
              assetId: asset.id,
              templateVersionId: version.id,
              status: { in: ["OPEN", "ASSIGNED"] },
            },
            select: { id: true },
          });
          if (existing) throw requestExists();
          const request = await tx.verificationRequest.create({
            data: {
              assetId: asset.id,
              requesterId: actor.userId,
              templateVersionId: version.id,
              expiresAt: new Date(at.getTime() + VERIFICATION_REQUEST_TTL_MS),
              createdAt: at,
              updatedAt: at,
            },
          });
          await tx.verificationRequestStatusEvent.create({
            data: { requestId: request.id, toStatus: "OPEN", actorId: actor.userId, createdAt: at },
          });
          await writeAudit(
            tx,
            {
              actorId: actor.userId,
              action: "verification_request.opened",
              targetType: "asset",
              targetId: asset.wbId,
              metadata: { requestId: request.id, templateVersionId: version.id },
            },
            actor.fp,
          );
          return (await loadRequest(tx, request.id)) as RequestRecord;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw requestExists();
        throw error;
      }
    },

    async cancel(requestId: string, actor: Actor) {
      const found = await prisma.verificationRequest.findUnique({
        where: { id: requestId },
        include: { asset: { select: { wbId: true, ownerId: true } } },
      });
      if (!found || found.asset.ownerId !== actor.userId) throw notFound("Verification request");
      return prisma.$transaction(async (tx) => {
        await lockOwnedAsset(tx, found.asset.wbId, actor);
        const request = await tx.verificationRequest.findUniqueOrThrow({
          where: { id: requestId },
        });
        transition(VERIFICATION_REQUEST_LIFECYCLE, request.status, "CANCELLED", "REQUESTER");
        await recordRequestStatus(
          tx,
          request,
          "CANCELLED",
          { closedReason: "cancelled_by_owner" },
          request.assignedVerifierId,
          actor,
          now(),
          "cancelled_by_owner",
        );
        return (await loadRequest(tx, requestId)) as RequestRecord;
      });
    },

    // ─── Verifier ─────────────────────────────────────────────────────────────

    /**
     * `open`: requests the verifier may take (approved category, not their own asset, not
     * expired). `mine`: requests assigned to them, including completed ones.
     */
    async queue(query: VerifierRequestListQuery, actor: Actor) {
      let where: Prisma.VerificationRequestWhereInput;
      let verifierId: string;
      if (query.scope === "open") {
        const verifier = await activeVerifier(prisma, actor);
        verifierId = verifier.id;
        where = {
          status: "OPEN",
          expiresAt: { gt: now() },
          templateVersion: { status: "PUBLISHED" },
          asset: {
            category: { in: authorityOf(verifier).approvedCategories },
            ownerId: { not: actor.userId },
            status: { in: [...ATTESTABLE_ASSET_STATUSES] },
          },
        };
      } else {
        const verifier = await loadVerifier(prisma, actor.userId);
        if (!verifier) throw new ApiError(403, "verifier_not_approved", "You are not a verifier");
        verifierId = verifier.id;
        where = { assignedVerifierId: verifier.id };
      }
      const items = await prisma.verificationRequest.findMany({
        where,
        include: requestInclude,
        orderBy: { id: "asc" },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
      const page = items.slice(0, query.limit);
      return {
        verifierId,
        items: page,
        nextCursor: items.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      };
    },

    /** A request assigned to the verifier, or an open request they may take. */
    async get(requestId: string, actor: Actor) {
      await expireOverdue({ id: requestId });
      const [request, verifier] = await Promise.all([
        loadRequest(prisma, requestId),
        loadVerifier(prisma, actor.userId),
      ]);
      if (!request || !verifier) throw notFound("Verification request");
      if (request.assignedVerifierId === verifier.id) return { request, verifierId: verifier.id };
      const eligible =
        request.status === "OPEN" &&
        request.templateVersion.status === "PUBLISHED" &&
        requestAssignmentViolations({ verifier: authorityOf(verifier), asset: request.asset })
          .length === 0;
      if (!eligible) throw notFound("Verification request");
      return { request, verifierId: verifier.id };
    },

    /** Takes an open request. The database repeats the eligibility checks. */
    async claim(requestId: string, actor: Actor) {
      await expireOverdue({ id: requestId });
      const found = await prisma.verificationRequest.findUnique({
        where: { id: requestId },
        select: { assetId: true, templateVersionId: true },
      });
      if (!found) throw notFound("Verification request");
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${found.assetId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT 1 FROM "verifiers" WHERE "userId" = ${actor.userId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT 1 FROM "verification_template_versions" WHERE "id" = ${found.templateVersionId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT 1 FROM "verification_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
        const verifier = await activeVerifier(tx, actor);
        const request = (await loadRequest(tx, requestId)) as RequestRecord;
        const violations = requestAssignmentViolations({
          verifier: authorityOf(verifier),
          asset: request.asset,
        });
        if (violations.length > 0 || request.templateVersion.status !== "PUBLISHED") {
          throw notFound("Verification request");
        }
        if (request.status === "EXPIRED") throw requestExpired();
        if (request.status !== "OPEN") {
          throw new ApiError(409, "request_not_open", "This request is no longer open");
        }
        const at = now();
        if (request.expiresAt <= at) throw requestExpired();
        transition(VERIFICATION_REQUEST_LIFECYCLE, request.status, "ASSIGNED", "VERIFIER");
        await recordRequestStatus(
          tx,
          request,
          "ASSIGNED",
          { assignedVerifierId: verifier.id, assignedAt: at },
          verifier.id,
          actor,
          at,
        );
        return {
          request: (await loadRequest(tx, requestId)) as RequestRecord,
          verifierId: verifier.id,
        };
      });
    },

    /** Hands the request back to the queue. Attestations already made stay. */
    async release(requestId: string, actor: Actor) {
      return prisma.$transaction(async (tx) => {
        const { request, verifier } = await lockAssignedRequest(tx, requestId, actor.userId);
        transition(VERIFICATION_REQUEST_LIFECYCLE, request.status, "OPEN", "VERIFIER");
        await recordRequestStatus(
          tx,
          request,
          "OPEN",
          { assignedVerifierId: null, assignedAt: null },
          null,
          actor,
          now(),
        );
        return {
          request: (await loadRequest(tx, requestId)) as RequestRecord,
          verifierId: verifier?.id as string,
        };
      });
    },

    /** Finishes the request; at least one attestation must have been made under it. */
    async complete(requestId: string, actor: Actor) {
      return prisma.$transaction(async (tx) => {
        const { request, verifier } = await lockAssignedRequest(tx, requestId, actor.userId);
        const made = await tx.attestation.count({ where: { verificationRequestId: requestId } });
        if (made === 0) {
          throw new ApiError(
            409,
            "no_attestations",
            "Sign at least one attestation before completing the request",
          );
        }
        transition(VERIFICATION_REQUEST_LIFECYCLE, request.status, "COMPLETED", "VERIFIER");
        const at = now();
        await recordRequestStatus(
          tx,
          request,
          "COMPLETED",
          { completedAt: at },
          request.assignedVerifierId,
          actor,
          at,
        );
        return {
          request: (await loadRequest(tx, requestId)) as RequestRecord,
          verifierId: verifier?.id as string,
        };
      });
    },

    /** The exact text the verifier's wallet must sign for this claim. Nothing is stored. */
    async attestationMessage(requestId: string, draft: AttestationDraftInput, actor: Actor) {
      const { request, asset, verifier } = await assignedToCaller(requestId, actor);
      const active = await activeVerifier(prisma, actor);
      const { message } = await prepareClaim(prisma, request, asset, active, draft, now());
      return { message, verifierAddress: verifier.user.walletAddress };
    },

    /**
     * Records a signed attestation. The server rebuilds the message from the submitted claim and
     * accepts it only with a valid Ed25519 signature by the verifier's wallet over that text.
     */
    async attest(requestId: string, input: AttestationSubmissionInput, actor: Actor) {
      await expireOverdue({ id: requestId });
      try {
        return await prisma.$transaction(async (tx) => {
          const { request, asset } = await lockAssignedRequest(tx, requestId, actor.userId);
          const verifier = await activeVerifier(tx, actor);
          const at = now();
          const { signature, ...draft } = input;
          const { message, superseded } = await prepareClaim(
            tx,
            request,
            asset,
            verifier,
            draft,
            at,
          );
          const signatureBytes = decodeBase58(signature);
          if (
            !signatureBytes ||
            !verifyWalletSignature(
              verifier.user.walletAddress,
              new TextEncoder().encode(message),
              signatureBytes,
            )
          ) {
            throw new ApiError(
              422,
              "invalid_signature",
              "The signature is not a valid signature of this attestation by your wallet",
            );
          }
          const reused = await tx.attestation.findUnique({
            where: { verifierId_nonce: { verifierId: verifier.id, nonce: draft.nonce } },
            select: { id: true },
          });
          if (reused) {
            throw new ApiError(409, "nonce_reused", "This nonce was already used; sign again");
          }

          if (superseded) {
            transition(ATTESTATION_LIFECYCLE, superseded.status, "SUPERSEDED", "SYSTEM");
            await tx.attestation.update({
              where: { id: superseded.id },
              data: { status: "SUPERSEDED", updatedAt: at },
            });
            await tx.attestationStatusEvent.create({
              data: {
                attestationId: superseded.id,
                fromStatus: superseded.status,
                toStatus: "SUPERSEDED",
                reason: "superseded",
                actorId: null,
                createdAt: at,
              },
            });
          }
          const attestation = await tx.attestation.create({
            data: {
              assetId: asset.id,
              verifierId: verifier.id,
              verificationRequestId: request.id,
              templateVersionId: request.templateVersionId,
              claimType: draft.claimType,
              result: draft.result,
              method: draft.method,
              assuranceLevel: draft.assuranceLevel,
              conditionGrade: draft.conditionGrade ?? null,
              notes: draft.notes ?? null,
              nonce: draft.nonce,
              signedMessage: message,
              signedPayloadHash: sha256Hex(message),
              signature,
              issuedAt: draft.issuedAt,
              expiresAt: draft.expiresAt ?? null,
              supersedesId: superseded?.id ?? null,
              createdAt: at,
              updatedAt: at,
            },
          });
          if (draft.evidence.length > 0) {
            await tx.attestationEvidence.createMany({
              data: draft.evidence.map((e) => ({
                attestationId: attestation.id,
                evidenceId: e.evidenceId,
                sha256: e.sha256,
              })),
            });
          }
          await tx.attestationStatusEvent.create({
            data: {
              attestationId: attestation.id,
              toStatus: "ACTIVE",
              actorId: actor.userId,
              createdAt: at,
            },
          });
          await tx.provenanceEvent.create({
            data: {
              assetId: asset.id,
              type: "ATTESTATION_ADDED",
              actorId: actor.userId,
              occurredAt: at,
              payload: {
                attestationId: attestation.id,
                verifierId: verifier.id,
                claimType: draft.claimType,
                result: draft.result,
                signedPayloadHash: attestation.signedPayloadHash,
                supersedesId: superseded?.id ?? null,
              },
            },
          });
          await writeAudit(
            tx,
            {
              actorId: actor.userId,
              action: "attestation.created",
              targetType: "asset",
              targetId: asset.wbId,
              metadata: {
                attestationId: attestation.id,
                verificationRequestId: request.id,
                claimType: draft.claimType,
                result: draft.result,
                ...(superseded ? { supersedesId: superseded.id } : {}),
              },
            },
            actor.fp,
          );
          return tx.attestation.findUniqueOrThrow({
            where: { id: attestation.id },
            include: { evidence: true, asset: { select: { wbId: true } } },
          });
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(
            409,
            "attestation_conflict",
            "Another attestation of this claim was recorded at the same time",
          );
        }
        throw error;
      }
    },

    /** The issuer withdraws their attestation, with a reason; not while it is disputed. */
    async revoke(attestationId: string, input: AttestationRevokeInput, actor: Actor) {
      const found = await prisma.attestation.findUnique({
        where: { id: attestationId },
        select: { assetId: true, verifier: { select: { userId: true } } },
      });
      if (!found || found.verifier.userId !== actor.userId) throw notFound("Attestation");
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "assets" WHERE "id" = ${found.assetId}::uuid FOR UPDATE`;
        const attestation = await tx.attestation.findUniqueOrThrow({
          where: { id: attestationId },
          include: { asset: { select: { wbId: true } } },
        });
        transition(ATTESTATION_LIFECYCLE, attestation.status, "REVOKED", "VERIFIER");
        const at = now();
        await tx.attestation.update({
          where: { id: attestationId },
          data: { status: "REVOKED", updatedAt: at },
        });
        await tx.attestationStatusEvent.create({
          data: {
            attestationId,
            fromStatus: attestation.status,
            toStatus: "REVOKED",
            reason: input.reason,
            actorId: actor.userId,
            createdAt: at,
          },
        });
        await tx.provenanceEvent.create({
          data: {
            assetId: attestation.assetId,
            type: "ATTESTATION_REVOKED",
            actorId: actor.userId,
            occurredAt: at,
            payload: { attestationId, claimType: attestation.claimType },
          },
        });
        await writeAudit(
          tx,
          {
            actorId: actor.userId,
            action: "attestation.revoked",
            targetType: "asset",
            targetId: attestation.asset.wbId,
            metadata: { attestationId, fromStatus: attestation.status },
          },
          actor.fp,
        );
        return tx.attestation.findUniqueOrThrow({
          where: { id: attestationId },
          include: { evidence: true, asset: { select: { wbId: true } } },
        });
      });
    },
  };
}

export type VerificationService = ReturnType<typeof createVerificationService>;
