import type {
  AssetStatus,
  AttestationStatus,
  CategoryPermissionStatus,
  DisputeStatus,
  ReviewStatus,
  TemplateVersionStatus,
  TransferStatus,
  VerificationRequestStatus,
  VerifierStatus,
} from "./enums.js";
import { DomainError } from "./errors.js";

/**
 * Allowed status changes and the actors who may make them. Actors are roles relative to the
 * record (e.g. the asset OWNER); identity rules such as "no self-approval" are enforced by the
 * database and services. SYSTEM is the backend acting on recorded facts (expiry, chain
 * confirmation, template evaluation), never a user request.
 */
export interface Lifecycle<S extends string, A extends string> {
  readonly name: string;
  readonly transitions: { readonly [From in S]: { readonly [To in S]?: readonly A[] } };
}

function actorsFor<S extends string, A extends string>(
  lifecycle: Lifecycle<S, A>,
  from: S,
  to: S,
): readonly A[] | undefined {
  return lifecycle.transitions[from][to];
}

export function canTransition<S extends string, A extends string>(
  lifecycle: Lifecycle<S, A>,
  from: S,
  to: S,
  actor: A,
): boolean {
  return actorsFor(lifecycle, from, to)?.includes(actor) ?? false;
}

/** Throws INVALID_TRANSITION if the change never happens, FORBIDDEN_TRANSITION if the actor may not make it. */
export function assertTransition<S extends string, A extends string>(
  lifecycle: Lifecycle<S, A>,
  from: S,
  to: S,
  actor: A,
): void {
  const actors = actorsFor(lifecycle, from, to);
  if (!actors) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `${lifecycle.name}: ${from} -> ${to} is not allowed`,
    );
  }
  if (!actors.includes(actor)) {
    throw new DomainError(
      "FORBIDDEN_TRANSITION",
      `${lifecycle.name}: ${actor} may not change ${from} -> ${to}`,
    );
  }
}

/** Statuses reachable from `from`, optionally only those the actor may set. */
export function nextStatuses<S extends string, A extends string>(
  lifecycle: Lifecycle<S, A>,
  from: S,
  actor?: A,
): S[] {
  const targets = lifecycle.transitions[from];
  return (Object.keys(targets) as S[]).filter(
    (to) => actor === undefined || (targets[to]?.includes(actor) ?? false),
  );
}

export function isTerminal<S extends string, A extends string>(
  lifecycle: Lifecycle<S, A>,
  status: S,
): boolean {
  return Object.keys(lifecycle.transitions[status]).length === 0;
}

// ─── Assets ───────────────────────────────────────────────────────────────────

export type AssetActor = "OWNER" | "ADMIN" | "SYSTEM";

const REPORT: readonly AssetActor[] = ["OWNER", "ADMIN"];
const ADMIN_ONLY = ["ADMIN"] as const;
const SYSTEM_ONLY = ["SYSTEM"] as const;

/**
 * DRAFT: private. TOKENIZED: registered on-chain, passport not yet published. ACTIVE: public
 * passport. VERIFIED is set only by the system when the template's requirements are met; no
 * person can mark an asset verified. Transfers start only from ACTIVE, VERIFIED or
 * REVERIFICATION_REQUIRED (ADR 0002). Recovered assets always need reverification, and only an
 * admin can clear a stolen report. REVOKED is final.
 */
export const ASSET_LIFECYCLE: Lifecycle<AssetStatus, AssetActor> = {
  name: "asset",
  transitions: {
    DRAFT: { TOKENIZED: SYSTEM_ONLY, ACTIVE: ["OWNER"], REVOKED: ["OWNER", "ADMIN"] },
    TOKENIZED: {
      ACTIVE: ["OWNER"],
      DISPUTED: ADMIN_ONLY,
      REPORTED_LOST: REPORT,
      REPORTED_STOLEN: REPORT,
      REVOKED: ADMIN_ONLY,
    },
    ACTIVE: {
      VERIFIED: SYSTEM_ONLY,
      TRANSFER_PENDING: ["OWNER"],
      DISPUTED: ADMIN_ONLY,
      REPORTED_LOST: REPORT,
      REPORTED_STOLEN: REPORT,
      REVOKED: ADMIN_ONLY,
    },
    VERIFIED: {
      ACTIVE: SYSTEM_ONLY,
      REVERIFICATION_REQUIRED: ["SYSTEM", "ADMIN"],
      TRANSFER_PENDING: ["OWNER"],
      DISPUTED: ADMIN_ONLY,
      REPORTED_LOST: REPORT,
      REPORTED_STOLEN: REPORT,
      REVOKED: ADMIN_ONLY,
    },
    TRANSFER_PENDING: {
      ACTIVE: SYSTEM_ONLY,
      VERIFIED: SYSTEM_ONLY,
      REVERIFICATION_REQUIRED: SYSTEM_ONLY,
      DISPUTED: ADMIN_ONLY,
      REPORTED_LOST: REPORT,
      REPORTED_STOLEN: REPORT,
      REVOKED: ADMIN_ONLY,
    },
    REVERIFICATION_REQUIRED: {
      VERIFIED: SYSTEM_ONLY,
      ACTIVE: ADMIN_ONLY,
      TRANSFER_PENDING: ["OWNER"],
      DISPUTED: ADMIN_ONLY,
      REPORTED_LOST: REPORT,
      REPORTED_STOLEN: REPORT,
      REVOKED: ADMIN_ONLY,
    },
    DISPUTED: {
      ACTIVE: ADMIN_ONLY,
      REVERIFICATION_REQUIRED: ADMIN_ONLY,
      REPORTED_LOST: REPORT,
      REPORTED_STOLEN: REPORT,
      REVOKED: ADMIN_ONLY,
    },
    REPORTED_LOST: {
      REPORTED_STOLEN: REPORT,
      REVERIFICATION_REQUIRED: REPORT,
      REVOKED: ADMIN_ONLY,
    },
    REPORTED_STOLEN: { REVERIFICATION_REQUIRED: ADMIN_ONLY, REVOKED: ADMIN_ONLY },
    REVOKED: {},
  },
};

// ─── Verifiers ────────────────────────────────────────────────────────────────

export type VerifierActor = "APPLICANT" | "REVIEWER" | "ADMIN" | "SYSTEM";

const REVIEW: readonly VerifierActor[] = ["REVIEWER", "ADMIN"];

/** Verifiers never approve themselves. Revocation is final and admin-only. */
export const VERIFIER_LIFECYCLE: Lifecycle<VerifierStatus, VerifierActor> = {
  name: "verifier",
  transitions: {
    APPLIED: { UNDER_REVIEW: REVIEW, REJECTED: REVIEW },
    UNDER_REVIEW: { APPROVED: REVIEW, REJECTED: REVIEW },
    APPROVED: { SUSPENDED: ["REVIEWER", "ADMIN", "SYSTEM"], REVOKED: ADMIN_ONLY },
    SUSPENDED: { APPROVED: REVIEW, REVOKED: ADMIN_ONLY },
    REJECTED: { APPLIED: ["APPLICANT"] },
    REVOKED: {},
  },
};

export type CategoryPermissionActor = "REVIEWER" | "ADMIN" | "SYSTEM";

/** Category permissions are granted one category at a time; a rejected request is revoked. */
export const CATEGORY_PERMISSION_LIFECYCLE: Lifecycle<
  CategoryPermissionStatus,
  CategoryPermissionActor
> = {
  name: "category permission",
  transitions: {
    PENDING: { APPROVED: ["REVIEWER", "ADMIN"], REVOKED: ["REVIEWER", "ADMIN"] },
    APPROVED: { SUSPENDED: ["REVIEWER", "ADMIN", "SYSTEM"], REVOKED: ADMIN_ONLY },
    SUSPENDED: { APPROVED: ["REVIEWER", "ADMIN"], REVOKED: ADMIN_ONLY },
    REVOKED: {},
  },
};

// ─── Verification ─────────────────────────────────────────────────────────────

export type TemplateVersionActor = "ADMIN";

/** Matches the database: published versions are immutable and can only be retired. */
export const TEMPLATE_VERSION_LIFECYCLE: Lifecycle<TemplateVersionStatus, TemplateVersionActor> = {
  name: "template version",
  transitions: {
    DRAFT: { PUBLISHED: ADMIN_ONLY },
    PUBLISHED: { RETIRED: ADMIN_ONLY },
    RETIRED: {},
  },
};

export type VerificationRequestActor = "REQUESTER" | "VERIFIER" | "ADMIN" | "SYSTEM";

export const VERIFICATION_REQUEST_LIFECYCLE: Lifecycle<
  VerificationRequestStatus,
  VerificationRequestActor
> = {
  name: "verification request",
  transitions: {
    OPEN: {
      ASSIGNED: ["VERIFIER", "ADMIN"],
      CANCELLED: ["REQUESTER", "ADMIN"],
      EXPIRED: SYSTEM_ONLY,
    },
    ASSIGNED: {
      OPEN: ["VERIFIER", "ADMIN"],
      COMPLETED: ["VERIFIER", "SYSTEM"],
      CANCELLED: ["REQUESTER", "ADMIN"],
      EXPIRED: SYSTEM_ONLY,
    },
    COMPLETED: {},
    CANCELLED: {},
    EXPIRED: {},
  },
};

/** VERIFIER is the attestation's issuer. */
export type AttestationActor = "VERIFIER" | "ADMIN" | "SYSTEM";

/**
 * Matches the database: REVOKED and SUPERSEDED are final. Attestations are never deleted; an
 * issuer may revoke their own attestation, but not while it is disputed.
 */
export const ATTESTATION_LIFECYCLE: Lifecycle<AttestationStatus, AttestationActor> = {
  name: "attestation",
  transitions: {
    ACTIVE: {
      EXPIRED: SYSTEM_ONLY,
      SUPERSEDED: SYSTEM_ONLY,
      DISPUTED: ADMIN_ONLY,
      REVOKED: ["VERIFIER", "ADMIN"],
    },
    EXPIRED: { SUPERSEDED: SYSTEM_ONLY, DISPUTED: ADMIN_ONLY, REVOKED: ["VERIFIER", "ADMIN"] },
    DISPUTED: { ACTIVE: ADMIN_ONLY, EXPIRED: SYSTEM_ONLY, REVOKED: ADMIN_ONLY },
    SUPERSEDED: {},
    REVOKED: {},
  },
};

export type EvidenceReviewActor = "VERIFIER" | "ADMIN";

export const EVIDENCE_REVIEW_LIFECYCLE: Lifecycle<ReviewStatus, EvidenceReviewActor> = {
  name: "evidence review",
  transitions: {
    PENDING: { ACCEPTED: ["VERIFIER", "ADMIN"], REJECTED: ["VERIFIER", "ADMIN"] },
    ACCEPTED: {},
    REJECTED: {},
  },
};

// ─── Transfers and disputes ───────────────────────────────────────────────────

export type TransferActor = "SENDER" | "RECIPIENT" | "ADMIN" | "SYSTEM";

/** Only the recipient accepts; only the system completes, after the on-chain transfer confirms. */
export const TRANSFER_LIFECYCLE: Lifecycle<TransferStatus, TransferActor> = {
  name: "transfer",
  transitions: {
    PENDING: {
      ACCEPTED: ["RECIPIENT"],
      REJECTED: ["RECIPIENT"],
      CANCELLED: ["SENDER", "ADMIN", "SYSTEM"],
      EXPIRED: SYSTEM_ONLY,
    },
    ACCEPTED: {
      COMPLETED: SYSTEM_ONLY,
      CANCELLED: ["SENDER", "RECIPIENT", "ADMIN", "SYSTEM"],
      EXPIRED: SYSTEM_ONLY,
    },
    COMPLETED: {},
    REJECTED: {},
    CANCELLED: {},
    EXPIRED: {},
  },
};

export type DisputeActor = "OPENER" | "ADMIN";

export const DISPUTE_LIFECYCLE: Lifecycle<DisputeStatus, DisputeActor> = {
  name: "dispute",
  transitions: {
    OPEN: { UNDER_REVIEW: ADMIN_ONLY, REJECTED: ADMIN_ONLY, WITHDRAWN: ["OPENER"] },
    UNDER_REVIEW: { UPHELD: ADMIN_ONLY, REJECTED: ADMIN_ONLY, WITHDRAWN: ["OPENER"] },
    UPHELD: {},
    REJECTED: {},
    WITHDRAWN: {},
  },
};
