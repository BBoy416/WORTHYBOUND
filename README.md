# WorthyBound

WorthyBound gives any valuable item a portable digital identity on Solana: a sealed evidence
vault, a Trust Score that rises with stronger verification, and a frozen ownership token that
moves only through WorthyBound's verified transfer.

**Live on Solana devnet: [worthybound.com](https://worthybound.com)**

![WorthyBound](apps/web/public/og-image.png)

> **Anyone can register an item. Trust must be earned.**
> A token is not proof of authenticity. The Trust Score measures recorded evidence and verification;
> it does not guarantee authenticity, ownership, legal title or value.

## How it works

1. **Register:** describe the item. Its serial number is fingerprinted, so it cannot be
   registered twice.
2. **Prove:** add live camera photos (guided capture with a one-time code), receipts and
   certificates. Every file is hashed, sealed and checked automatically.
3. **Tokenize:** once the owner's identity is verified, a frozen Metaplex Core token is minted to
   their wallet, with the status and Trust Score anchored on-chain.
4. **Verify (optional):** approved professionals review the item online or in person and sign
   attestations with their wallet.
5. **Sell:** buyers check the passport and confirm the seller controls the item before paying.
   In person, one Solana transaction pays the seller and moves the token; shipped items use SOL
   escrow released on a receipt check.

Sensitive evidence and identity data stay off-chain. Disputes (ADR 0017) can hold an item and
cancel its open transfer.

### Trust is earned

The highest Trust Score depends on how an item was verified (ADR 0003). Evidence quality,
confirmed claims and open disputes set the actual score.

| Evidence and verification                                  | Maximum |
| ---------------------------------------------------------- | ------- |
| Owner evidence only (with verified identity)               | 35 (45) |
| Owner evidence that passed automatic checks                | 65      |
| One online review by an approved verifier                  | 75      |
| Two independent online reviews                             | 80      |
| One in-person inspection                                   | 85      |
| One online review plus an independent in-person inspection | 90      |
| Two independent in-person inspections                      | 100     |

## Status

Built on Solana devnet: wallet sign-in, assets and passports, Evidence Vault, guided capture,
automatic checks, verifier onboarding and signed attestations, Trust Score (engine 1.4.0),
tokenization and chain sync, checks before buying (in person and remote), controlled SOL
transfers, shipped-item SOL escrow and disputes. Not yet built: real (fiat or stablecoin)
payments, an identity-verification provider (identity is recorded by an operator) and mainnet.

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
- [0013 Automated checks and guided capture](docs/adr/0013-automated-checks.md) (proposed)
- [0014 Checks before buying, and escrowed transfers](docs/adr/0014-transfer-checks-and-escrow.md)
  (proposed)
- [0015 Trust Score and verified status](docs/adr/0015-trust-score-and-verified-status.md)
- [0016 Solana program, tokenization and chain sync](docs/adr/0016-solana-program.md)
- [0017 Disputes](docs/adr/0017-disputes.md)
