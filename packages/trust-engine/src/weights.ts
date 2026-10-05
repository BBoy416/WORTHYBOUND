import type { TrustWeights } from "./types.js";

const NO_DECAY = { halfLifeDays: null, minFactor: 1 } as const;

/**
 * Default weights. Changing any value requires a new `version` so that stored
 * snapshots remain reproducible.
 */
export const DEFAULT_WEIGHTS: TrustWeights = {
  version: "weights-2026.5",
  typePoints: {
    PHOTO: 2,
    RECEIPT: 8,
    CERTIFICATE: 8,
    PROVENANCE: 8,
    SERIAL_NUMBER: 6,
    POSSESSION: 6,
    CONDITION: 4,
    INSPECTION: 20,
    AUTHENTICATION: 25,
    APPRAISAL: 8,
    PHYSICAL_EXISTENCE: 4,
    IDENTITY_OF_PRESENTER: 2,
    DOCUMENTATION: 6,
    OWNERSHIP_CLAIM: 2,
  },
  sourceMultiplier: {
    OWNER: 1,
    THIRD_PARTY: 1.5,
    VERIFIER: 2,
    MANUFACTURER: 2.5,
    AUTOMATED: 1.5,
  },
  sourceCeiling: {
    OWNER: 30,
    THIRD_PARTY: 15,
    VERIFIER: 60,
    MANUFACTURER: 40,
    AUTOMATED: 20,
  },
  freshness: {
    PHOTO: { halfLifeDays: 730, minFactor: 0.25 },
    RECEIPT: NO_DECAY,
    CERTIFICATE: NO_DECAY,
    PROVENANCE: NO_DECAY,
    SERIAL_NUMBER: NO_DECAY,
    POSSESSION: { halfLifeDays: 365, minFactor: 0.25 },
    CONDITION: { halfLifeDays: 365, minFactor: 0.25 },
    INSPECTION: { halfLifeDays: 730, minFactor: 0.25 },
    AUTHENTICATION: { halfLifeDays: 1825, minFactor: 0.5 },
    APPRAISAL: { halfLifeDays: 365, minFactor: 0.25 },
    PHYSICAL_EXISTENCE: { halfLifeDays: 365, minFactor: 0.25 },
    IDENTITY_OF_PRESENTER: { halfLifeDays: 365, minFactor: 0.25 },
    DOCUMENTATION: NO_DECAY,
    OWNERSHIP_CLAIM: { halfLifeDays: 365, minFactor: 0.25 },
  },
  repeatDecay: 0.5,
  suspendedSourceMultiplier: 0.5,
  capturedMultiplier: 1.5,
  identity: {
    walletVerified: 2,
    identityVerified: 8,
  },
  custodyContinuity: 5,
  independence: {
    pointsPerAdditionalSource: 5,
    maxPoints: 10,
  },
  caps: {
    selfDocumented: 35,
    selfDocumentedIdentityVerified: 45,
    automatedChecksPassed: 65,
    withoutReview: 60,
    oneOnlineReview: 75,
    twoOnlineReviews: 80,
    oneInPersonInspection: 85,
    onlineReviewAndInPersonInspection: 90,
  },
  statusCaps: {
    DISPUTED: 40,
    REPORTED_LOST: 25,
    REPORTED_STOLEN: 10,
    REVOKED: 0,
  },
  deductions: {
    openDispute: { points: 15, max: 30 },
    contradictedClaim: { points: 20, max: 40 },
    revokedProof: { points: 10, max: 30 },
    suspendedSource: { points: 3, max: 9 },
    missingRequiredEvidence: { points: 3, max: 15 },
    failedAutomatedCheck: { points: 10, max: 30 },
    brokenCustody: 10,
    staleVerification: 10,
  },
};
