import { createPrismaClient } from "@worthybound/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadLocalEnv } from "./env.js";

loadLocalEnv();
const config = loadConfig(process.env);
const prisma = createPrismaClient(config.DATABASE_URL);
const app = await buildApp({ config, prisma });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
