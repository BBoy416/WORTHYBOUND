import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Only the storage connection settings are taken from .env.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (!process.env.S3_ENDPOINT && existsSync(rootEnv)) {
  const env = parseEnv(readFileSync(rootEnv, "utf8"));
  for (const name of ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
    if (env[name]) process.env[name] = env[name];
  }
}

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
