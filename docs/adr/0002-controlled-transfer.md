# ADR 0002: Controlled transfer of asset tokens

- Status: Accepted (mechanism to be confirmed by the Phase 10 spike)
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

## Consequences

- Tokens do not trade on external marketplaces until they integrate with the WorthyBound transfer
  process.
- WorthyBound holds a powerful authority over tokens; it is governed by multisig and on-chain audit.
