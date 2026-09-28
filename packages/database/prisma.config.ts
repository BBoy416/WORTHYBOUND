import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (!process.env.DATABASE_URL && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // `prisma generate` does not connect; migrate commands fail clearly without DATABASE_URL.
    url: process.env.DATABASE_URL ?? "",
  },
});
