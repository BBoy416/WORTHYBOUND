# ADR 0011: Verifier system

- Status: Accepted
- Date: 2026-09-28

## Context

Verification by approved professionals is what raises trust in a passport. Before verifiers can
sign attestations (Phase 8), WorthyBound needs to decide who may become a verifier, who reviews
them, which categories each may verify, and how a verifier is suspended or removed, without anyone
approving themselves and without trusting a wallet as proof of identity.

## Decision

**Endpoints:**

| Endpoint                                             | Who               | Does                                            |
| ---------------------------------------------------- | ----------------- | ----------------------------------------------- |
| `POST /verifier/application`                         | signed in         | Applies, or applies again after a rejection     |
| `GET /verifier/me`                                   | applicant         | Own status, categories and history with reasons |
| `POST /verifier/me/categories`                       | approved verifier | Requests further categories                     |
| `GET /review/verifiers`                              | reviewer, admin   | Review queue, oldest first, filter by status    |
| `GET /review/verifiers/:verifierId`                  | reviewer, admin   | Details, KYC status and full history            |
| `POST /review/verifiers/:verifierId/status`          | reviewer, admin   | Status change following the verifier lifecycle  |
| `POST /review/verifiers/:verifierId/categories/:cat` | reviewer, admin   | Approves, suspends or revokes one category      |
| `GET /admin/roles` · `POST /admin/roles`             | admin             | Lists and grants `VERIFIER_REVIEWER`            |
| `DELETE /admin/roles/:assignmentId`                  | admin             | Revokes `VERIFIER_REVIEWER`                     |
| `GET /verifiers/:verifierId`                         | public            | Verifier profile; no sign-in                    |

"Reviewer" is the `VERIFIER_REVIEWER` role. ADMIN is still granted only with `pnpm admin:grant`
(ADR 0008); the API manages `VERIFIER_REVIEWER` only.

**Application and review.** An application records the entity type, public details and the
requested categories, each as a `PENDING` permission. Reviewers follow `VERIFIER_LIFECYCLE`:
`APPLIED → UNDER_REVIEW → APPROVED` or `REJECTED`; approved verifiers can be `SUSPENDED` and
reinstated; only an admin revokes, and `REVOKED` is final. Rejection, suspension and revocation
need a reason, which the applicant sees; reviewer identities are shown only to reviewers. Each
change is written as a status event and to the audit log. No one reviews their own record
(`403 self_review`, also enforced by the database).

**Identity (ADR 0004).** Anyone may apply, but a verifier is approved only with a `VERIFIED`
identity. Until a KYC provider is integrated, the server operator records a provider's result with
`pnpm kyc:record <wallet> <provider> <reference> [VERIFIED|REJECTED|EXPIRED]`; there is no API for
it. Only the status, provider and reference are stored; the audit entry omits the reference.
Attestations are also refused when the verifier's identity is no longer `VERIFIED` (e.g. expired),
in `attestationAuthorityViolations` and in the database.

**Categories.** Permission is granted one category at a time, following
`CATEGORY_PERMISSION_LIFECYCLE`, and only once the verifier is approved (or while suspended).
Rejecting an application revokes its pending categories; revoking a verifier revokes all of them.
Revoked permissions stay as history: at most one permission per verifier and category is open
(not `REVOKED`), so a refused category can be requested again as a new row. Every permission
change is written to the append-only `verifier_category_permission_events`.

**Roles follow approval.** The first approval grants the `VERIFIER` role and revocation revokes
it, in the same transaction. Authority always comes from the verifier's status and permissions,
never from the role alone; suspension keeps the role but blocks attestations.

**Re-application.** A rejected applicant may apply again 30 days after the rejection
(`409 reapply_too_soon` before then). The same verifier record is reused with new details and new
`PENDING` categories; revoked verifiers cannot apply again.

**Database rules** (ADR 0005): verifiers and permissions are never deleted and never moved to
another user, verifier or category; `REVOKED` is final; the first approval (approver and date) and
the entity type of an approved verifier never change; approval requires a verified identity;
categories are approved only for approved or suspended verifiers.

**Public profile.** Only verifiers that were approved at some point have one; applicants,
rejected applicants and unknown IDs get the same 404. `toPublicVerifier` copies an allow-list:
entity type, status, first approval date, approved categories and, for organisations only, the
name and website. Individuals are never named, and bios, wallets and KYC data are never shown.
Suspended and revoked verifiers stay visible so their past attestations can be judged. Passports
use the same naming rule (`verifierPublicName`).

**Abuse.** Applications are limited to 5 per user per hour, other changes to 60 per user per
minute and public profiles to 120 per IP per minute.

## Consequences

- No verifier can be approved until the operator records a KYC result; a provider integration
  replaces `kyc:record` later.
- Suspending or revoking a verifier re-evaluates every asset they attested: the Trust Score is
  recomputed and `VERIFIED` returns to `ACTIVE` where no template is met any more (ADR 0015).
- Verifiers adding and reviewing evidence needs a verifier assigned to the asset, so it comes with
  verification requests in Phase 8. The verifier counters and on-chain verifier registration
  (`chainVerifierAddress`) are not used yet. Phase 8 adds requests, evidence review and signed
  attestations; suspension or an expired identity releases the verifier's assigned requests
  (ADR 0012).
- An approved verifier cannot change their entity type, and a revoked verifier cannot apply again;
  correcting either needs admin tooling (later phase).
