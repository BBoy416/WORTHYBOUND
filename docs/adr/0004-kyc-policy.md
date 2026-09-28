# ADR 0004: Identity verification (KYC) policy

- Status: Accepted
- Date: 2026-09-28

## Decision

- Anyone may create a draft asset without KYC.
- KYC is required before **tokenization** or **transfer** (both parties).
- KYC is always required for **verifiers**.
- KYC is performed by a third-party provider; WorthyBound stores only the verification status and
  provider reference, never identity documents.
- A KYC'd owner earns a small Trust Score factor and a higher self-documented cap (45 instead of 35).
  KYC establishes who a person is, not whether an item or document is genuine.
