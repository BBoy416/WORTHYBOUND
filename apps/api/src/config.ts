import { WORTHYBOUND_PROGRAM_ADDRESS } from "@worthybound/solana";
import { createStorage, type Storage } from "@worthybound/storage";
import { z } from "zod";

/** Empty values in .env files count as unset. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Reverse proxies in front of the API whose X-Forwarded-For entries are trusted; 0 = none. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "expected a PostgreSQL connection string"),
  /** Host (and port, if any) of the website users sign in to; bound into every sign-in message. */
  AUTH_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+(:\d{1,5})?$/, "expected a host such as worthybound.com or localhost:3000"),
  /** Keys the HMAC of IP addresses and user agents in sessions and audit logs. */
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  /** Keys the HMAC of serial numbers used to stop the same item being registered twice. */
  SERIAL_FINGERPRINT_KEY: z.string().min(32, "must be at least 32 characters"),
  SOLANA_CLUSTER: z.literal("devnet", { error: "only devnet is supported" }),
  SOLANA_RPC_URL: z.url({ protocol: /^https?$/ }).default("https://api.devnet.solana.com"),
  /** WebSocket endpoint for confirmations; defaults to SOLANA_RPC_URL with ws(s). */
  SOLANA_WS_URL: optional(z.url({ protocol: /^wss?$/ })),
  /** If set, must be the program the client was generated for (a guard against mixing up builds). */
  WORTHYBOUND_PROGRAM_ID: optional(
    z.literal(WORTHYBOUND_PROGRAM_ADDRESS, {
      error: `must be ${WORTHYBOUND_PROGRAM_ADDRESS}, the program this build uses`,
    }),
  ),
  /** Oracle keypair file, outside the repository. Tokenization is unavailable without it. */
  SOLANA_TRUST_ORACLE_KEYPAIR_PATH: optional(z.string()),
  /** Built web app (apps/web/dist) to serve on this origin; the API alone when unset. */
  WEB_DIST_DIR: optional(z.string()),
  /** Public address of this API; token metadata links point here. */
  API_PUBLIC_URL: optional(z.url({ protocol: /^https?$/ })),
  /** S3 API endpoint of the evidence storage; omit for AWS S3. */
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET_EVIDENCE_PRIVATE: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "expected an S3 bucket name")
    .default("worthybound-evidence-private"),
  S3_ACCESS_KEY_ID: z.string().min(3, "must be at least 3 characters"),
  S3_SECRET_ACCESS_KEY: z.string().min(8, "must be at least 8 characters"),
});

export type Config = z.infer<typeof configSchema> & {
  /** SIWS `URI` field, derived from AUTH_DOMAIN. */
  authUri: string;
  /** CAIP-2 style chain ID written into sign-in messages. */
  chainId: "solana:devnet";
  /** Website that serves public passports (QR codes link here); same origin as sign-in. */
  publicWebUrl: string;
  /** API_PUBLIC_URL, or this API's local address in development. */
  apiPublicUrl: string;
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
  if (config.NODE_ENV === "production" && !config.API_PUBLIC_URL) {
    throw new Error("Invalid configuration:\n  API_PUBLIC_URL: required in production");
  }
  const authUri = `${local ? "http" : "https"}://${config.AUTH_DOMAIN}`;
  const localHost = config.API_HOST === "0.0.0.0" ? "127.0.0.1" : config.API_HOST;
  const apiPublicUrl = (config.API_PUBLIC_URL ?? `http://${localHost}:${config.API_PORT}`).replace(
    /\/$/,
    "",
  );
  return { ...config, authUri, chainId: "solana:devnet", publicWebUrl: authUri, apiPublicUrl };
}

export function createStorageFromConfig(config: Config): Storage {
  return createStorage({
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    bucket: config.S3_BUCKET_EVIDENCE_PRIVATE,
  });
}
