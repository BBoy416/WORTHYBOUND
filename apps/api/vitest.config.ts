import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Only the test database and storage connection settings are taken from .env.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) {
  const env = parseEnv(readFileSync(rootEnv, "utf8"));
  const names = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
  if (!process.env.TEST_DATABASE_URL && env.TEST_DATABASE_URL) {
    process.env.TEST_DATABASE_URL = env.TEST_DATABASE_URL;
  }
  if (!process.env.S3_ENDPOINT) {
    for (const name of names) if (env[name]) process.env[name] = env[name];
  }
}

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
