import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads the repository's .env for local runs. Variables already set take precedence. */
export function loadLocalEnv(): void {
  const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}
