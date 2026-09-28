# ADR 0003: Weighted Trust Score

- Status: Accepted
- Date: 2026-09-28

## Context

Counting proofs rewards whoever uploads the most material; a faker can create unlimited
self-submitted proofs for free.

## Decision

The Trust Score (0-100) is computed by `packages/trust-engine`, a pure, versioned function. Each
proof is weighted by:

- **type** (what it proves), **source** (owner, third party, verifier, manufacturer),
- **freshness** (per-type half-life), and **independence** (repeats from the same party decay;
  additional independent verifiers add a bonus).

Rules:

- Each source class has a ceiling (owner-submitted proofs contribute at most 30 points).
- Tier caps: self-documented only ≤ 35 (≤ 45 with KYC); no verifier inspection ≤ 60; no
  authentication plus provenance ≤ 80; high-risk categories need two independent verifiers to
  exceed 90.
- Deductions: open disputes, contradicted claims, revoked attestations, suspended verifiers,
  missing required evidence, broken custody, stale verification.
- Status caps: `DISPUTED` 40, `REPORTED_LOST` 25, `REPORTED_STOLEN` 10, `REVOKED` 0.
- The result lists every factor, deduction, cap and excluded proof, plus engine version, weights
  version, an inputs hash and the evaluation timestamp, so any score can be reproduced.
- Weights are configuration (`DEFAULT_WEIGHTS`); changing them requires a new weights version.
- The score is calculated only by the backend. No endpoint accepts a score.

## Consequences

The score does not guarantee authenticity, ownership, legal title or value, and must always be
displayed with that disclaimer (`TRUST_SCORE_DISCLAIMER`).
