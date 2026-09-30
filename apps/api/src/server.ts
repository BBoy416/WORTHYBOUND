import { createOpenAIEngine } from "@worthybound/automated-checks";
import { createPrismaClient } from "@worthybound/database";
import { createConnection, createWorthyBoundOracle, loadKeypairSigner } from "@worthybound/solana";
import { buildApp } from "./app.js";
import { createStorageFromConfig, loadConfig } from "./config.js";
import { loadLocalEnv } from "./env.js";

loadLocalEnv();
const config = loadConfig(process.env);
const prisma = createPrismaClient(config.DATABASE_URL);
const storage = createStorageFromConfig(config);
const oracle = config.SOLANA_TRUST_ORACLE_KEYPAIR_PATH
  ? createWorthyBoundOracle(
      createConnection(config.SOLANA_RPC_URL, config.SOLANA_WS_URL),
      await loadKeypairSigner(config.SOLANA_TRUST_ORACLE_KEYPAIR_PATH),
    )
  : undefined;
const checkEngine = config.OPENAI_API_KEY
  ? createOpenAIEngine({ apiKey: config.OPENAI_API_KEY, model: config.openaiModel })
  : undefined;
const app = await buildApp({
  config,
  prisma,
  storage,
  ...(oracle ? { oracle } : {}),
  ...(checkEngine ? { checkEngine } : {}),
});
if (oracle) {
  app.log.info({ oracle: oracle.oracleAddress }, "chain sync enabled (devnet)");
  app.chainSync?.start();
} else {
  app.log.warn("SOLANA_TRUST_ORACLE_KEYPAIR_PATH is not set; tokenization is unavailable");
}
if (checkEngine) {
  app.log.info({ model: config.openaiModel }, "AI checks enabled");
  app.automatedChecks?.start();
} else {
  app.log.warn("OPENAI_API_KEY is not set; AI checks are unavailable");
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await prisma.$disconnect();
  storage.destroy();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
