import { canonicalJson, sha256Hex } from "./hash.js";
import type {
  AppliedCap,
  ExcludedProof,
  Proof,
  ProofSource,
  ProofType,
  TrustDeduction,
  TrustFactor,
  TrustInputs,
  TrustResult,
  TrustWeights,
  VerificationLevel,
} from "./types.js";
import { DEFAULT_WEIGHTS } from "./weights.js";

export const ENGINE_VERSION = "1.0.0";

export const TRUST_SCORE_DISCLAIMER =
  "The WorthyBound Trust Score measures the strength of the evidence and verification recorded " +
  "for an asset. It does not guarantee authenticity, ownership, legal title or value.";

const INDEPENDENT_SOURCES: ReadonlySet<ProofSource> = new Set(["VERIFIER", "MANUFACTURER"]);
const INSPECTION_TYPES: ReadonlySet<ProofType> = new Set(["INSPECTION", "AUTHENTICATION"]);
const CUSTODY_BOUND_TYPES: ReadonlySet<ProofType> = new Set(["POSSESSION", "CONDITION"]);
const DAY_MS = 86_400_000;

export class TrustInputError extends Error {
  override name = "TrustInputError";
}

interface CountedProof {
  proof: Proof;
  issuedMs: number;
}

/**
 * Computes an explainable Trust Score (0-100) from auditable inputs.
 * Pure and deterministic: identical inputs and weights always yield an identical result.
 */
export function computeTrust(
  inputs: TrustInputs,
  weights: TrustWeights = DEFAULT_WEIGHTS,
): TrustResult {
  const evaluatedMs = parseTime(inputs.evaluatedAt, "evaluatedAt");
  const custodySinceMs = parseTime(inputs.currentCustodySince, "currentCustodySince");
  assertCount(inputs.openDisputes, "openDisputes");
  assertCount(inputs.missingRequiredEvidence ?? 0, "missingRequiredEvidence");

  const proofs = [...inputs.proofs].sort((a, b) => compareStrings(a.id, b.id));
  assertUniqueIds(proofs);

  const excludedProofs: ExcludedProof[] = [];
  const counted: CountedProof[] = [];
  const revokedIds: string[] = [];
  const contradictedIds: string[] = [];
  let hadExpiredIndependentProof = false;

  for (const proof of proofs) {
    const issuedMs = parseTime(proof.issuedAt, `proofs[${proof.id}].issuedAt`);
    const exclude = (reason: ExcludedProof["reason"]) =>
      excludedProofs.push({ proofId: proof.id, reason });

    if (issuedMs > evaluatedMs) {
      exclude("ISSUED_AFTER_EVALUATION");
    } else if (proof.status === "REVOKED") {
      exclude("REVOKED");
      revokedIds.push(proof.id);
    } else if (proof.status === "SUPERSEDED") {
      exclude("SUPERSEDED");
    } else if (proof.status === "REJECTED") {
      exclude("REJECTED");
    } else if (proof.sourceStatus === "REVOKED") {
      exclude("SOURCE_REVOKED");
    } else if (
      proof.expiresAt !== undefined &&
      parseTime(proof.expiresAt, `proofs[${proof.id}].expiresAt`) <= evaluatedMs
    ) {
      exclude("EXPIRED");
      if (INDEPENDENT_SOURCES.has(proof.source)) hadExpiredIndependentProof = true;
    } else if (proof.result === "CONTRADICTED") {
      exclude("CONTRADICTED");
      contradictedIds.push(proof.id);
    } else if (CUSTODY_BOUND_TYPES.has(proof.type) && issuedMs < custodySinceMs) {
      exclude("PREDATES_CURRENT_CUSTODY");
    } else {
      counted.push({ proof, issuedMs });
    }
  }

  const factors = [
    ...proofFactors(counted, evaluatedMs, weights),
    ...contextFactors(inputs, counted, weights),
  ];
  const positiveTotal = sum(factors.map((f) => f.points));

  const trusted = counted.filter(
    (c) => INDEPENDENT_SOURCES.has(c.proof.source) && c.proof.sourceStatus !== "SUSPENDED",
  );
  const independentSourceIds = new Set(trusted.map((c) => c.proof.sourceId));
  const hasInspection = trusted.some((c) => INSPECTION_TYPES.has(c.proof.type));
  const hasAuthentication = trusted.some((c) => c.proof.type === "AUTHENTICATION");
  const hasProvenance = counted.some((c) => c.proof.type === "PROVENANCE");

  const applicableCaps: AppliedCap[] = [];
  if (trusted.length === 0) {
    applicableCaps.push(
      inputs.owner.identityVerified
        ? {
            code: "SELF_DOCUMENTED_IDENTITY_VERIFIED",
            limit: weights.caps.selfDocumentedIdentityVerified,
          }
        : { code: "SELF_DOCUMENTED", limit: weights.caps.selfDocumented },
    );
  } else if (!hasInspection) {
    applicableCaps.push({ code: "WITHOUT_INSPECTION", limit: weights.caps.withoutInspection });
  } else if (!(hasAuthentication && hasProvenance)) {
    applicableCaps.push({
      code: "WITHOUT_AUTHENTICATION_AND_PROVENANCE",
      limit: weights.caps.withoutAuthenticationAndProvenance,
    });
  }
  if (weights.highRiskCategories.includes(inputs.category) && independentSourceIds.size < 2) {
    applicableCaps.push({
      code: "HIGH_RISK_WITHOUT_MULTIPLE_VERIFIERS",
      limit: weights.caps.highRiskWithoutMultipleVerifiers,
    });
  }
  const capsApplied = applicableCaps.filter((c) => c.limit < positiveTotal);
  const cappedPositive = Math.min(positiveTotal, ...applicableCaps.map((c) => c.limit));

  const deductions = computeDeductions(inputs, counted, trusted.length, weights, {
    revokedIds,
    contradictedIds,
    hadExpiredIndependentProof,
  });
  let score = clamp(cappedPositive - sum(deductions.map((d) => d.points)), 0, 100);

  const statusCap = weights.statusCaps[inputs.status];
  if (statusCap !== undefined && score > statusCap) {
    capsApplied.push({ code: `STATUS_${inputs.status}`, limit: statusCap });
    score = statusCap;
  }

  return {
    score: Math.round(score),
    verificationLevel: verificationLevel(counted.length, hasInspection, hasAuthentication, [
      ...independentSourceIds,
    ]),
    factors: factors.map(roundPoints),
    deductions: deductions.map(roundPoints),
    capsApplied,
    excludedProofs,
    engineVersion: ENGINE_VERSION,
    weightsVersion: weights.version,
    inputsHash: sha256Hex(
      canonicalJson({ engineVersion: ENGINE_VERSION, weights, inputs: { ...inputs, proofs } }),
    ),
    computedAt: new Date(evaluatedMs).toISOString(),
  };
}

function proofFactors(
  counted: readonly CountedProof[],
  evaluatedMs: number,
  weights: TrustWeights,
): TrustFactor[] {
  const groups = new Map<string, { counted: CountedProof; base: number }[]>();
  for (const c of counted) {
    const { proof } = c;
    const freshness = freshnessFactor(proof.type, c.issuedMs, evaluatedMs, weights);
    const suspension = proof.sourceStatus === "SUSPENDED" ? weights.suspendedSourceMultiplier : 1;
    const base =
      weights.typePoints[proof.type] *
      weights.sourceMultiplier[proof.source] *
      freshness *
      suspension;
    const key = `${proof.type}|${proof.source}|${proof.sourceId}`;
    const group = groups.get(key) ?? [];
    group.push({ counted: c, base });
    groups.set(key, group);
  }

  const raw: { factor: TrustFactor; source: ProofSource }[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.base - a.base || compareStrings(a.counted.proof.id, b.counted.proof.id));
    group.forEach(({ counted: { proof, issuedMs }, base }, index) => {
      const repeatFactor = weights.repeatDecay ** index;
      raw.push({
        source: proof.source,
        factor: {
          code: `PROOF_${proof.type}`,
          proofId: proof.id,
          points: base * repeatFactor,
          detail: {
            source: proof.source,
            typePoints: weights.typePoints[proof.type],
            sourceMultiplier: weights.sourceMultiplier[proof.source],
            freshness: round(freshnessFactor(proof.type, issuedMs, evaluatedMs, weights)),
            repeatFactor: round(repeatFactor),
            ...(proof.sourceStatus === "SUSPENDED"
              ? { suspendedMultiplier: weights.suspendedSourceMultiplier }
              : {}),
          },
        },
      });
    });
  }

  const totals = new Map<ProofSource, number>();
  for (const { source, factor } of raw) {
    totals.set(source, (totals.get(source) ?? 0) + factor.points);
  }
  const result = raw.map(({ source, factor }) => {
    const total = totals.get(source) ?? 0;
    const ceiling = weights.sourceCeiling[source];
    if (total <= ceiling) return factor;
    const ceilingFactor = ceiling / total;
    return {
      ...factor,
      points: factor.points * ceilingFactor,
      detail: { ...factor.detail, ceilingFactor: round(ceilingFactor) },
    };
  });
  return result.sort((a, b) => compareStrings(a.proofId ?? "", b.proofId ?? ""));
}

function contextFactors(
  inputs: TrustInputs,
  counted: readonly CountedProof[],
  weights: TrustWeights,
): TrustFactor[] {
  const factors: TrustFactor[] = [];
  if (inputs.owner.walletVerified) {
    factors.push({ code: "OWNER_WALLET_VERIFIED", points: weights.identity.walletVerified });
  }
  if (inputs.owner.identityVerified) {
    factors.push({ code: "OWNER_IDENTITY_VERIFIED", points: weights.identity.identityVerified });
  }
  if (inputs.custodyContinuous) {
    factors.push({ code: "CUSTODY_CONTINUITY", points: weights.custodyContinuity });
  }
  const independent = new Set(
    counted
      .filter(
        (c) => INDEPENDENT_SOURCES.has(c.proof.source) && c.proof.sourceStatus !== "SUSPENDED",
      )
      .map((c) => c.proof.sourceId),
  );
  if (independent.size >= 2) {
    factors.push({
      code: "MULTIPLE_INDEPENDENT_VERIFIERS",
      points: Math.min(
        weights.independence.maxPoints,
        (independent.size - 1) * weights.independence.pointsPerAdditionalSource,
      ),
      detail: { independentSources: independent.size },
    });
  }
  return factors;
}

function computeDeductions(
  inputs: TrustInputs,
  counted: readonly CountedProof[],
  trustedCount: number,
  weights: TrustWeights,
  state: { revokedIds: string[]; contradictedIds: string[]; hadExpiredIndependentProof: boolean },
): TrustDeduction[] {
  const d = weights.deductions;
  const deductions: TrustDeduction[] = [];
  const perItem = (
    code: string,
    rule: { points: number; max: number },
    count: number,
    proofIds?: string[],
  ) => {
    if (count > 0) {
      deductions.push({
        code,
        points: Math.min(rule.max, rule.points * count),
        count,
        ...(proofIds ? { proofIds } : {}),
      });
    }
  };

  perItem("OPEN_DISPUTES", d.openDispute, inputs.openDisputes);
  perItem("CONTRADICTED_CLAIMS", d.contradictedClaim, state.contradictedIds.length, [
    ...state.contradictedIds,
  ]);
  perItem("REVOKED_PROOFS", d.revokedProof, state.revokedIds.length, [...state.revokedIds]);
  const suspendedIds = counted
    .filter((c) => c.proof.sourceStatus === "SUSPENDED")
    .map((c) => c.proof.id);
  perItem("SUSPENDED_SOURCE", d.suspendedSource, suspendedIds.length, suspendedIds);
  perItem(
    "MISSING_REQUIRED_EVIDENCE",
    d.missingRequiredEvidence,
    inputs.missingRequiredEvidence ?? 0,
  );
  if (!inputs.custodyContinuous) {
    deductions.push({ code: "BROKEN_CUSTODY", points: d.brokenCustody });
  }
  if (state.hadExpiredIndependentProof && trustedCount === 0) {
    deductions.push({ code: "STALE_VERIFICATION", points: d.staleVerification });
  }
  return deductions;
}

function verificationLevel(
  countedProofs: number,
  hasInspection: boolean,
  hasAuthentication: boolean,
  independentSourceIds: readonly string[],
): VerificationLevel {
  if (hasInspection && independentSourceIds.length >= 2) return "MULTI_VERIFIED";
  if (hasAuthentication) return "AUTHENTICATED";
  if (hasInspection) return "INSPECTED";
  if (countedProofs > 0) return "SELF_DOCUMENTED";
  return "UNVERIFIED";
}

function freshnessFactor(
  type: ProofType,
  issuedMs: number,
  evaluatedMs: number,
  weights: TrustWeights,
): number {
  const rule = weights.freshness[type];
  if (rule.halfLifeDays === null) return 1;
  const ageDays = Math.max(0, (evaluatedMs - issuedMs) / DAY_MS);
  return Math.max(rule.minFactor, 0.5 ** (ageDays / rule.halfLifeDays));
}

function parseTime(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TrustInputError(`${field} is not a valid ISO-8601 timestamp`);
  return ms;
}

function assertCount(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TrustInputError(`${field} must be a non-negative integer`);
  }
}

function assertUniqueIds(proofs: readonly Proof[]): void {
  const seen = new Set<string>();
  for (const { id } of proofs) {
    if (seen.has(id)) throw new TrustInputError(`duplicate proof id: ${id}`);
    seen.add(id);
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPoints<T extends { points: number }>(item: T): T {
  return { ...item, points: round(item.points) };
}
