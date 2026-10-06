# ADR 0016: Solana program, tokenization and chain sync

- Status: Accepted
- Date: 2026-09-29

## Context

ADR 0002 requires tokens that cannot move outside WorthyBound, and left the mechanism to a
Phase 10 spike. The backend is the source of truth for status and the Trust Score (ADR 0006,
ADR 0015); the chain must mirror them without letting a late or repeated transaction overwrite a
newer state. Scope is what the demo on 12 October 2026 needs, on devnet only.

## Decision

**Program.** `programs/worthybound`, Anchor 0.32.1 (`mpl-core` does not yet support Anchor 1.x),
program ID `5stfBCcoD9mpW3514ycoKZBQ4Xzav3KpbZHTC9AUGMem` on devnet.

| Instruction          | Signers               | Does                                                   |
| -------------------- | --------------------- | ------------------------------------------------------ |
| `initialize`         | upgrade authority     | Creates the config with admin and oracle               |
| `set_oracle`         | admin                 | Rotates the oracle key                                 |
| `set_paused`         | admin                 | Pauses or resumes all oracle instructions              |
| `register_asset`     | oracle                | Creates the record and mints the frozen Core asset     |
| `update_status`      | oracle                | Mirrors the asset status                               |
| `commit_trust_score` | oracle                | Mirrors score, level, versions and inputs hash         |
| `transfer_asset`     | oracle, seller, buyer | Unfreezes, transfers and re-freezes in one instruction |

Accounts are PDAs: `config`, `asset` + WB ID (the record) and `core` + WB ID (the Metaplex Core
asset). The record holds WB ID, Core asset, owner, status, Trust Score, verification level,
engine and weights versions, inputs hash, sequence numbers and transfer count. It never holds
serials, evidence, identity or prices (ADR 0006).

**Controlled transfer (confirms ADR 0002).** The Core asset is minted to the owner's wallet with
the config PDA as update authority and two permanent plugins held by the config PDA:
`PermanentFreezeDelegate` (frozen from creation) and `PermanentTransferDelegate`. The owner
cannot transfer, burn or unfreeze it; tests check that Metaplex Core rejects a direct transfer by
the owner. `transfer_asset` needs a `TRANSFER_PENDING` record, the current owner as seller and a
different buyer, and all three signatures, so neither the backend nor a seller can move a token
alone. Escrow and payments (ADR 0014) remain out of scope.

**Ordering.** Every status and score update carries a sequence number: the number of status
events or Trust Score snapshots of the asset in the database. The program rejects a number that
is not greater than the stored one (`StaleUpdate`), so updates can be retried or arrive out of
order without going backwards. `REVOKED` is final on-chain too.

**Keys.** The upgrade authority is also the program admin. A separate oracle key signs
`register_asset`, `update_status`, `commit_trust_score` and pays their fees; the admin can rotate
it or pause the program. On devnet the upgrade authority is a single wallet; the multisig of
ADR 0002 comes before mainnet.

**Chain sync (outbox).** The API writes `chain_transactions` jobs in the same database
transaction as the change: `POST /assets/:wbId/tokenize` queues `REGISTER_ASSET`, and every Trust
Score recomputation (`recordTrust`, ADR 0015), which follows every status change, queues
`UPDATE_ASSET_STATUS` and `COMMIT_TRUST_SCORE` for tokenized assets. Idempotency keys include the
sequence number, so a recomputation without a change queues nothing. A worker in the API sends
jobs with the oracle key, always with the asset's current state:

- confirmed jobs store the signature and appear in the passport;
- a `StaleUpdate` rejection marks the job `SUPERSEDED` (a newer update covered it);
- other failures are retried with backoff (5 s doubling, at most 5 minutes) up to 5 attempts;
- status and score jobs wait until the registration is confirmed;
- a retried registration whose record already exists returns the original signature.

Only one worker may run per database, so the API runs as a single instance.

**Tokenization.** Owner only, for published assets that are `ACTIVE`, `VERIFIED` or
`REVERIFICATION_REQUIRED`, with a verified identity (ADR 0004). The response is `202` with
`tokenizationStatus: PENDING`; it becomes `TOKENIZED` (with a `TOKENIZED` provenance event) or,
after the last failed attempt, `FAILED`, after which the owner can try again. Without an oracle
key the endpoint answers `503`.

**Metadata.** `GET /metadata/:wbId` serves the token metadata (Metaplex JSON) registered as the
Core asset's URI. It is built from the public passport, so it shows nothing the passport does
not, and says that a token alone is not proof of authenticity and that independent in-person
verification is the strongest proof WorthyBound records. The passport shows the token and
record addresses once tokenized.

**Hosting (demo).** Render runs the API and PostgreSQL 16 (`render.yaml`); evidence is stored in
Cloudflare R2 through its S3 API (`S3_REGION=auto`). The oracle keypair is a Render secret file.
`TRUST_PROXY=1` makes rate limits and audit hashes use the client address from Render's proxy.

## Consequences

- The chain can lag the database by a few seconds; the database stays the source of truth and
  the passport shows only confirmed transactions.
- Transfers through the API, admin and recovery transfers with multisig, evidence Merkle roots on
  chain and verifier approvals on chain are later phases.
- A second API instance would send duplicate transactions (rejected as stale, but paying fees);
  scaling out needs a job lock or a separate worker.
- Moving to mainnet needs a new deployment, a multisig upgrade authority and an audit.
