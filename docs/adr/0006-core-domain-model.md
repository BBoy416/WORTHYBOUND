# ADR 0006: Core domain model

- Status: Accepted
- Date: 2026-09-28

## Context

The API (from Phase 4) needs one place for business rules: which status changes are allowed and
by whom, when an asset counts as verified, what the public passport may show and which inputs are
accepted. Without it, rules drift between endpoints, and enum values drift between the database,
the Trust Score engine and application code.

## Decision

**Packages.** `packages/shared` holds pure domain code with no I/O: enumerations, asset IDs,
lifecycle rules, attestation authority checks, template evaluation and the public passport.
`packages/validation` holds Zod schemas for user input. The Trust Score engine imports its enums
from `shared`.

**Enumerations.** The Prisma schema remains the source of truth for the database. `shared` mirrors
every Prisma enum and a database test fails if they diverge.

**Claim types.** The four claim types from the product specification that were missing were added
(additive migration): `PHYSICAL_EXISTENCE`, `IDENTITY_OF_PRESENTER`, `DOCUMENTATION`,
`OWNERSHIP_CLAIM`. The specification's `AUTHENTICITY` is `AUTHENTICATION`; `INSPECTION` and
`CERTIFICATE` are kept. Every claim type is a Trust Score proof type, so a new claim type cannot be
added without a weight. Weights `weights-2026.2`: existence 4, presenter identity 2,
documentation 6, ownership claim 2; presenter identity and ownership claims only count within the
current custody period (engine 1.1.0). None of them counts as an inspection.

**Lifecycles.** Each record type has an explicit table of allowed status changes and the actors
(owner, recipient, verifier, reviewer, admin, system) who may make them. `SYSTEM` means the backend
acting on recorded facts (expiry, chain confirmation, template evaluation), never a user request.
Key rules:

- Assets: `DRAFT` is private; `TOKENIZED` means registered on-chain but not yet published; `ACTIVE`
  is a published passport. Tokenization of a published asset is tracked by `tokenizationStatus`.
- Only the system sets `VERIFIED`, after template evaluation; no person can mark an asset verified.
- Transfers start only from `ACTIVE`, `VERIFIED` or `REVERIFICATION_REQUIRED` (ADR 0002).
- Owners can report a published asset lost or stolen at any time; only an admin can clear a stolen
  report; recovered assets always go to `REVERIFICATION_REQUIRED`.
- `REVOKED` assets, revoked or superseded attestations, and revoked verifiers are final.
- An issuer may revoke their own attestation, but not while it is disputed.

Identity rules (no self-approval, no self-review, no attesting to one's own asset) stay enforced
by the database (ADR 0005) and are repeated in `attestationAuthorityViolations` so the API can
explain a rejection before writing.

**Verified.** An asset meets a template when each required claim is confirmed by at least
`minVerifiers` distinct approved verifiers with active, unexpired attestations using an allowed
method, no current attestation contradicts a required claim, and the required evidence is present
(rejected evidence does not count). The missing evidence count feeds the Trust Score.

**Public passport.** `toPublicPassport` copies an explicit allow-list of fields, so new private
columns cannot leak. It never includes private evidence, storage keys, serial numbers, owner
identity or wallet, attestation notes or provenance payloads. Revoked and disputed attestations
stay visible. Draft and unpublished assets have no passport. The Trust Score is always shown with
its disclaimer.

**Validation.** All input schemas are strict: unknown fields are rejected, so clients cannot send
IDs, status, owner, Trust Score, storage keys or the attesting verifier.

## Consequences

- Services must call the lifecycle rules for every status change and record it as a status
  event; the database does not enforce asset status transitions.
- Asset IDs have 32 bits of randomness; services retry on a unique-constraint conflict.
- Changing a lifecycle, the passport allow-list or a schema is a reviewed domain change with tests.
