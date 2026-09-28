import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgresql://user:do-not-print@127.0.0.1:5432/worthybound",
  AUTH_DOMAIN: "localhost:3000",
  SESSION_SECRET: "s".repeat(32),
  SOLANA_CLUSTER: "devnet",
};

describe("loadConfig", () => {
  it("applies defaults and derives the sign-in URI and chain", () => {
    expect(loadConfig(valid)).toMatchObject({
      NODE_ENV: "development",
      API_HOST: "127.0.0.1",
      API_PORT: 4000,
      authUri: "http://localhost:3000",
      chainId: "solana:devnet",
    });
    expect(loadConfig({ ...valid, AUTH_DOMAIN: "app.worthybound.com" }).authUri).toBe(
      "https://app.worthybound.com",
    );
  });

  it("lists every invalid setting without printing values", () => {
    const run = () =>
      loadConfig({
        ...valid,
        SESSION_SECRET: "too-short-secret",
        SOLANA_CLUSTER: "mainnet-beta",
        AUTH_DOMAIN: "",
      });
    expect(run).toThrow(/SESSION_SECRET: must be at least 32 characters/);
    expect(run).toThrow(/SOLANA_CLUSTER: only devnet is supported/);
    expect(run).toThrow(/AUTH_DOMAIN/);
    expect(run).not.toThrow(/too-short-secret|do-not-print/);
  });

  it("requires the database URL and secret", () => {
    expect(() => loadConfig({ AUTH_DOMAIN: "localhost", SOLANA_CLUSTER: "devnet" })).toThrow(
      /DATABASE_URL[\s\S]*SESSION_SECRET/,
    );
  });

  it("refuses a localhost sign-in domain in production", () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: "production" })).toThrow(/public domain/);
  });
});
