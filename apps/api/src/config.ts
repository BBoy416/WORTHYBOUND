import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "expected a PostgreSQL connection string"),
  /** Host (and port, if any) of the website users sign in to; bound into every sign-in message. */
  AUTH_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+(:\d{1,5})?$/, "expected a host such as worthybound.com or localhost:3000"),
  /** Keys the HMAC of IP addresses and user agents in sessions and audit logs. */
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  SOLANA_CLUSTER: z.literal("devnet", { error: "only devnet is supported" }),
});

export type Config = z.infer<typeof configSchema> & {
  /** SIWS `URI` field, derived from AUTH_DOMAIN. */
  authUri: string;
  /** CAIP-2 style chain ID written into sign-in messages. */
  chainId: "solana:devnet";
};

/** Validates the environment. Throws one error listing every invalid setting, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const config = result.data;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.AUTH_DOMAIN);
  if (config.NODE_ENV === "production" && local) {
    throw new Error("Invalid configuration:\n  AUTH_DOMAIN: must be a public domain in production");
  }
  return {
    ...config,
    authUri: `${local ? "http" : "https"}://${config.AUTH_DOMAIN}`,
    chainId: "solana:devnet",
  };
}
