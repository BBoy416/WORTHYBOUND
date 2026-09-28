# ADR 0008: Wallet authentication

- Status: Accepted
- Date: 2026-09-28

## Context

Users sign in with a Solana wallet. The sign-in must not be replayable, must not work for another
website or network, and must never be mistaken for proof of real-world identity.

## Decision

**Sign In With Solana (SIWS).** The standard supported by Phantom, Solflare and other Wallet
Standard wallets. Signing costs nothing and sends no transaction.

1. `POST /auth/nonce { address }` stores a one-time nonce (128 random bits, valid 5 minutes) and
   returns the SIWS request (`input`, for the wallet's `signIn` feature) and its message text (for
   wallets that only support `signMessage`).
2. `POST /auth/verify { address, message, signature }` (message and signature base64). The server
   accepts the sign-in only if:
   - the message parses as SIWS and its nonce was issued by the server;
   - every field equals the issued request: domain (`AUTH_DOMAIN`), address, statement, URI,
     version, chain ID `solana:devnet`, nonce, issued-at and expiry; no fields were added;
   - the Ed25519 signature by the wallet's public key over the exact message bytes is valid;
   - the nonce has not expired and has not been used. It is consumed with a conditional update
     inside the sign-in transaction, so of several simultaneous uses exactly one succeeds; the
     database also rejects any second use (ADR 0005).

   Clients get one generic `sign_in_failed` error; the specific reason is written to the audit log.

**Accounts.** The first sign-in of a wallet creates a user with identity `UNVERIFIED` and the
`USER` role. A wallet is not proof of identity; KYC stays separate (ADR 0004).

**Sessions.** A random 256-bit token in the `wb_session` cookie (`HttpOnly`, `SameSite=Strict`,
`Secure` in production), valid 7 days. Only its SHA-256 is stored, so a database leak cannot be
used to sign in. Logout revokes the session immediately.

**Roles.** Read from the database on every request, so a revoked role takes effect at once. ADMIN
is granted only with `pnpm admin:grant <wallet>`, run by the server operator; there is no API for
it.

**Abuse and privacy.**

- Sign-in endpoints are rate limited per IP address (10 per minute).
- The API accepts JSON bodies only (no cross-site form posts) and sets security headers.
- Sign-ins, failed sign-ins (with reason), logouts and role grants go to the append-only audit
  log. IP addresses and user agents are stored only as HMAC-SHA256 keyed with `SESSION_SECRET`.
- Cookies and authorization headers are redacted from logs.
- The API refuses to start with an invalid configuration, a `SESSION_SECRET` shorter than 32
  characters, a cluster other than devnet, or a localhost `AUTH_DOMAIN` in production.

## Consequences

- The rate limit is kept in memory per API instance. Running several instances, or running behind
  a proxy, requires a shared store and trusted-proxy configuration.
- Expired nonces and sessions stay in the database until a cleanup job is added (worker, later
  phase).
- Changing `SESSION_SECRET` breaks correlation of old IP hashes but does not sign anyone out.
