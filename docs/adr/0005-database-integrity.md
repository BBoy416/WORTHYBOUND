# ADR 0005: Database integrity enforced in PostgreSQL

- Status: Accepted
- Date: 2026-09-28

## Context

History, attestations and authority rules are the basis of trust in WorthyBound. If they were
enforced only in application code, a single bug or a compromised service could silently rewrite
history or let a verifier attest outside their permissions.

## Decision

Critical rules are enforced by PostgreSQL itself (migration `*_integrity`), in addition to the
application. Prisma 7.10 with the `pg` driver adapter manages the schema; rules Prisma cannot
express are written in SQL.

**Append-only tables** reject `UPDATE`, `DELETE` and `TRUNCATE` (SQLSTATE `WB001`):
`asset_status_events`, `verifier_status_events`, `verifier_category_permission_events`,
`attestation_status_events`, `attestation_evidence`, `evidence_commitments`,
`evidence_commitment_items`, `trust_score_snapshots`, `provenance_events`, `audit_logs`. Parent
rows referenced by history use `ON DELETE RESTRICT`.

**Provenance hash chain.** On insert the database assigns a per-asset `sequence`, sets `prevHash`
to the previous event's hash and computes
`hash = sha256('wb-provenance-v1' | prevHash | assetId | sequence | type | actorId | occurredAt ms | payload)`.
Client-supplied values are overwritten. Appends are serialized per asset.
`wb_verify_provenance_chain(asset_id)` returns the first broken sequence, or `NULL` if intact, so
tampering by a privileged user who bypasses the triggers is detectable.

**Immutable records** (SQLSTATE `WB002`):

- Attestations: claim, signature and payload fields never change; only status may change;
  `REVOKED` and `SUPERSEDED` are final; attestations cannot be deleted.
- Published template versions: only `PUBLISHED → RETIRED` is allowed; they cannot be deleted.
- Login nonces: single use; binding fields are immutable.
- Verifiers and category permissions (ADR 0011): never deleted, never moved to another user,
  verifier or category; `REVOKED` is final; the first approval and the entity type of an approved
  verifier never change.

**Authority checks** (SQLSTATE `WB003`): an attestation is accepted only if the verifier is
`APPROVED` with a `VERIFIED` identity, holds an `APPROVED` permission for the asset's category,
does not own the asset, and the template version is `PUBLISHED` for that category. Verifiers
cannot approve their own category permissions. A verifier is approved only with a `VERIFIED`
identity, and a category only while the verifier is `APPROVED` or `SUSPENDED` (ADR 0011).

**Check constraints:** `WB-XXXXXXXX` ID format; trust scores 0-100; SHA-256 hex formats; evidence
storage keys cannot be URLs; no self-approval of verifiers, self-granted roles, self-reviewed
evidence or self-resolved disputes; a verified identity requires a KYC provider reference;
tokenized assets require a chain address; submitted chain transactions require a signature.

**Partial unique indexes:** one open custody period per asset, one open transfer per asset, one
active assignment of each role per user, one open permission per verifier and category.

## Consequences

- Services must record status changes as new history rows, never by editing history.
- Integration tests run against a real PostgreSQL database (`TEST_DATABASE_URL`) in CI.
- A database superuser can still disable triggers; the provenance hash chain makes such edits
  detectable. In production the application role will not be a superuser or table owner.
