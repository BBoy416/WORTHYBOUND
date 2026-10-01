import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@worthybound/database";
import type { Storage } from "@worthybound/storage";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, storageOrigin } from "../src/app.js";
import { testConfig } from "./helpers.js";

const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("web app on the API origin", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "wb-web-"));
    await mkdir(join(dir, "static"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>WorthyBound</title>");
    await writeFile(join(dir, "static", "index-abc123.js"), "console.log(1)");
    await writeFile(join(dir, "static", "logo-hero-abc123.webp"), "webp");
    for (const file of ["favicon.png", "apple-touch-icon.png", "og-image.png"]) {
      await writeFile(join(dir, file), "png");
    }
    await writeFile(join(dir, "secret.env"), "x");
    // The routes checked here never reach the database or storage.
    app = await buildApp({
      config: testConfig({
        WEB_DIST_DIR: dir,
        S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      }),
      prisma: {} as PrismaClient,
      storage: {} as Storage,
    });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the app for page loads, including passport links from QR codes", async () => {
    for (const url of [
      "/",
      "/passport/WB-7F93A281",
      "/assets/WB-7F93A281",
      "/verifier/requests/x?y=1",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: HTML } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain("<title>WorthyBound</title>");
    }
  });

  it("leaves API calls to the API", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/assets",
      headers: { accept: "application/json" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("does not serve the app for token metadata or public photos", async () => {
    const photo = await app.inject({
      method: "GET",
      url: "/passport/WB-7F93A281/evidence/0199a000-0000-7000-8000-000000000001",
      headers: { accept: HTML },
    });
    expect(photo.headers["content-type"]).not.toContain("text/html");
    const metadata = await app.inject({
      method: "GET",
      url: "/metadata/bad",
      headers: { accept: HTML },
    });
    expect(metadata.headers["content-type"]).not.toContain("text/html");
  });

  it("serves hashed bundles with a long cache, and nothing outside the build", async () => {
    const js = await app.inject({ method: "GET", url: "/static/index-abc123.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const image = await app.inject({ method: "GET", url: "/static/logo-hero-abc123.webp" });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/webp");
    for (const url of ["/favicon.png", "/apple-touch-icon.png", "/og-image.png"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toBe("image/png");
    }
    expect((await app.inject({ method: "GET", url: "/favicon.svg" })).statusCode).toBe(404);
    for (const url of [
      "/static/missing.js",
      "/static/..%2Fsecret.env",
      "/static/..%2F..%2Fpackage.json",
      "/static/.hidden.js",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });

  it("lets the page upload to storage and nowhere else", async () => {
    const res = await app.inject({ method: "GET", url: "/", headers: { accept: HTML } });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("connect-src 'self' https://acct.r2.cloudflarestorage.com");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});

describe("storageOrigin", () => {
  it("is the endpoint origin with a custom endpoint (path-style URLs)", () => {
    expect(storageOrigin(testConfig({ S3_ENDPOINT: "http://127.0.0.1:9000/" }))).toBe(
      "http://127.0.0.1:9000",
    );
  });
  it("is the bucket's virtual host on AWS", () => {
    expect(storageOrigin(testConfig({ S3_REGION: "eu-west-1" }))).toBe(
      "https://worthybound-evidence-private.s3.eu-west-1.amazonaws.com",
    );
  });
});
