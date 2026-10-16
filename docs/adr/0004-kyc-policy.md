# ADR 0004: Identity verification (KYC) policy

- Status: Accepted
- Date: 2026-09-28

## Decision

- Anyone may create a draft asset without KYC.
- KYC is required before **tokenization** or **transfer** (both parties). Every item is tokenized
  before its passport is published (ADR 0016, 2026-10-16), so publishing needs KYC too.
- KYC is always required for **verifiers**.
- KYC is performed by a third-party provider; WorthyBound stores only the verification status and
  provider reference, never identity documents.
- **Devnet (2026-10-16):** the owner and buyer requirements are off while WorthyBound runs on
  Solana devnet, so anyone who signs in can publish, receive a transfer and open a dispute. They
  stay built behind `KYC_REQUIRED` (default `false`) and are turned on before going live. Verifiers
  still need KYC, which the database enforces; operators record it with `pnpm kyc:record`.
  `GET /auth/me` returns `kycRequired` so the web app shows the requirement only when it applies.
- A KYC'd owner earns a small Trust Score factor and a higher self-documented cap (45 instead of 35).
  KYC establishes who a person is, not whether an item or document is genuine.
