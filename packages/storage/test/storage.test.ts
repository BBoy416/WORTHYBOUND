import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorage, type Storage } from "../src/index.js";

const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;

if (!S3_ENDPOINT && process.env.CI) throw new Error("S3_ENDPOINT must be set in CI");

async function readAll(storage: Storage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.read(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Uploads like a browser would: a multipart form with the signed fields, then the file. */
async function postForm(
  upload: { url: string; fields: Record<string, string> },
  body: Buffer,
  contentType: string,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append("file", new Blob([new Uint8Array(body)], { type: contentType }));
  return fetch(upload.url, { method: "POST", body: form });
}

describe.skipIf(!S3_ENDPOINT)("storage", () => {
  let storage: Storage;

  beforeAll(async () => {
    storage = createStorage({
      endpoint: S3_ENDPOINT as string,
      region: S3_REGION ?? "us-east-1",
      accessKeyId: S3_ACCESS_KEY_ID as string,
      secretAccessKey: S3_SECRET_ACCESS_KEY as string,
      bucket: `wb-test-${randomBytes(6).toString("hex")}`,
    });
    await storage.setup({ stagingPrefix: "staging/", corsOrigins: ["http://localhost:3000"] });
  });

  afterAll(async () => {
    await storage?.deleteBucket();
    storage?.destroy();
  });

  it("creates the bucket once and can be run again", async () => {
    const again = await storage.setup({
      stagingPrefix: "staging/",
      corsOrigins: ["http://localhost:3000"],
    });
    expect(again).toMatchObject({ bucketCreated: false, anonymousReadDenied: true });
  });

  it("accepts a browser upload of exactly the signed size and type", async () => {
    const body = randomBytes(1000);
    const upload = await storage.presignUpload({
      key: "staging/ok",
      contentType: "image/jpeg",
      sizeBytes: body.length,
      expiresInSeconds: 60,
    });
    expect(upload.url).not.toContain("staging/ok");
    const res = await postForm(upload, body, "image/jpeg");
    expect(res.status).toBeLessThan(300);
    expect(await storage.head("staging/ok")).toMatchObject({ sizeBytes: 1000 });
    expect(await readAll(storage, "staging/ok")).toEqual(body);
  });

  it.each([
    ["a larger file", 1001, "image/jpeg", "staging/big"],
    ["a smaller file", 999, "image/jpeg", "staging/small"],
    ["another content type", 1000, "text/html", "staging/html"],
  ])("rejects %s", async (_name, size, contentType, key) => {
    const upload = await storage.presignUpload({
      key,
      contentType: "image/jpeg",
      sizeBytes: 1000,
      expiresInSeconds: 60,
    });
    const fields = { ...upload.fields, "Content-Type": contentType };
    const res = await postForm({ ...upload, fields }, randomBytes(size), contentType);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await storage.head(key)).toBeNull();
  });

  it("does not let the form choose another key", async () => {
    const upload = await storage.presignUpload({
      key: "staging/mine",
      contentType: "image/jpeg",
      sizeBytes: 10,
      expiresInSeconds: 60,
    });
    const res = await postForm(
      { ...upload, fields: { ...upload.fields, key: "evidence/elsewhere" } },
      randomBytes(10),
      "image/jpeg",
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await storage.head("evidence/elsewhere")).toBeNull();
  });

  it("copies, lists and removes objects", async () => {
    await storage.put("staging/a", Buffer.from("hello"), "application/pdf");
    const info = await storage.head("staging/a");
    await storage.copy("staging/a", "evidence/a", info?.etag ?? undefined);
    await storage.remove("staging/a");
    expect(await storage.head("staging/a")).toBeNull();
    expect((await readAll(storage, "evidence/a")).toString()).toBe("hello");
    expect(await storage.list("evidence/")).toEqual(["evidence/a"]);
  });

  it("refuses a copy when the source changed", async () => {
    await storage.put("staging/b", Buffer.from("one"), "application/pdf");
    const info = await storage.head("staging/b");
    await storage.put("staging/b", Buffer.from("two"), "application/pdf");
    await expect(
      storage.copy("staging/b", "evidence/b", info?.etag ?? undefined),
    ).rejects.toThrow();
    expect(await storage.head("evidence/b")).toBeNull();
  });

  it("signs short-lived downloads that save the file instead of opening it", async () => {
    await storage.put("evidence/doc", Buffer.from("%PDF-1.7"), "application/pdf");
    const { url, expiresAt } = await storage.presignDownload({
      key: "evidence/doc",
      filename: 'receipt "copy".pdf',
      contentType: "application/pdf",
      expiresInSeconds: 300,
    });
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="receipt _copy_.pdf"/,
    );
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("does not serve objects without a signature", async () => {
    await storage.put("evidence/private", Buffer.from("secret"), "application/pdf");
    const res = await fetch(`${S3_ENDPOINT}/${storage.bucket}/evidence/private`);
    expect(res.status).toBe(403);
  });

  it("reports a missing object as null", async () => {
    expect(await storage.head("evidence/missing")).toBeNull();
  });
});
