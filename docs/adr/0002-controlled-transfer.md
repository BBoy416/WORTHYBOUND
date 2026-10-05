# ADR 0002: Controlled transfer of asset tokens

- Status: Accepted (mechanism confirmed in Phase 10, ADR 0016); amendment proposed in ADR 0014
- Date: 2026-09-28

## Context

A freely transferable NFT lets a thief move a token in seconds, separates the token from the
physical item and lets tokens reach parties without KYC or history.

## Decision

WorthyBound asset tokens are **not freely transferable**.

1. Tokens are frozen from creation. The freeze is controlled by the WorthyBound program, not the
   owner.
2. Transfers happen only through the WorthyBound process: the seller starts a transfer
   (`TRANSFER_PENDING`), the buyer must be KYC'd and accept, and the program unfreezes, transfers and
   re-freezes the token in a single transaction.
3. Transfers are blocked while the asset is `DISPUTED` or `REPORTED_STOLEN`.
4. After transfer a new custody period starts; POSSESSION and CONDITION claims stop counting until
   reverification.
5. Implementation: Metaplex Core asset with permanent plugins (Permanent Freeze / Transfer Delegate
   held by a program PDA). The exact plugin configuration is validated in the Phase 10 spike.
6. Wallet recovery and administrative transfers require multisig approval, are recorded publicly
   on-chain and are described in the terms of service.

## Implementation (API)

- `POST /transfers` starts a transfer of a tokenized asset (`ACTIVE`, `VERIFIED` or
  `REVERIFICATION_REQUIRED`) to a wallet that has signed in and has a verified identity. The asset
  becomes `TRANSFER_PENDING`; one transfer can be open per asset. Transfers expire after
  `expiresInHours` (default 72) unless both parties have signed.
- `POST /transfers/:id/accept` (recipient) prepares the `transfer_asset` transaction on a durable
  nonce account the oracle creates, so the parties can sign at different times. The seller and
  buyer sign it with their wallets (`POST /transfers/:id/signature`); the API checks each
  signature against the prepared transaction. Once both have signed, the chain worker adds the
  oracle's signature and sends it.
- On confirmation the buyer becomes the owner, a new custody period starts, the asset returns to
  its status before the transfer and the seller's open verification requests are cancelled.
- Rejection, cancellation, expiry, or a new status (`REPORTED_STOLEN`, `REPORTED_LOST`,
  `DISPUTED`, `REVOKED`) close the
  transfer. Except for that last case, the asset returns to its previous status. Neither party can
  cancel while the signed transaction is being sent, unless the chain worker gave up.
- Once a transfer has ended and none of its chain jobs can still run, the chain worker closes its
  nonce accounts (`CLOSE_NONCE_ACCOUNTS`), returning their rent to the oracle. Accounts that still
  hold more than their rent, such as an escrow not yet refunded, are left open.

## Consequences

- Tokens do not trade on external marketplaces until they integrate with the WorthyBound transfer
  process.
- WorthyBound holds a powerful authority over tokens; it is governed by multisig and on-chain audit.
