import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Only TEST_DATABASE_URL is taken from .env.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (!process.env.TEST_DATABASE_URL && existsSync(rootEnv)) {
  const url = parseEnv(readFileSync(rootEnv, "utf8")).TEST_DATABASE_URL;
  if (url) process.env.TEST_DATABASE_URL = url;
}

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
