import type {
  Asset,
  CaptureSession,
  Evidence,
  PurchaseCheck,
  PurchaseCheckPhoto,
} from "@worthybound/database";
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  CAPTURE_SHOT_INSTRUCTIONS,
  CAPTURE_SHOTS,
  type CaptureShot,
  ITEM_MATCH_REASONS,
  ITEM_MATCH_RESULTS,
  type ItemMatchReason,
  ownerConfirmationMessage,
  PURCHASE_CHECK_KINDS,
  PURCHASE_CHECK_STATUSES,
  publicEvidencePath,
  REMOTE_CODE_RESULTS,
  type RemoteCodeResult,
  VERIFICATION_LEVELS,
} from "@worthybound/shared";
import { z } from "zod";
import { captureSessionSchema, type SessionRecord, toCaptureSession } from "../capture/view.js";
import type { EvidenceCheckView } from "../checks/view.js";

export type CheckRecord = PurchaseCheck & {
  asset: Asset;
  photos: Pick<PurchaseCheckPhoto, "shot" | "createdAt">[];
  /** A remote check's latest capture session, if the seller started one. */
  captureSessions: (Pick<CaptureSession, "ownerId" | "status" | "expiresAt" | "completedAt"> & {
    evidence: Pick<Evidence, "id" | "captureShot" | "createdAt">[];
  })[];
};

export type RemoteRequestRecord = PurchaseCheck & { captureSessions: SessionRecord[] };

export type RecordedPhoto = Pick<Evidence, "id" | "publicStorageKey">;

/**
 * The AI check of a filmed remote check's code photo; `check` is null when none was queued.
 * Null for in-person checks and until the seller films.
 */
export type CodePhotoCheck = { check: EvidenceCheckView | null } | null;

function codeResult({ check }: NonNullable<CodePhotoCheck>): RemoteCodeResult {
  if (!check) return "UNAVAILABLE";
  if (check.status === "PENDING" || check.status === "UNAVAILABLE") return check.status;
  if (check.problems.includes("CAPTURE_CODE_MISMATCH")) return "MISMATCH";
  if (check.problems.includes("CAPTURE_CODE_MISSING")) return "MISSING";
  if (check.status === "FAILED") return "FAILED";
  return check.status === "PASSED" ? "SHOWN" : "UNCLEAR";
}

/** Asset statuses in which the item cannot be transferred. */
const BLOCKED = ["REPORTED_LOST", "REPORTED_STOLEN", "DISPUTED", "REVOKED"] as const;

/** The buyer's view of a check. Never names the seller's wallet or identity. */
export const purchaseCheckSchema = z.object({
  id: z.uuid(),
  kind: z.enum(PURCHASE_CHECK_KINDS),
  status: z.enum(PURCHASE_CHECK_STATUSES),
  asset: z.object({
    wbId: z.string(),
    category: z.enum(ASSET_CATEGORIES),
    brand: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(ASSET_STATUSES),
    verificationLevel: z.enum(VERIFICATION_LEVELS),
    /** Lost, stolen, disputed or revoked: the item cannot be transferred. */
    transferBlocked: z.boolean(),
  }),
  owner: z.object({
    /**
     * The current owner signed the buyer's code with the owner's wallet or, remotely, filmed the
     * item with it.
     */
    confirmed: z.boolean(),
    confirmedAt: z.iso.datetime().nullable(),
    /**
     * Code for the seller to sign, while it is valid and not yet signed. Remotely, the code the
     * seller shows in the video, always shown so the buyer can look for it.
     */
    code: z.string().nullable(),
    /** Until when the seller can sign or film. */
    codeExpiresAt: z.iso.datetime().nullable(),
    /** What the seller's wallet shows when signing; null for remote checks. */
    message: z.string().nullable(),
    /** Remotely, once filmed: what the AI check found in the seller's code photo. */
    codeCheck: z.enum(REMOTE_CODE_RESULTS).nullable(),
  }),
  item: z.object({
    shots: z.array(
      z.object({
        shot: z.enum(CAPTURE_SHOTS),
        instruction: z.string(),
        receivedAt: z.iso.datetime().nullable(),
      }),
    ),
    /** Every photo arrived and the comparison is running. */
    comparing: z.boolean(),
    /** The seller's video for a remote check can be watched. */
    videoAvailable: z.boolean(),
    result: z.enum(ITEM_MATCH_RESULTS).nullable(),
    /** Why the result is inconclusive without a comparison. */
    reason: z.string().nullable(),
    checkedAt: z.iso.datetime().nullable(),
    /** Public copies of the recorded photos that were compared; private ones are never shown. */
    recordedPhotos: z.array(z.object({ path: z.string() })),
  }),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type PurchaseCheckView = z.infer<typeof purchaseCheckSchema>;

const iso = (date: Date | null) => date?.toISOString() ?? null;

export function toPurchaseCheck(
  check: CheckRecord,
  recorded: RecordedPhoto[],
  codeCheck: CodePhotoCheck,
  at: Date,
): PurchaseCheckView {
  const { asset } = check;
  const remote = check.kind === "REMOTE";
  const inPerson = check.kind === "IN_PERSON";
  const session = check.captureSessions[0];
  const filming = session && (session.status === "COMPLETED" || session.expiresAt > at);
  const taken = new Map<string | null, Date>(
    remote
      ? filming
        ? session.evidence.map((e) => [e.captureShot, e.createdAt])
        : []
      : check.photos.map((p) => [p.shot, p.createdAt]),
  );
  const filmed = session?.status === "COMPLETED" && session.ownerId === asset.ownerId;
  const confirmed = remote
    ? filmed
    : check.ownerConfirmedAt !== null && check.ownerConfirmedById === asset.ownerId;
  const expired =
    check.status === "OPEN" && check.photosCompletedAt === null && check.expiresAt <= at;
  const codeValid = !inPerson
    ? check.status === "OPEN" && check.photosCompletedAt === null && !expired
    : check.status === "OPEN" &&
      check.ownerConfirmedAt === null &&
      check.ownerCodeExpiresAt > at &&
      check.expiresAt > at;
  return {
    id: check.id,
    kind: check.kind,
    status: expired ? "EXPIRED" : check.status,
    asset: {
      wbId: asset.wbId,
      category: asset.category,
      brand: asset.brand,
      model: asset.model,
      status: asset.status,
      verificationLevel: asset.verificationLevel,
      transferBlocked: (BLOCKED as readonly string[]).includes(asset.status),
    },
    owner: {
      confirmed,
      confirmedAt: confirmed
        ? iso(remote ? (session?.completedAt ?? null) : check.ownerConfirmedAt)
        : null,
      code: codeValid || !inPerson ? check.ownerCode : null,
      codeExpiresAt: codeValid ? iso(check.ownerCodeExpiresAt) : null,
      message: codeValid && inPerson ? ownerConfirmationMessage(asset.wbId, check.ownerCode) : null,
      codeCheck: codeCheck ? codeResult(codeCheck) : null,
    },
    item: {
      shots: (check.shots as CaptureShot[]).map((shot) => ({
        shot,
        instruction: CAPTURE_SHOT_INSTRUCTIONS[shot],
        receivedAt: iso(taken.get(shot) ?? null),
      })),
      comparing: check.photosCompletedAt !== null && check.itemResult === null,
      videoAvailable: remote && filmed,
      result: check.itemResult,
      reason: check.itemReason
        ? (ITEM_MATCH_REASONS[check.itemReason as ItemMatchReason] ?? null)
        : null,
      checkedAt: iso(check.itemCheckedAt),
      recordedPhotos: recorded
        .filter((e) => e.publicStorageKey !== null && check.referenceEvidenceIds.includes(e.id))
        .map((e) => ({ path: publicEvidencePath(asset.wbId, e.id) })),
    },
    expiresAt: check.expiresAt.toISOString(),
    createdAt: check.createdAt.toISOString(),
  };
}

/** The owner's view of a remote check of their asset. Never names the buyer. */
export const remoteRequestSchema = z.object({
  id: z.uuid(),
  /** Write this on paper and keep it in view while filming. */
  code: z.string(),
  expiresAt: z.iso.datetime(),
  /** The item was filmed and the buyer can see the result. */
  filmed: z.boolean(),
  /** The latest capture session for the check, if one was started. */
  session: captureSessionSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type RemoteRequestView = z.infer<typeof remoteRequestSchema>;

export function toRemoteRequest(check: RemoteRequestRecord, at: Date): RemoteRequestView {
  const session = check.captureSessions[0];
  return {
    id: check.id,
    code: check.ownerCode,
    expiresAt: check.expiresAt.toISOString(),
    filmed: check.photosCompletedAt !== null,
    session: session ? toCaptureSession(session, at) : null,
    createdAt: check.createdAt.toISOString(),
  };
}
