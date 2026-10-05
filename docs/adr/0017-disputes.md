# ADR 0017: Disputes

- Status: Accepted
- Date: 2026-10-05

## Context

The domain model has disputes (ADR 0006), the Trust Score deducts open ones and caps `DISPUTED`
assets at 40 (ADR 0003), and attestations have a `DISPUTED` status. But nothing let anyone open
or decide a dispute: only disputes about escrowed sales existed (ADR 0014), and those are about a
payment, not about whether a passport is right. A buyer who finds that a serial does not match an
attestation, or that a public photo comes from a sales listing, had no way to say so.

## Decision

**Who.** Any signed-in user with a verified identity (ADR 0004) can open a dispute about a
published asset that is not revoked (`POST /disputes`). A dispute targets the asset, one
attestation on it (active, expired or already disputed) or one evidence item on it (public, or
any of the caller's own). One open dispute per person and target. The opener sees their disputes
(`GET /disputes`) and can withdraw one until an administrator starts the review.

**Review.** Administrators list disputes (`GET /admin/disputes`, by default `OPEN` and
`UNDER_REVIEW`), start a review and decide (`UPHELD` or `REJECTED`, with a resolution the opener
sees). Nobody reviews or decides a dispute they opened. Lifecycle: `OPEN → UNDER_REVIEW →
UPHELD | REJECTED`, and `OPEN → WITHDRAWN` (`DISPUTE_LIFECYCLE`).

| Step                    | Effect                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| Opened                  | Counts as an open dispute in the Trust Score; `DISPUTE_OPENED` provenance |
| Opened, attestation     | The verifier's dispute count increases                                    |
| Review, attestation     | An active or expired attestation becomes `DISPUTED` and stops counting    |
| Review with `holdAsset` | The asset becomes `DISPUTED` (cap 40); its open transfer is cancelled     |
| Upheld, attestation     | The attestation is revoked; the verifier's upheld count increases         |
| Upheld, evidence        | The evidence stops counting and leaves the passport and comparisons       |
| Rejected, attestation   | The attestation counts again (or expires), once no other review holds it  |
| Decided, asset held     | `ACTIVE`, `REVERIFICATION_REQUIRED` or `REVOKED`, as the admin chooses    |

Holding is optional, so a dispute that is clearly unfounded does not block a sale. At most one
dispute holds an asset; the asset's status before the hold is recorded. Without a choice, a held
asset returns to `ACTIVE`, or `REVERIFICATION_REQUIRED` if it was; template evaluation then
restores `VERIFIED` where a template is still met (ADR 0015).

**Privacy.** The passport shows how many disputes are open and the `DISPUTE_OPENED` and
`DISPUTE_RESOLVED` provenance events, never the opener, reason or details. Administrators see the
opener's wallet address.

**Integrity** (migration `20261009090000_disputes`). The database checks that a dispute's
attestation or evidence belongs to its asset, that review and decision record who and when, that
the opener never reviews or decides, that a held dispute records the asset's status before, that
one dispute holds an asset at a time, and that decided disputes do not change and are never
deleted.

**Web.** The passport has a "Report a problem" card; the admin page has a Disputes tab. Escrow
disputes move to `/admin/escrow`.

## Consequences

- Upheld evidence disputes do not delete the file; it stays in the vault for the record.
- Reasons are free text; categories (fake, stolen, wrong condition) come when there is enough
  volume to need them.
- A verifier's upheld dispute count is recorded but does not yet affect the verifier's weight or
  status; administrators act on it through the verifier review (ADR 0011).
- There is no notification to the owner or verifier yet; they see the effect on the asset.
