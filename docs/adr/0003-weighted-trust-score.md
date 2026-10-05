# ADR 0003: Weighted Trust Score

- Status: Accepted; amended by ADR 0013 and the verification route ceilings (2026-10-05)
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
- Ceilings by verification route (weights `weights-2026.5`, engine `1.4.0`). They are maximums,
  not scores: evidence quality, confirmed claims, failed checks and deductions set the actual
  score.

  | Evidence and verification                                   | Maximum |
  | ----------------------------------------------------------- | ------- |
  | Owner evidence only (with KYC)                              | 35 (45) |
  | Verifier proofs, but no review of the required claims       | 60      |
  | Owner evidence plus passed automated checks, none failed    | 65      |
  | One approved verifier reviews online                        | 75      |
  | Two independent approved verifiers review online            | 80      |
  | One in-person inspection                                    | 85      |
  | One online review plus one independent in-person inspection | 90      |
  | Two independent approved verifiers inspect in person        | 100     |

  A review counts when one approved, not suspended verifier's signed, confirmed attestations
  cover every required claim of a template the asset is evaluated against (ADR 0015), each with a
  method the template allows. It is in person when every claim was examined `IN_PERSON` or in a
  `LABORATORY`; `REMOTE` and `DOCUMENT_REVIEW` count as online. Two reviews need two different
  verifiers. The 65 also replaces the 60 when no review counts. `MULTI_VERIFIED` requires two
  independent in-person inspections; online reviews alone cannot unlock it. A score of 100 is
  the strongest proof under these rules, not a guarantee of authenticity.

- Deductions: open disputes, contradicted claims, revoked attestations, suspended verifiers,
  missing required evidence, failed automated checks (ADR 0013), broken custody, stale
  verification.
- Status caps: `DISPUTED` 40, `REPORTED_LOST` 25, `REPORTED_STOLEN` 10, `REVOKED` 0.
- The result lists every factor, deduction, cap and excluded proof, plus engine version, weights
  version, an inputs hash and the evaluation timestamp, so any score can be reproduced.
- Weights are configuration (`DEFAULT_WEIGHTS`); changing them requires a new weights version.
- The score is calculated only by the backend. No endpoint accepts a score.

## Consequences

The score does not guarantee authenticity, ownership, legal title or value, and must always be
displayed with that disclaimer (`TRUST_SCORE_DISCLAIMER`).
