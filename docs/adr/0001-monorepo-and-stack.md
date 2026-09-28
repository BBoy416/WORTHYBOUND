# ADR 0001: Monorepo and technology stack

- Status: Accepted
- Date: 2026-09-28

## Context

WorthyBound needs an API, background worker, Solana program, shared domain code and later a web
frontend. Security-sensitive logic (Trust Score, authority checks) must live server-side and be
shared without duplication.

## Decision

- **Monorepo:** pnpm workspaces + Turborepo. Layout: `apps/` (api, worker, web), `packages/`
  (database, shared, validation, trust-engine, solana, storage), `programs/worthybound` (Anchor),
  `tests/`, `docs/`.
- **Runtime:** Node.js 24 LTS, TypeScript (strict), ESM.
- **API:** Fastify + Zod. **Database:** PostgreSQL 16 + Prisma. **Tests:** Vitest.
- **Solana:** Rust + Anchor 1.x; `@solana/kit` client generated with Codama. Devnet only.
- **Local services:** Docker Compose with PostgreSQL and S3-compatible object storage.
- **Object storage:** upstream MinIO community distribution ended in late 2025 and the project was
  archived in 2026. Local development uses the community-maintained drop-in fork
  `pgsty/minio` (same `MINIO_*` configuration and S3 API), pinned to a release tag. Application code
  talks only to the S3 API through `packages/storage`, so the server can be swapped without code
  changes. Revisited in Phase 6: the fork was renamed Silo (`pgsty/silo`) in August 2026 and is
  still maintained; the project now uses it (ADR 0010).
- **Secret hygiene:** gitleaks as a pre-commit hook (`.githooks/`) and in CI over the full history.
  Keypairs and `.env` files are never committed.

## Consequences

- Packages are added phase by phase; empty placeholder packages are not created ahead of time.
- TypeScript is pinned to 6.0.x until `typescript-eslint` supports TypeScript 7.
