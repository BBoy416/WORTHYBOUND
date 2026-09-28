# ADR 0009: Asset registration and passports

- Status: Accepted
- Date: 2026-09-28

## Context

Owners register physical items and publish a public passport for each. Registration must not let
anyone register an item that is already registered, move one item's record onto another, or
learn private details of other people's items.

## Decision

**Endpoints** (signed in, owner only unless noted):

| Endpoint                       | Does                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `POST /assets`                 | Registers a private `DRAFT`; accepts an `Idempotency-Key` |
| `GET /assets`                  | The caller's assets, newest first, cursor pagination      |
| `GET /assets/:wbId`            | Private view, including the serial                        |
| `PATCH /assets/:wbId`          | Edits details (limits below)                              |
| `POST /assets/:wbId/publish`   | `DRAFT`/`TOKENIZED` → `ACTIVE`; requires brand and model  |
| `POST /assets/:wbId/status`    | Owner status changes the lifecycle allows (below)         |
| `POST /assets/:wbId/condition` | Owner-stated condition, recorded as `CONDITION_UPDATED`   |
| `GET /passport/:wbId`          | Public passport and its link (for QR codes); no sign-in   |

Registration runs in one transaction: random WB ID (retried on collision), asset, first custody
period, status event, `REGISTERED` provenance event (hash-chained, ADR 0005), idempotency key and
audit entry.

**The same item cannot be registered twice.** Serials are fingerprinted with
HMAC-SHA256(`SERIAL_FINGERPRINT_KEY`, `wb-serial-v1|category|brand|serial`), with brand and serial
reduced to letters and digits (so `ab-12 34` matches `AB1234`). A partial unique index allows one
asset per fingerprint among assets that are not `REVOKED`, so concurrent registrations cannot both
succeed; lost and stolen items keep their serial. The same applies when a draft's serial is edited.

A rejected registration gets a generic answer that does not mention serials or other owners:
`422 registration_rejected` "This item can't be registered. If you believe this is a mistake,
contact support." The attempt is audited (`asset.registration_blocked`, with the conflicting WB
ID) for admin review. Items without a serial are not checked.

**Identity lock.** Once published, category, brand, model and serial cannot change, and
`publishedAt` is set once. A database trigger enforces this, and also that the WB ID never
changes, assets are never deleted and `REVOKED` is final. The public description, private notes,
attributes and condition stay editable; public description and condition changes are recorded in
the provenance history.

**Owner status changes:** report lost, report stolen, lost → recovered (`REVERIFICATION_REQUIRED`,
recorded as `RECOVERED`) and discarding a draft (`REVOKED`). Clearing a stolen report, disputes and
revocation of published assets are admin actions (later phase); transfers have their own flow
(ADR 0002); `VERIFIED` is set only by the system.

**Discarded drafts** are `REVOKED` with no `publishedAt`. They are hidden from everyone, release
their serial and never get a passport.

**Passport.** Only columns the passport may show are read from the database, and
`toPublicPassport` applies its allow-list (ADR 0006). Unknown IDs, drafts and discarded drafts get
the same 404. Published assets stay visible after being reported stolen, disputed or revoked.
Individual verifiers are not named; organisations are. There is no Trust Score until Phase 9
connects the engine to evidence and attestations (`trust: null`, shown as "not yet scored").

**Abuse.** Registrations are limited to 20 per user per hour, because each attempt can reveal
whether an item is registered; other changes 60 per user per minute; passports 120 per IP per
minute. Owner-only endpoints answer 404 for other people's assets, as for unknown IDs.

## Consequences

- A rejected registration still tells the person that the item cannot be registered. The generic
  wording, sign-in requirement, rate limit and audit trail limit its use for probing.
- Someone could register an item they do not own first. The rightful owner is rejected and must
  contact support; admin tools for resolving this come in a later phase.
- Changing brand spelling (`Rolex SA` vs `Rolex`) produces a different fingerprint. Admins can see
  blocked attempts; verification (Phases 7-8) is the stronger check.
- Rotating `SERIAL_FINGERPRINT_KEY` requires recomputing all fingerprints from the stored serials.
- Serials are stored in plain text in the private database; encryption with a key service is
  planned before production.
- Idempotency keys are kept until a cleanup job exists (worker, later phase).
