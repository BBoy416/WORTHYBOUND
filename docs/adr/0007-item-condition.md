# ADR 0007: Item condition

- Status: Accepted
- Date: 2026-09-28

## Context

Buyers need to know an item's physical condition. The model already had `CONDITION` claims,
`CONDITION_REPORT` evidence and `CONDITION_UPDATED` provenance events, but no condition value:
a condition attestation only said that a check happened and whether it was confirmed.

## Decision

**Scale.** One scale for all categories, best first (`ItemCondition`): `NEW`, `EXCELLENT`,
`VERY_GOOD`, `GOOD`, `FAIR`, `POOR`, `FOR_PARTS`. Category-specific details belong in attestation
notes or a condition report.

**Two values, never merged.**

- _Owner-stated_ (`assets.condition`): optional, set by the owner at registration and changeable
  later. Every change is recorded as a `CONDITION_UPDATED` provenance event.
- _Verified_ (`attestations.conditionGrade`): part of a signed `CONDITION` attestation, immutable
  like the other claim fields. The database allows a grade only on `CONDITION` claims and requires
  one when the claim is `CONFIRMED`. The grade must be included in the signed attestation payload
  (Phase 8).

**Public passport.** Shows the owner-stated condition, labelled as not verified, and the verified
grade from the latest active, confirmed `CONDITION` attestation, with its date and verifier. A
grade assessed before the current owner's custody is flagged `fromPreviousCustody`. Every
attestation's grade stays visible in the attestation history.

**Trust Score.** The grade does not affect the Trust Score. The score measures how well an item's
facts are proven, not its quality or value; a genuine item in `FAIR` condition inspected by a
laboratory should still score highly. A `CONDITION` claim still contributes its proof weight
regardless of the grade, and still stops counting after a transfer (ADR 0002).

## Consequences

- The trust engine has no condition input, so the grade cannot change a score by accident.
- A change of condition after verification requires a new `CONDITION` attestation; the old grade
  is superseded, never edited.
- Phase 8: the grade is a line of the signed attestation message (`wb-attestation-v1`, ADR 0012).
