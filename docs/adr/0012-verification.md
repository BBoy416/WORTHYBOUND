# ADR 0012: Verification requests and signed attestations

- Status: Accepted
- Date: 2026-09-29

## Context

Approved verifiers (ADR 0011) need a way to be asked to check an asset, to see what they need,
to add and review evidence (ADR 0010) and to record their findings so that nobody, including
WorthyBound, can later claim a verifier said something they did not. Templates must say what
"verified" means for a category, and must not be changed by a single administrator.

## Decision

**Endpoints:**

| Endpoint                                                   | Who               | Does                                       |
| ---------------------------------------------------------- | ----------------- | ------------------------------------------ |
| `GET /templates`                                           | public            | Published template versions, by category   |
| `GET /admin/templates` · `POST /admin/templates`           | admin             | Lists and creates templates                |
| `POST /admin/templates/:templateId/versions`               | admin             | Adds a draft version with its requirements |
| `POST /admin/template-versions/:versionId/status`          | admin             | Publishes or retires a version             |
| `POST /assets/:wbId/verification-requests`                 | owner             | Requests verification against a version    |
| `GET /assets/:wbId/verification-requests`                  | owner             | Requests, their verifier and attestations  |
| `POST /verification-requests/:requestId/cancel`            | owner             | Cancels an open or assigned request        |
| `GET /verifier/requests`                                   | approved verifier | Open queue, or own requests (`scope=mine`) |
| `GET /verifier/requests/:requestId`                        | approved verifier | Request details                            |
| `POST /verifier/requests/:requestId/claim`                 | approved verifier | Takes an open request                      |
| `POST /verifier/requests/:requestId/release`               | assigned verifier | Returns it to the queue                    |
| `POST /verifier/requests/:requestId/complete`              | assigned verifier | Completes it (needs an attestation)        |
| `POST /verifier/requests/:requestId/evidence/uploads`      | assigned verifier | Upload form, completed as in ADR 0010      |
| `GET /verifier/requests/:requestId/evidence`               | assigned verifier | The asset's evidence                       |
| `POST /verifier/requests/:requestId/evidence/:id/download` | assigned verifier | 5-minute download link                     |
| `POST /verifier/requests/:requestId/evidence/:id/review`   | assigned verifier | Accepts or rejects evidence, once          |
| `POST /verifier/requests/:requestId/attestations/message`  | assigned verifier | The exact text to sign                     |
| `POST /verifier/requests/:requestId/attestations`          | assigned verifier | Submits the claim with its signature       |
| `POST /attestations/:attestationId/revoke`                 | issuer            | Revokes own attestation with a reason      |

**Templates.** A template has a fixed code and category; its versions list required claims, required
evidence (type and minimum count) and allowed methods, `minVerifiers` and `validityMonths` (1-120,
default 60). Versions follow `DRAFT → PUBLISHED → RETIRED`. A version is published by a different
administrator than the one who created it (`403 four_eyes`, also enforced by the database, which
records `createdById` and `publishedById`), unless its creator is the only active administrator;
such a publication is audited with `selfPublished: true`, and the rule applies again as soon as a
second administrator is granted. Publishing retires the template's previous published version; open
requests against a retired version are cancelled (`template_retired`). Published versions never
change (ADR 0005).

**Requests.** The owner of a published, attestable asset opens a request against a published
version for the asset's category; at most one open request per asset and version. Requests follow
`VERIFICATION_REQUEST_LIFECYCLE`: `OPEN → ASSIGNED → COMPLETED`, back to `OPEN` when released,
`CANCELLED` or `EXPIRED`; the last three are final. Each change is a status event with a reason
and an audit entry. Requests expire 90 days after being opened.

**Who takes a request.** An open queue: any approved verifier with a verified identity and an
approved permission for the category may claim an open request, except on their own assets
(`requestAssignmentViolations`, repeated by the database on assignment). One claim wins; the
others get `409 request_not_open`. Owners do not pick verifiers yet; nomination, and the
independence rules it needs (ADR 0003), come later.

**The system closes requests** (`SYSTEM` actor, ADR 0006):

- suspending or revoking a verifier, or their identity leaving `VERIFIED` (`kyc:record`), releases
  their assigned requests back to the queue (`verifier_suspended`, `verifier_revoked`,
  `verifier_identity_not_verified`); suspending or revoking a category does the same for that
  category (`category_permission_withdrawn`);
- reporting an asset lost or stolen, or revoking it, cancels its open requests
  (`asset_unavailable`);
- overdue requests are marked `EXPIRED` when they are read or acted on.

**Privacy.** The queue shows the asset's public details and category, never the owner, their
wallet, the serial, private notes or attributes. The assigned verifier also sees the serial, which
they need to check the item. Owners see the verifier's public name (`verifierPublicName`: only
organisations are named) and never their wallet. Anyone else gets 404, as for unknown IDs.

**Verifier evidence.** The assigned verifier can add evidence of the types in
`VERIFIER_EVIDENCE_TYPES` (photos, videos, inspection, condition and appraisal reports,
certificates, serial number photos, other); receipts, ownership and manufacturer documents come
from the owner. It uses the Evidence Vault pipeline unchanged (checks, immutability, seal) with
`source = VERIFIER` and the request recorded; it is private and counts towards the asset's limit.
An upload is only completed while the request is still assigned to that verifier
(`request_unavailable`). The owner sees verifier evidence in their evidence list.

**Evidence review.** The assigned verifier accepts or rejects the asset's evidence; a rejection
needs a reason, which the owner sees without the reviewer's identity. The decision is final
(ADR 0010), recorded as `EVIDENCE_REVIEWED` in the provenance log, and a verifier never reviews
their own upload (`403 self_review`, also enforced by the database). The database also allows
administrators to review, for admin tooling later. Rejected evidence does not count towards a
template (ADR 0006) and cannot support an attestation (`evidence_rejected`).

**Signed attestations.**

1. The verifier sends the claim (type, result, condition grade, method, assurance, issue and
   optional expiry dates, notes, supporting evidence with each file's SHA-256, the attestation it
   supersedes, and a random nonce) to `…/attestations/message`. The server checks the authority
   rules (`attestationAuthorityViolations`) and returns the message, built by
   `attestationMessage` (`wb-attestation-v1`): one field per line, with the domain
   (`AUTH_DOMAIN`), chain ID, verifier wallet, WB ID, category, template version, request, claim,
   result, condition grade (ADR 0007), method, assurance, dates, superseded attestation, the
   SHA-256 of the notes (the notes stay private) and each evidence ID with its hash.
2. The wallet signs the text (`signMessage`); nothing is sent to the chain.
3. The verifier submits the same fields with the base58 signature. The server rebuilds the message
   from its own records and accepts it only with a valid Ed25519 signature by the verifier's
   wallet over exactly that text (`422 invalid_signature`). The issue date must be within
   10 minutes of the server's clock; each nonce is used once per verifier (`409 nonce_reused`).

**Validity.** Every attestation has an expiry, which is part of the signed message. It defaults to
the template's `validityMonths` after the issue date (five years unless the template says
otherwise); the verifier may choose an earlier one, never a later one (`422 expiry_too_late`).
Months are counted in UTC and end on the last day of a shorter month (`attestationExpiryLimit`); the
database checks the same limit. Validity does not end with a transfer: a sale does not require a new
appraisal (ADR 0002 keeps authentication counting).

The attestation stores the signed message, its SHA-256 (`signedPayloadHash`, checked by the
database), the signature and the nonce, and is immutable (ADR 0005). It writes an
`ATTESTATION_ADDED` provenance event, a status event and an audit entry. The database accepts an
attestation only for a request assigned to that verifier, for the same asset and template version,
for a claim the template requires and a method it allows, in addition to the existing authority
checks. Each verifier has at most one current attestation per asset and claim: a new one must name
the previous one, which becomes `SUPERSEDED` (`409 attestation_exists` otherwise).

**Revocation.** The issuer revokes their own attestation with a reason, except while it is
disputed; it stays visible on the passport as revoked and writes `ATTESTATION_REVOKED`.

**Passport.** Shows attestations with their status, dates, claim, result, grade and verifier
public name; never notes, signed messages, signatures, nonces or wallets.

**Abuse.** Changes are limited to 60 per user per minute, upload requests to 30 per user per hour
(shared with owner uploads) and the public template list to 120 per IP per minute.

## Consequences

- An asset does not become `VERIFIED` and has no Trust Score yet: Phase 9 evaluates templates on
  attestations and evidence and connects verifier status to the score.
- Only the server checks signatures for now. The signed message and signature are stored, so
  Phase 11 can anchor attestations on Solana (`chainAttestationAddress`) and publish what is
  needed to check them without exposing individual verifiers' wallets.
- Owners cannot choose a verifier; if no eligible verifier claims a request it expires.
- A single administrator can define and publish templates alone until a second administrator is
  granted; operators should grant a second one before launch.
- Expiry happens when a request is read or acted on; a worker job can do it on a schedule later.
- Disputes, and administrators reviewing evidence or revoking attestations, need admin tooling
  (later phase).
