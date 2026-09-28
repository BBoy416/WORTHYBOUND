import { createStorageFromConfig, loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { STAGING_PREFIX } from "../evidence/service.js";

/**
 * Creates and configures the private evidence bucket: `pnpm storage:setup`. Safe to run again.
 * Fails if files in the bucket can be read without credentials.
 */
loadLocalEnv();
const config = loadConfig(process.env);
const storage = createStorageFromConfig(config);
try {
  const report = await storage.setup({
    stagingPrefix: STAGING_PREFIX,
    corsOrigins: [config.publicWebUrl],
  });
  console.log(
    [
      `Bucket ${storage.bucket} ${report.bucketCreated ? "created" : "already exists"}`,
      `Abandoned uploads are deleted after 1 day (${STAGING_PREFIX})`,
      `Files cannot be read without credentials: ${report.anonymousReadDenied ? "yes" : "NO"}`,
      report.publicAccessBlocked
        ? "Public access block: on"
        : "Public access block: not supported by this server (access was checked above)",
      report.corsConfigured
        ? `Browser uploads allowed from ${config.publicWebUrl}`
        : "Browser upload origins: not supported by this server (it allows all origins)",
    ].join("\n"),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  storage.destroy();
}
