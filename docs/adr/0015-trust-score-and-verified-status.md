# ADR 0015: Trust Score and verified status

- Status: Accepted
- Date: 2026-09-29

## Context

The Trust Score engine (ADR 0003) and template evaluation (ADR 0006) existed as pure functions,
but nothing fed them recorded facts: passports showed "not yet scored" and no asset could become
`VERIFIED` (ADR 0012). Phase 9 connects them. Scope is kept to what the demo on 12 October 2026
needs; automated checks (ADR 0013, proposed) come later.

## Decision

**When.** The score is recomputed inside the transaction that changes a fact, after the asset row
is locked: publishing, owner status changes, evidence added or reviewed, attestations recorded or
revoked, a verifier's status change (for every asset they attested), a template version
published or retired (for every asset requested against it) and a KYC result (for the owner's
assets). Each run stores a `trust_score_snapshots` row (append-only, ADR 0005) with every factor,
deduction, cap and excluded proof, the engine and weights versions and the inputs hash, and copies
the score and verification level to the asset. Engine `1.1.0` and weights `weights-2026.2` are
unchanged.

**Inputs** (`recordTrust`, `apps/api/src/trust/record.ts`):

- _Attestations_ are proofs of their claim type from source `VERIFIER`, with their expiry, status,
  verifier status and method. Inconclusive and disputed attestations are left out. After
  recovery, only attestations recorded since carry their method, so only they count towards the
  verification route ceilings (ADR 0003).
- _Templates_: the required claims and allowed methods of the template versions evaluated below,
  which decide whether a verifier's attestations form a review (ADR 0003).
- _Evidence_ counts as the type it documents: photos and videos as `PHOTO`, receipts as `RECEIPT`,
  certificates, provenance documents, serial numbers and ownership documents as their claim type,
  and reports, appraisals, service records and manufacturer documents as `DOCUMENTATION`. Evidence
  never proves an inspection or authentication by itself. `OTHER` does not count; rejected
  evidence is excluded.
- _Verifier evidence_ supports the verifier's attestation and counts through it, not again as a
  proof. _Copies_ of a file already on another asset (ADR 0010) do not count.
- _Owner_: every user signed in with a wallet; identity verified from the KYC status.
- _Custody_ from the ownership periods; _open disputes_ from `OPEN` and `UNDER_REVIEW` disputes.
  Evidence a dispute upheld counts as rejected (ADR 0017).

**Verified.** An asset is evaluated against the templates its owner requested verification
against (open, completed or attested requests), each in its current published version. When one
is met (ADR 0006), the system moves `ACTIVE` or `REVERIFICATION_REQUIRED` to `VERIFIED`; when
none is met any more (a revoked or expired attestation, a suspended verifier, a stricter new
version), `VERIFIED` returns to `ACTIVE`. Both are recorded as a status event without an actor
(`template_satisfied`, `template_no_longer_satisfied`) and a `STATUS_CHANGED` provenance event.
After recovery (`REVERIFICATION_REQUIRED`) only attestations recorded since count towards the
template, so a recovered item needs a new verification.

**Visibility.** The passport shows the score, level, versions and disclaimer (ADR 0006). The owner
sees the full breakdown at `GET /assets/:wbId/trust` and the score on their asset; other people
get 404. The breakdown is not public because it names private evidence.

## Consequences

- Time alone does not trigger a recomputation: an attestation that expires, or freshness decay,
  shows at the next change to the asset. A worker job re-scores assets on a schedule later.
- Retiring a template without a successor removes `VERIFIED` from assets that relied on it.
- Recomputing all of a verifier's assets in one transaction is fine at current volumes; a queue
  replaces it when verifiers have many assets.
