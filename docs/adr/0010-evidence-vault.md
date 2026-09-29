# ADR 0010: Evidence Vault

- Status: Accepted
- Date: 2026-09-28

## Context

Owners attach photos, documents and videos to their assets. Evidence is only useful if the file
cannot be swapped or faked after the fact, private files never leak, and published photos do not
reveal where the owner lives.

## Decision

**Endpoints** (signed in, owner only unless noted):

| Endpoint                                             | Does                                                |
| ---------------------------------------------------- | --------------------------------------------------- |
| `POST /assets/:wbId/evidence/uploads`                | Records the request; returns a one-time upload form |
| `POST /evidence/uploads/:uploadId/complete`          | Checks the uploaded file and stores it as evidence  |
| `GET /assets/:wbId/evidence`                         | The asset's evidence                                |
| `POST /assets/:wbId/evidence/:evidenceId/download`   | 5-minute download link                              |
| `POST /assets/:wbId/evidence/:evidenceId/visibility` | Makes a photo public or private again               |
| `GET /passport/:wbId/evidence/:evidenceId`           | Public photo of a published passport; no sign-in    |

**Upload.** The client declares type, file type, size and SHA-256, then sends the file straight to
storage with a presigned form valid for 15 minutes. The storage server itself rejects any other
size or content type and any other key. Files land in a holding area (`staging/`) that the bucket
empties after one day. Videos of up to 500 MB never pass through the API.

**Checks on completion.** The file is first copied (only if unchanged since it was inspected) to a
key only the server can write, and every check runs on that copy, so it cannot be swapped between
checking and storing. The server computes the SHA-256 itself and detects the file type from the
contents (`file-type`); a wrong size, type or hash rejects the upload and nothing is kept. The
upload record keeps the reason. Completion is safe to retry and to run concurrently.

**Immutability.** A database trigger keeps the file, hash, size, type, asset, uploader and
description of accepted evidence unchanged, forbids deleting evidence and makes the review
decision final. Upload requests are completed or failed once. Each addition writes
`EVIDENCE_ADDED` to the hash-chained provenance log (ADR 0005).

**Seal.** Each addition creates a new evidence commitment: a Merkle root over the file hashes in
the order they were added (`sha256-merkle-v1`: leaf = SHA-256(0x00 ‖ hash), node =
SHA-256(0x01 ‖ left ‖ right), an unpaired node moves up unchanged). The passport shows each seal
and its file count, never the files. `merkleProof` / `verifyMerkleProof` prove one file belongs to
a seal without revealing the others. Phase 11 anchors the latest seal on Solana.

**Privacy.** Everything is stored in one private bucket. `pnpm storage:setup` creates it, blocks
public access where the server supports it and fails if a file can be read without credentials.
Storage keys are never returned. Owners download through links valid for 5 minutes that always
save the file (`Content-Disposition: attachment`), so a harmful PDF cannot run in the site. Other
people's assets and evidence answer 404, as for unknown IDs.

**Public photos.** Only JPEG, PNG and WebP photos can be public (database check). Making one
public re-encodes it with `sharp`, which applies the orientation and drops EXIF, GPS, XMP, IPTC,
comments and colour profiles; the original stays private and keeps its hash. The API serves the
copy with `Content-Security-Policy: default-src 'none'; sandbox`. Hiding the photo deletes the copy
and records `EVIDENCE_VISIBILITY_CHANGED`. HEIC photos stay private (the image library cannot
decode them).

**Duplicates.** The same file twice on one asset is rejected (`409 duplicate_evidence`, also a
unique index). The same file on another asset is accepted, linked to the earliest copy
(`duplicateOfId`) and audited as `evidence.duplicate_flagged` for admins; the uploader is not told.
Phase 9 will count such evidence as weaker.

**Types and limits.** Evidence types now include service records, ownership documents,
manufacturer documents and video. Images and PDFs up to 25 MB, videos up to 500 MB (database
check). At most 100 files per asset, counting pending uploads. 30 upload requests per user per
hour. Evidence can be added to drafts, published, lost and stolen assets, not to revoked ones.

**Storage server.** The MinIO fork used since Phase 1 was renamed Silo (`pgsty/silo`) and is
still maintained; Docker Compose and CI use `pgsty/silo:RELEASE.2026-09-16T00-00-00Z`, a drop-in
replacement with the same `MINIO_*` settings and data format. All storage access goes through
`packages/storage` (AWS SDK v3), so AWS S3 or another S3-compatible server can replace it.

## Consequences

- Evidence tests need a storage server (Docker locally, a container in CI).
- The same photo on two assets is not blocked; only exact copies are detected, not edited or
  resized ones.
- Files are not scanned for viruses yet; this must be added before launch. Until then, files are
  never opened inside the website.
- Serving public photos through the API costs API bandwidth; a CDN can be added in front later.
- Uploads that are requested but never completed stay as pending records; the storage copy is
  removed after a day, and a cleanup job for the records comes with the worker (later phase).
- Evidence can only be added by the owner in this phase; verifiers add evidence in Phase 8, with
  verification requests, when evidence review also starts (ADR 0011).
- Phase 8: the verifier assigned to a verification request adds and reviews evidence (ADR 0012).
