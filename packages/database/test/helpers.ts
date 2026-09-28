import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPrismaClient, type PrismaClient } from "../src/index.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL && process.env.CI) {
  throw new Error("TEST_DATABASE_URL must be set in CI");
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export interface TestDatabase {
  prisma: PrismaClient;
  /** Raw connection for SQL that bypasses Prisma (e.g. tampering tests). */
  sql: pg.Client;
  url: string;
  drop(): Promise<void>;
}

/** Creates an isolated database, applies all migrations and returns connected clients. */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const name = `wb_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;

  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "pipe",
  });

  const prisma = createPrismaClient(url.toString());
  const sql = new pg.Client({ connectionString: url.toString() });
  await sql.connect();

  return {
    prisma,
    sql,
    url: url.toString(),
    async drop() {
      await prisma.$disconnect();
      await sql.end();
      const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export const randomHex64 = (): string => randomBytes(32).toString("hex");

export const wbId = (): string => `WB-${randomBytes(4).toString("hex").toUpperCase()}`;

export const wallet = (): string => randomBytes(32).toString("base64url");
