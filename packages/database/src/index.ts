import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export * from "./generated/prisma/client.js";
export { DatabaseErrorCode, isDatabaseError } from "./errors.js";

/** Creates a Prisma client backed by the node-postgres driver adapter. */
export function createPrismaClient(connectionString: string): PrismaClient {
  if (!connectionString) {
    throw new Error("A PostgreSQL connection string is required");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
