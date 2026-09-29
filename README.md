# WorthyBound

WorthyBound lets anyone create a digital identity for a physical asset and tokenize it on Solana.
Owners add evidence, ownership details and provenance to build the asset's digital passport;
verification by approved professionals raises its Trust Score.

> **Anyone can create and tokenize an asset. Trust must be earned.**
> A token is not proof of authenticity. The Trust Score measures recorded evidence and verification;
> it does not guarantee authenticity, ownership, legal title or value.

## Status

Phase 9: Trust Score snapshots and system-set verified status, on top of verification templates,
requests and signed attestations (Phase 8).
Solana work targets **Devnet only**.

## Repository layout

```text
apps/
  api/                REST API (Fastify): wallet sign-in, assets, evidence, verifiers, templates,
                      verification requests, attestations, passports
packages/
  database/           Prisma schema, migrations and client (PostgreSQL)
  shared/             domain enums, asset IDs, lifecycle rules, public passport and verifier
                      profile, evidence seals, attestation messages
  storage/            S3-compatible object storage for evidence
  trust-engine/       pure, versioned Trust Score calculation
  validation/         request validation schemas (Zod)
programs/             Anchor program (Phase 10)
docs/adr/             architecture decision records
tests/                integration and end-to-end tests (later phases)
docker-compose.yml    local PostgreSQL and S3-compatible storage
```

Planned packages (see [ADR 0001](docs/adr/0001-monorepo-and-stack.md)): `solana`.

## Requirements

- Node.js 24 LTS (`.nvmrc`)
- pnpm (`corepack enable`)
- [gitleaks](https://github.com/gitleaks/gitleaks#installing) (required by the pre-commit hook)
- Docker (for local services)

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
