# WorthyBound

WorthyBound lets anyone create a digital identity for a physical asset and tokenize it on Solana.
Owners add evidence, ownership details and provenance to build the asset's digital passport;
verification by approved professionals raises its Trust Score.

> **Anyone can create and tokenize an asset. Trust must be earned.**
> A token is not proof of authenticity. The Trust Score measures recorded evidence and verification;
> it does not guarantee authenticity, ownership, legal title or value.

## Status

Phase 3: core domain model (lifecycle rules, public passport, input validation). Solana work
targets **Devnet only**.

## Repository layout

```text
apps/                 api, worker, web (added in later phases)
packages/
  database/           Prisma schema, migrations and client (PostgreSQL)
  shared/             domain enums, asset IDs, lifecycle rules, public passport
  trust-engine/       pure, versioned Trust Score calculation
  validation/         request validation schemas (Zod)
programs/             Anchor program (Phase 10)
docs/adr/             architecture decision records
tests/                integration and end-to-end tests (later phases)
docker-compose.yml    local PostgreSQL and S3-compatible storage
```

Planned packages (see [ADR 0001](docs/adr/0001-monorepo-and-stack.md)): `solana`, `storage`.

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

Start local services and apply database migrations:

```sh
docker compose --env-file .env up -d
pnpm db:migrate:deploy
```

Database integration tests need `TEST_DATABASE_URL`, read from the environment or from `.env`
(see `.env.example`); they create and drop throwaway databases and are skipped when it is not set.

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
