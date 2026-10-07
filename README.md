# WorthyBound

WorthyBound gives a valuable item, such as a watch, a digital passport. The owner's evidence is
kept in a sealed vault. A Trust Score rises as stronger verification is recorded, and a frozen
ownership token on Solana changes hands only through WorthyBound's controlled transfer.

**Live on Solana devnet: [worthybound.com](https://worthybound.com)**

![WorthyBound](apps/web/public/og-image.png)

> **Anyone can register an item. Trust must be earned.**
> A token alone is not proof of authenticity. Independent in-person verification is the strongest
> proof WorthyBound records. The Trust Score measures recorded evidence and verification;
> it does not guarantee authenticity, ownership, legal title or value.

## For hackathon judges

**Architecture:** [docs/architecture.md](docs/architecture.md) (flows, states, data model,
on-chain accounts and API routes).

The live app at [worthybound.com](https://worthybound.com) runs on **Solana devnet**: tokens and
payments use devnet SOL, which has no value. You need a Solana wallet such as Phantom, set to
devnet, and some devnet SOL from [faucet.solana.com](https://faucet.solana.com) for the buyer.

**Identity verification.** Tokenizing needs an identity-verified owner, and buying needs an
identity-verified buyer. No identity-verification (KYC) provider is integrated yet: a server
operator records a wallet's status with `pnpm kyc:record` after the wallet has signed in once. For
the complete demo, both the seller's and the buyer's wallets must be recorded as verified.

To test tokenizing or buying, sign in once with each wallet, then email
[support@worthybound.com](mailto:support@worthybound.com) with the wallet addresses and we will
record them as verified on devnet. Signing in, registering an item, adding evidence and publishing
need no verification.

### Walkthrough: register, tokenize and sell in person

1. **Sign in** by signing a message with your wallet. This proves you control the wallet; it
   does not prove you have the item.
2. **Register an item:** category, brand, model and serial number.
3. **Add evidence:** live camera photos in a guided capture session (each session has a one-time
   code that must appear in a photo), plus receipts or certificates. Files are hashed and sealed,
   and owner evidence goes through automatic checks.
4. **Publish** the item to create its public passport.
5. **Tokenize** (verified owner only). A frozen Metaplex Core token is minted to the owner's
   wallet, and the status and Trust Score are written to the item's WorthyBound record on Solana.
6. **Inspect the passport** (`/passport/<WB ID>`): Trust Score, status, verification history and
   links to the token, the WorthyBound record and each transaction on Solscan and Solana Explorer.
   Private evidence and identity data are not shown.
7. **Sell in person with SOL.** On the buyer's phone, the buyer opens the passport and starts a
   check before buying: the seller signs a one-time code with the owner's wallet ("confirmed
   current owner"), and the buyer photographs the item, which is compared with the recorded
   photos. The seller then starts a transfer on the Transfers page with the buyer's wallet and a
   SOL price. The buyer accepts and both sign. One Solana transaction pays the seller and moves
   the token.

### Separate demonstration: shipped-item escrow

The seller chooses a shipped sale with a SOL price. The buyer pays into escrow. Within 3 days the
seller films the item and the sealed package in a capture session and ships it. On arrival the
buyer has 48 hours to photograph the package and item in a receipt check. If the photos match, or
7 days after delivery without a reported problem, one transaction pays the seller from escrow and
moves the token. If the seller does not ship, the item does not arrive or the photos do not
match, the buyer is refunded or an administrator decides.

### Devnet proof transactions

From the devnet test scripts (`packages/solana/scripts/devnet.mjs`):

- [Sale with payment](https://solscan.io/tx/3bV72b7jEpLZS1CxbZJtyggAsihgk28XvJ6ngREXQoMxNZa7QnxFgz6M3TDq315mpxUMuCcxNHyWKhMxJrBP41Pq?cluster=devnet) ([Explorer](https://explorer.solana.com/tx/3bV72b7jEpLZS1CxbZJtyggAsihgk28XvJ6ngREXQoMxNZa7QnxFgz6M3TDq315mpxUMuCcxNHyWKhMxJrBP41Pq?cluster=devnet)):
  a durable-nonce `transfer_asset` that paid the seller 0.01 SOL and moved the token.
- Escrow release:
  [payment into escrow](https://solscan.io/tx/2GyvNETD89QN8oDVCJwiFA3trSmpwCx4bRSXP4oueroDKLZ7Y9GHH7wP1keWGuPFDNRmbEy1FDBgpfEYKvCqH4zC?cluster=devnet) ([Explorer](https://explorer.solana.com/tx/2GyvNETD89QN8oDVCJwiFA3trSmpwCx4bRSXP4oueroDKLZ7Y9GHH7wP1keWGuPFDNRmbEy1FDBgpfEYKvCqH4zC?cluster=devnet)),
  then
  [transfer from escrow](https://solscan.io/tx/2dUAusJKENCr3EecMrNCg75AbvuxKZUpxicFw1xbz9GNWttGPZHP1rcWUmcYmefke4CrDcpTDSws77ypyHYbvfkq?cluster=devnet) ([Explorer](https://explorer.solana.com/tx/2dUAusJKENCr3EecMrNCg75AbvuxKZUpxicFw1xbz9GNWttGPZHP1rcWUmcYmefke4CrDcpTDSws77ypyHYbvfkq?cluster=devnet)),
  which paid the seller and moved the token.
- Escrow refund:
  [payment](https://solscan.io/tx/66AwyDMiSCFnTJnAQ2712SypeVaETN6L4yHGFzn5bMU8YTv12iPaLVF1jYmyaNWcjzy3wZ7y76J9VCEh2UNoP7Lz?cluster=devnet) ([Explorer](https://explorer.solana.com/tx/66AwyDMiSCFnTJnAQ2712SypeVaETN6L4yHGFzn5bMU8YTv12iPaLVF1jYmyaNWcjzy3wZ7y76J9VCEh2UNoP7Lz?cluster=devnet))
  and
  [refund](https://solscan.io/tx/3EZunqBDqYYTE5cojKT5PzzzA8beMhPQCkjEYYv9RQeJugic4kiX3net3vui1hP5WDm7gWMbTpu2ZbrHYSoHuoc7?cluster=devnet) ([Explorer](https://explorer.solana.com/tx/3EZunqBDqYYTE5cojKT5PzzzA8beMhPQCkjEYYv9RQeJugic4kiX3net3vui1hP5WDm7gWMbTpu2ZbrHYSoHuoc7?cluster=devnet));
  the prepared sale could no longer run.
- [Nonce rent recovery](https://solscan.io/tx/5tUQHjtPNzLr7YwZf5dgrWwCdLSAvCvKguNdr2KMshxWMHiC5Pv5z8EEmv1iXkDpj6LWNKZPSGUg3kJZUKz4g7Fa?cluster=devnet) ([Explorer](https://explorer.solana.com/tx/5tUQHjtPNzLr7YwZf5dgrWwCdLSAvCvKguNdr2KMshxWMHiC5Pv5z8EEmv1iXkDpj6LWNKZPSGUg3kJZUKz4g7Fa?cluster=devnet)):
  three nonce accounts closed in one transaction.

## Why Solana

- **Ownership token.** Each tokenized item is a frozen Metaplex Core token in the owner's wallet.
  It cannot be moved freely, only through WorthyBound's controlled transfer.
- **Public record.** A separate WorthyBound record (a program account) stores the owner, status
  and Trust Score fields, so anyone can check them without trusting WorthyBound's database.
- **Private data stays off-chain.** Evidence files, identity data and attestation details are
  kept off-chain.
- **Atomic in-person sales.** One transaction pays the seller and moves the token, so neither
  side can end up with only half of the trade.
- **Durable nonces.** The prepared sale transaction stays valid, so seller and buyer can sign at
  different times. The seller and buyer sign first; the oracle signs last and submits it.
- **Escrow for shipped sales.** The buyer's SOL is held in escrow until the receipt check or the
  deadline.
- **The oracle** is WorthyBound's backend key. It co-signs transfers after the backend checks,
  mirrors status and Trust Score updates to the WorthyBound record, and controls withdrawals from
  escrow. It is not the token owner.

## How it works

1. **Register:** describe the item. A keyed fingerprint of its category, brand and serial number
   helps detect duplicate registrations: the database rejects a second item with the same
   fingerprint unless the first was revoked.
2. **Prove:** add live camera photos (guided capture with a one-time code), receipts and
   certificates. Every file is hashed, sealed and checked automatically.
3. **Tokenize:** once the owner's identity is verified, a frozen Metaplex Core token is minted to
   their wallet, with the status and Trust Score anchored on-chain.
4. **Verify (optional):** approved verifiers (identity-verified and approved by WorthyBound for
   each category) review the item online or in person and sign attestations with their wallet.
5. **Sell:** buyers check the passport, confirm that the seller controls the owner's wallet and
   compare photos of the item with the recorded ones before paying. A wallet signature alone does
   not prove possession or authenticity. In person, one Solana transaction pays the seller and
   moves the token; shipped items use SOL escrow released after a receipt check.

Sensitive evidence and identity data stay off-chain. Disputes (ADR 0017) can hold an item and
cancel its open transfer. An administrator can revoke an item (see Status).

### Trust is earned

The highest Trust Score depends on how an item was verified (ADR 0003). These are ceilings, not
guaranteed scores: evidence quality, confirmed claims and open disputes set the actual score.

| Evidence and verification                                  | Maximum |
| ---------------------------------------------------------- | ------- |
| Owner evidence only (with verified identity)               | 35 (45) |
| Owner evidence that passed automatic checks                | 65      |
| One online review by an approved verifier                  | 75      |
| Two independent online reviews                             | 80      |
| One in-person inspection                                   | 85      |
| One online review plus an independent in-person inspection | 90      |
| Two independent in-person inspections                      | 100     |

The Trust Score does not guarantee authenticity, ownership, legal title or value.

## Status

**Built (Solana devnet):** wallet sign-in, assets and passports, Evidence Vault, guided capture,
automatic checks, verifier onboarding and signed attestations, Trust Score (engine 1.4.0),
tokenization and chain sync, checks before buying (in person and remote), controlled SOL
transfers, shipped-item SOL escrow, disputes and admin revocation.

**Admin revocation:** an administrator revokes an item with a required reason. A published
passport stays public with a revoked warning; a draft is discarded. Any open transfer and open
verification requests are cancelled. The token stays frozen and is not burned, and the history is
kept: nothing is deleted.

**Planned:**

- Stablecoin payments: USDC, then EURC, then a Canadian dollar stablecoin. SOL remains an option.
- An integrated identity-verification (KYC) provider (today a server operator records the status).
- Mainnet. Real-money escrow on mainnet requires legal review first.
- On-chain anchors for evidence, verifiers and attestations.
- Pricing and fees are proposed only; WorthyBound charges nothing today.

## Repository layout

```text
apps/
  api/                REST API (Fastify): wallet sign-in, assets, evidence, verifiers, templates,
                      verification requests, attestations, passports, tokenization, token
                      metadata and the chain sync worker; serves the web app in production
  web/                web app (Vite + React): wallet sign-in, assets, evidence, guided capture,
                      tokenization, transfers, verification requests, verifier applications
                      and attestations, admin (verifier review, templates, reviewer roles,
                      AI checks) and public passports
packages/
  database/           Prisma schema, migrations and client (PostgreSQL)
  shared/             domain enums, asset IDs, lifecycle rules, public passport and verifier
                      profile, evidence seals, attestation messages
  solana/             client for the program (generated with Codama from the IDL), oracle
                      client, LiteSVM tests and devnet scripts
  storage/            S3-compatible object storage for evidence
  trust-engine/       pure, versioned Trust Score calculation
  validation/         request validation schemas (Zod)
programs/worthybound/ Anchor program (Rust)
docs/adr/             architecture decision records
tests/                integration and end-to-end tests (later phases)
docker-compose.yml    local PostgreSQL and S3-compatible storage
render.yaml           Render Blueprint for the demo deployment (API and web app, PostgreSQL;
                      evidence in R2)
```

## Requirements

- Node.js 24 LTS (`.nvmrc`)
- pnpm (`corepack enable`)
- [gitleaks](https://github.com/gitleaks/gitleaks#installing) (required by the pre-commit hook)
- Docker (for local services)
- For the program only: Rust (`rust-toolchain.toml`), the Agave (Solana) CLI and Anchor 0.32.1

## Getting started

```sh
corepack enable
pnpm install          # also enables the gitleaks pre-commit hook
cp .env.example .env  # then replace every placeholder value
```

Start local services, apply database migrations and create the evidence bucket:

```sh
docker compose --env-file .env up -d
pnpm db:migrate:deploy
pnpm storage:setup
```

Database integration tests need `TEST_DATABASE_URL`, and evidence tests also need `S3_ENDPOINT`,
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, read from the environment or from `.env` (see
`.env.example`). They create and delete throwaway databases and buckets, and are skipped when
these are not set.

Run the API (needs `SESSION_SECRET` and `SERIAL_FINGERPRINT_KEY` in `.env`, each e.g. from
`openssl rand -base64 48`):

```sh
pnpm api:start        # http://127.0.0.1:4000/health
```

Run the web app in development (with the API running; it proxies API calls to port 4000). Set
`AUTH_DOMAIN=localhost:5173` so sign-in messages and storage CORS match the app's address, and
run `pnpm storage:setup` again after changing it:

```sh
pnpm web:dev          # http://localhost:5173
```

In production the API serves the built app itself (`WEB_DIST_DIR`), so the app, sign-in and
passport links (`/passport/:wbId`) share one domain. Page loads get the app; API calls with
`Accept: application/json` reach the API. Sign-in needs a Solana wallet extension such as Phantom.

To tokenize assets, set `SOLANA_TRUST_ORACLE_KEYPAIR_PATH` to the oracle keypair (outside the
repository). Without it the API starts, but `POST /assets/:wbId/tokenize` and `POST /transfers`
answer 503.

To enable AI checks of owner evidence and reports on verifier applications (ADR 0013), set
`OPENAI_API_KEY` (and optionally `OPENAI_MODEL`). Without it they are unavailable.

## Solana program (devnet)

```sh
anchor build                                   # target/deploy/worthybound.so and the IDL
pnpm --filter @worthybound/solana generate:client   # after changing the IDL
pnpm --filter @worthybound/solana test         # LiteSVM tests (skipped if the program is not built)
anchor deploy --provider.cluster devnet        # deploy or upgrade (wallet in Anchor.toml)
pnpm --filter @worthybound/solana build
node packages/solana/scripts/devnet.mjs init <admin keypair> <oracle keypair>   # once
node packages/solana/scripts/devnet.mjs set-oracle <admin keypair> <oracle address>
node packages/solana/scripts/devnet.mjs smoke <oracle keypair>
```

The program admin must be the upgrade authority. The oracle key only mirrors backend state and
pays for it; keep it funded with devnet SOL. `set-oracle` replaces it, e.g. when it is lost.

## Deployment (demo)

`render.yaml` defines the API and PostgreSQL 16 on Render. Before the first deploy:

1. Create a private R2 bucket `worthybound-evidence-private` and an R2 API token with Object Read
   & Write on it. Enter the endpoint (`https://<account id>.r2.cloudflarestorage.com`) and the
   token's keys when Render asks for them.
2. Add the oracle keypair as a Render secret file named `wb-oracle.json`.
3. Set `AUTH_DOMAIN` and `API_PUBLIC_URL` (the service's public URL).
4. After the first deploy, run `pnpm storage:setup` once from the Render shell. It sets the
   bucket's lifecycle and CORS rules and needs a token that may change bucket settings.

Grant the first administrator (server operators only; there is no API for this):

```sh
pnpm admin:grant <wallet address>
```

Record a KYC provider's result for a user who has signed in (server operators only, until a
provider is integrated; verifiers can only be approved with a verified identity):

```sh
pnpm kyc:record <wallet address> <provider> <reference> [VERIFIED|REJECTED|EXPIRED]
```

## Scripts

| Command                  | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `pnpm test`              | Run all tests                                  |
| `pnpm typecheck`         | Type-check all packages                        |
| `pnpm lint`              | ESLint                                         |
| `pnpm format`            | Format with Prettier                           |
| `pnpm build`             | Build all packages                             |
| `pnpm secrets:scan`      | Scan the Git history for leaked secrets        |
| `pnpm db:generate`       | Generate the Prisma client                     |
| `pnpm db:migrate:dev`    | Create and apply a new migration (development) |
| `pnpm db:migrate:deploy` | Apply pending migrations                       |
| `pnpm db:migrate:status` | Show migration status                          |
| `pnpm api:start`         | Build and start the API                        |
| `pnpm web:dev`           | Start the web app (development server)         |
| `pnpm admin:grant`       | Grant ADMIN to a wallet (operators only)       |
| `pnpm kyc:record`        | Record a KYC result (operators only)           |
| `pnpm storage:setup`     | Create and configure the evidence bucket       |

## Git workflow

- `main` is stable, `dev` is active development. Never commit directly to `main`.
- Work on feature branches off `dev` (e.g. `feature/wallet-auth`) and open pull requests into `dev`.
- No force pushes or history rewrites.

## Security

- Never commit `.env` files, keypairs or credentials. Keypairs live outside the repository
  (e.g. `~/.config/solana/`).
- The Trust Score is calculated only by the backend; clients never submit it.
- Private evidence and identity data never go on-chain or into the public passport.

## Architecture decisions

- [0001 Monorepo and technology stack](docs/adr/0001-monorepo-and-stack.md)
- [0002 Controlled transfer of asset tokens](docs/adr/0002-controlled-transfer.md)
- [0003 Weighted Trust Score](docs/adr/0003-weighted-trust-score.md)
- [0004 KYC policy](docs/adr/0004-kyc-policy.md)
- [0005 Database integrity enforced in PostgreSQL](docs/adr/0005-database-integrity.md)
- [0006 Core domain model](docs/adr/0006-core-domain-model.md)
- [0007 Item condition](docs/adr/0007-item-condition.md)
- [0008 Wallet authentication](docs/adr/0008-wallet-authentication.md)
- [0009 Asset registration and passports](docs/adr/0009-asset-registration.md)
- [0010 Evidence Vault](docs/adr/0010-evidence-vault.md)
- [0011 Verifier system](docs/adr/0011-verifier-system.md)
- [0012 Verification requests and signed attestations](docs/adr/0012-verification.md)
- [0013 Automated checks and guided capture](docs/adr/0013-automated-checks.md)
  (accepted, partly implemented)
- [0014 Checks before buying, and escrowed transfers](docs/adr/0014-transfer-checks-and-escrow.md)
  (accepted, implemented on devnet; stablecoin payments planned)
- [0015 Trust Score and verified status](docs/adr/0015-trust-score-and-verified-status.md)
- [0016 Solana program, tokenization and chain sync](docs/adr/0016-solana-program.md)
- [0017 Disputes](docs/adr/0017-disputes.md)
