import { createHash, randomBytes, randomUUID } from "node:crypto";
import { merkleRoot } from "@worthybound/shared";
import type { Storage } from "@worthybound/storage";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Clock,
  createTestDatabase,
  createTestStorage,
  signIn,
  TEST_DATABASE_URL,
  TEST_STORAGE_AVAILABLE,
  testApp,
  testClock,
  TestWallet,
  type TestDatabase,
} from "./helpers.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A JPEG carrying camera, owner and GPS metadata, like a phone photo. */
const phonePhoto = (colour = "#336699") =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: colour } })
    .jpeg()
    .withExif({
      IFD0: { Make: "SECRETCAM", Artist: "SECRET-OWNER" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "46/1 12/1 0/1" },
    })
    .toBuffer();

const pdf = (text: string = randomUUID()) => Buffer.from(`%PDF-1.7\n% ${text}\n%%EOF\n`);

/** Minimal ISO media file headers, enough for type detection. */
const mediaFile = (brand: "mp42" | "qt  ") =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from(`ftyp${brand}`),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from(`${brand}isom`),
    randomBytes(64),
  ]);

interface Owner {
  wallet: TestWallet;
  token: string;
}

describe.skipIf(!TEST_DATABASE_URL || !TEST_STORAGE_AVAILABLE)("evidence vault", () => {
  let db: TestDatabase;
  let storage: Storage;
  let app: FastifyInstance;
  let clock: Clock;

  beforeAll(async () => {
    db = await createTestDatabase();
    storage = await createTestStorage();
    clock = testClock();
    app = await testApp(db.prisma, { storage, now: clock.now });
  });

  afterAll(async () => {
    await app?.close();
    await storage?.deleteBucket();
    await db?.drop();
  });

  const owner = async (): Promise<Owner> => {
    const wallet = new TestWallet();
    return { wallet, token: await signIn(app, wallet) };
  };

  const call = (who: Owner | null, method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      cookies: who ? { wb_session: who.token } : {},
    });

  const asset = async (who: Owner, publish = false) => {
    const res = await call(who, "POST", "/assets", {
      category: "LUXURY_WATCH",
      brand: "Rolex",
      model: "Submariner",
    });
    const { wbId } = res.json<{ wbId: string }>();
    if (publish) await call(who, "POST", `/assets/${wbId}/publish`);
    return wbId;
  };

  interface FileSpec {
    body: Buffer;
    type?: string;
    mimeType?: string;
    visibility?: "PRIVATE" | "PUBLIC";
    /** Declared hash, if different from the real one. */
    sha256?: string;
    originalFilename?: string;
  }

  const meta = (file: FileSpec) => ({
    type: file.type ?? "PHOTO",
    mimeType: file.mimeType ?? "image/jpeg",
    sizeBytes: file.body.length,
    sha256: file.sha256 ?? sha256(file.body),
    ...(file.visibility ? { visibility: file.visibility } : {}),
    ...(file.originalFilename ? { originalFilename: file.originalFilename } : {}),
  });

  const requestUpload = (who: Owner, wbId: string, file: FileSpec) =>
    call(who, "POST", `/assets/${wbId}/evidence/uploads`, meta(file));

  /** Sends the file the way a browser does, using the returned upload. */
  const sendFile = async (
    upload: { url: string; method: string; headers: Record<string, string> },
    body: Buffer,
    contentType: string,
  ) => {
    expect(upload.headers["Content-Type"]).toBe(contentType);
    const res = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: new Uint8Array(body),
    });
    expect(res.status, await res.text()).toBeLessThan(300);
  };

  const complete = (who: Owner, uploadId: string) =>
    call(who, "POST", `/evidence/uploads/${uploadId}/complete`);

  /** Request, send and complete. Returns the completion response. */
  const upload = async (who: Owner, wbId: string, file: FileSpec) => {
    const req = await requestUpload(who, wbId, file);
    expect(req.statusCode, req.body).toBe(201);
    const { uploadId, upload: form } = req.json();
    await sendFile(form, file.body, file.mimeType ?? "image/jpeg");
    return { uploadId, res: await complete(who, uploadId) };
  };

  const added = async (who: Owner, wbId: string, file: FileSpec) => {
    const { res } = await upload(who, wbId, file);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; sha256: string; publicPath: string | null }>();
  };

  const assetId = async (wbId: string) =>
    (await db.prisma.asset.findUniqueOrThrow({ where: { wbId } })).id;

  describe("uploading", () => {
    it("stores a checked file as private evidence, records it and seals it", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const body = pdf();
      const req = await requestUpload(alice, wbId, {
        body,
        type: "RECEIPT",
        mimeType: "application/pdf",
        originalFilename: "receipt.pdf",
      });
      expect(req.statusCode).toBe(201);
      const { uploadId, upload: form, expiresAt } = req.json();
      expect(new Date(expiresAt).getTime() - clock.now().getTime()).toBeLessThanOrEqual(900_000);
      await sendFile(form, body, "application/pdf");

      const res = await complete(alice, uploadId);
      expect(res.statusCode, res.body).toBe(201);
      const evidence = res.json();
      expect(evidence).toMatchObject({
        type: "RECEIPT",
        mimeType: "application/pdf",
        sizeBytes: body.length,
        sha256: sha256(body),
        visibility: "PRIVATE",
        reviewStatus: "PENDING",
        originalFilename: "receipt.pdf",
        publicPath: null,
      });
      expect(res.body).not.toMatch(/evidence\/|staging\/|storageKey/);

      const row = await db.prisma.evidence.findUniqueOrThrow({ where: { id: evidence.id } });
      expect(row).toMatchObject({ uploaderId: expect.any(String), source: "OWNER" });
      expect(await storage.head(row.storageKey)).toMatchObject({ sizeBytes: body.length });
      expect(await storage.list("staging/")).not.toContain(`staging/${uploadId}`);

      const id = await assetId(wbId);
      const event = await db.prisma.provenanceEvent.findFirstOrThrow({
        where: { assetId: id, type: "EVIDENCE_ADDED" },
      });
      expect(event.payload).toEqual({
        evidenceId: evidence.id,
        type: "RECEIPT",
        sha256: sha256(body),
        source: "OWNER",
      });
      const [commitment] = await db.prisma.evidenceCommitment.findMany({
        where: { assetId: id },
        include: { items: true },
      });
      expect(commitment).toMatchObject({
        merkleRoot: await merkleRoot([sha256(body)]),
        algorithm: "sha256-merkle-v1",
        evidenceCount: 1,
      });
      expect(commitment?.items).toMatchObject([{ leafIndex: 0, evidenceId: evidence.id }]);
    });

    it("returns the same evidence when completion is retried", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const { uploadId, res } = await upload(alice, wbId, {
        body: pdf(),
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const retry = await complete(alice, uploadId);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().id).toBe(res.json().id);
      expect(await db.prisma.evidence.count({ where: { assetId: await assetId(wbId) } })).toBe(1);
    });

    it("creates one evidence item for simultaneous completions", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const body = pdf();
      const req = await requestUpload(alice, wbId, {
        body,
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const { uploadId, upload: form } = req.json();
      await sendFile(form, body, "application/pdf");
      const results = await Promise.all(Array.from({ length: 4 }, () => complete(alice, uploadId)));
      const ok = results.filter((r) => r.statusCode === 200 || r.statusCode === 201);
      expect(ok.length).toBeGreaterThan(0);
      expect(new Set(ok.map((r) => r.json().id)).size).toBe(1);
      expect(results.every((r) => [200, 201, 409].includes(r.statusCode))).toBe(true);
      expect(await db.prisma.evidence.count({ where: { assetId: await assetId(wbId) } })).toBe(1);
      expect(await storage.list(`evidence/${await assetId(wbId)}/`)).toHaveLength(1);
    });

    it("accepts videos and the new evidence types", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      await added(alice, wbId, { body: mediaFile("mp42"), type: "VIDEO", mimeType: "video/mp4" });
      await added(alice, wbId, {
        body: mediaFile("qt  "),
        type: "VIDEO",
        mimeType: "video/quicktime",
      });
      for (const type of ["SERVICE_RECORD", "OWNERSHIP_DOCUMENT", "MANUFACTURER_DOCUMENT"]) {
        await added(alice, wbId, { body: pdf(), type, mimeType: "application/pdf" });
      }
    });

    it.each([
      ["a PDF declared as a photo", () => pdf(), "image/jpeg", "file_type_mismatch"],
      [
        "a QuickTime file declared as MP4",
        () => mediaFile("qt  "),
        "video/mp4",
        "file_type_mismatch",
      ],
      [
        "an HTML page declared as a PDF",
        () => Buffer.from("<html><script>x</script></html>"),
        "application/pdf",
        "file_type_mismatch",
      ],
    ])("rejects %s and keeps nothing", async (_name, make, mimeType, code) => {
      const alice = await owner();
      const wbId = await asset(alice);
      const { uploadId, res } = await upload(alice, wbId, {
        body: make(),
        type: mimeType.startsWith("video") ? "VIDEO" : "PHOTO",
        mimeType,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe(code);
      expect(
        await db.prisma.evidenceUpload.findUniqueOrThrow({ where: { id: uploadId } }),
      ).toMatchObject({
        status: "FAILED",
        failureReason: code,
      });
      expect(await db.prisma.evidence.count({ where: { assetId: await assetId(wbId) } })).toBe(0);
      expect(await storage.list(`evidence/${await assetId(wbId)}/`)).toEqual([]);
      expect((await complete(alice, uploadId)).statusCode).toBe(422);
    });

    it("rejects a file whose hash differs from the declared hash", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const body = pdf();
      const { res } = await upload(alice, wbId, {
        body,
        type: "RECEIPT",
        mimeType: "application/pdf",
        sha256: sha256(Buffer.from("something else")),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("hash_mismatch");
    });

    it("waits for a file that has not been uploaded yet", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const body = pdf();
      const req = await requestUpload(alice, wbId, {
        body,
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const { uploadId, upload: form } = req.json();
      const early = await complete(alice, uploadId);
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe("upload_missing");
      await sendFile(form, body, "application/pdf");
      expect((await complete(alice, uploadId)).statusCode).toBe(201);
    });

    it("expires uploads after 15 minutes", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const body = pdf();
      const req = await requestUpload(alice, wbId, {
        body,
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const { uploadId, upload: form } = req.json();
      await sendFile(form, body, "application/pdf");
      clock.advance(16 * 60_000);
      const res = await complete(alice, uploadId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("upload_expired");
      expect(await storage.head(`staging/${uploadId}`)).toBeNull();
    });

    it("rejects the same file twice on one asset", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const body = pdf();
      const file = { body, type: "RECEIPT", mimeType: "application/pdf" };
      const first = await requestUpload(alice, wbId, file);
      const second = await requestUpload(alice, wbId, file);
      await sendFile(first.json().upload, body, "application/pdf");
      await sendFile(second.json().upload, body, "application/pdf");
      expect((await complete(alice, first.json().uploadId)).statusCode).toBe(201);
      const dup = await complete(alice, second.json().uploadId);
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe("duplicate_evidence");
      const again = await requestUpload(alice, wbId, file);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe("duplicate_evidence");
    });

    it("accepts the same file on someone else's asset but flags it for admins only", async () => {
      const [alice, mallory] = [await owner(), await owner()];
      const body = await phonePhoto("#aa0000");
      const original = await added(alice, await asset(alice), { body });
      const wbId = await asset(mallory);
      const copy = await added(mallory, wbId, { body });
      expect(JSON.stringify(copy)).not.toMatch(/duplicate/i);
      expect(await db.prisma.evidence.findUniqueOrThrow({ where: { id: copy.id } })).toMatchObject({
        duplicateOfId: original.id,
      });
      const flag = await db.prisma.auditLog.findFirstOrThrow({
        where: { action: "evidence.duplicate_flagged", targetId: wbId },
      });
      expect(flag.metadata).toMatchObject({
        evidenceId: copy.id,
        duplicateOfEvidenceId: original.id,
      });
    });

    it("makes a new seal each time evidence is added", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const files = [pdf(), pdf(), pdf()];
      for (const body of files)
        await added(alice, wbId, { body, type: "RECEIPT", mimeType: "application/pdf" });
      const commitments = await db.prisma.evidenceCommitment.findMany({
        where: { assetId: await assetId(wbId) },
        orderBy: { createdAt: "asc" },
      });
      expect(commitments.map((c) => c.evidenceCount)).toEqual([1, 2, 3]);
      expect(commitments.at(-1)?.merkleRoot).toBe(await merkleRoot(files.map(sha256)));
    });

    it("limits each asset to 100 files, counting pending uploads", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      for (let i = 0; i < 100; i++) {
        const res = await requestUpload(alice, wbId, {
          body: pdf(`${i}`),
          type: "RECEIPT",
          mimeType: "application/pdf",
        });
        expect(res.statusCode).toBe(201);
      }
      const res = await requestUpload(alice, wbId, {
        body: pdf(),
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("evidence_limit_reached");
    });

    it("rejects requests the validation rules forbid", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const tooBig = {
        type: "PHOTO",
        mimeType: "image/jpeg",
        sizeBytes: 26 * 1024 * 1024,
        sha256: "a".repeat(64),
      };
      expect(
        (await call(alice, "POST", `/assets/${wbId}/evidence/uploads`, tooBig)).statusCode,
      ).toBe(400);
      const publicReceipt = { ...tooBig, sizeBytes: 10, type: "RECEIPT", visibility: "PUBLIC" };
      expect(
        (await call(alice, "POST", `/assets/${wbId}/evidence/uploads`, publicReceipt)).statusCode,
      ).toBe(400);
      const withKey = { ...tooBig, sizeBytes: 10, storageKey: "evidence/x" };
      expect(
        (await call(alice, "POST", `/assets/${wbId}/evidence/uploads`, withKey)).statusCode,
      ).toBe(400);
    });
  });

  describe("access", () => {
    it("hides other people's evidence exactly like evidence that does not exist", async () => {
      const [alice, mallory] = [await owner(), await owner()];
      const wbId = await asset(alice);
      const body = pdf();
      const req = await requestUpload(alice, wbId, {
        body,
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const { uploadId, upload: form } = req.json();
      await sendFile(form, body, "application/pdf");

      const theirs = await complete(mallory, uploadId);
      const missing = await complete(mallory, randomUUID());
      expect(theirs.statusCode).toBe(404);
      expect(theirs.body).toBe(missing.body);

      const evidence = (await complete(alice, uploadId)).json();
      const pairs: [string, string, object?][] = [
        [
          `/assets/${wbId}/evidence/uploads`,
          "/assets/WB-00000000/evidence/uploads",
          { type: "RECEIPT", mimeType: "application/pdf", sizeBytes: 10, sha256: "b".repeat(64) },
        ],
        [
          `/assets/${wbId}/evidence/${evidence.id}/download`,
          `/assets/${wbId}/evidence/${randomUUID()}/download`,
        ],
        [
          `/assets/${wbId}/evidence/${evidence.id}/visibility`,
          `/assets/WB-00000000/evidence/${evidence.id}/visibility`,
          { visibility: "PRIVATE" },
        ],
      ];
      for (const [url, missingUrl, payload] of pairs) {
        const a = await call(mallory, "POST", url, payload);
        const b = await call(mallory, "POST", missingUrl, payload);
        expect(a.statusCode, url).toBe(404);
        expect(a.json().error.code).toBe(b.json().error.code);
      }
      expect((await call(mallory, "GET", `/assets/${wbId}/evidence`)).statusCode).toBe(404);
      expect((await call(null, "GET", `/assets/${wbId}/evidence`)).statusCode).toBe(401);
    });

    it("lists the owner's evidence without storage keys", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      await added(alice, wbId, { body: pdf(), type: "RECEIPT", mimeType: "application/pdf" });
      await added(alice, wbId, { body: await phonePhoto("#00aa00") });
      const res = await call(alice, "GET", `/assets/${wbId}/evidence`);
      expect(res.json().items.map((e: { type: string }) => e.type)).toEqual(["RECEIPT", "PHOTO"]);
      expect(res.body).not.toMatch(/evidence\/|public\/|staging\/|storageKey|duplicate/);
    });

    it("does not accept evidence for a discarded draft", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      await call(alice, "POST", `/assets/${wbId}/status`, { toStatus: "REVOKED" });
      const res = await requestUpload(alice, wbId, {
        body: pdf(),
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      expect(res.statusCode).toBe(404);
    });

    it("gives the owner a 5-minute link that downloads the file", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const body = pdf();
      const evidence = await added(alice, wbId, {
        body,
        type: "RECEIPT",
        mimeType: "application/pdf",
        originalFilename: "receipt.pdf",
      });
      const res = await call(alice, "POST", `/assets/${wbId}/evidence/${evidence.id}/download`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const { url, expiresAt } = res.json();
      expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
      const file = await fetch(url);
      expect(file.headers.get("content-disposition")).toMatch(
        /^attachment; filename="receipt.pdf"/,
      );
      expect(Buffer.from(await file.arrayBuffer())).toEqual(body);
      expect(
        await db.prisma.auditLog.count({
          where: { action: "evidence.downloaded", targetId: wbId },
        }),
      ).toBe(1);
    });
  });

  describe("public photos", () => {
    it("serves a copy without location or camera data on the published passport", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const body = await phonePhoto();
      expect(body.includes("SECRETCAM")).toBe(true);
      const evidence = await added(alice, wbId, { body, visibility: "PUBLIC" });
      expect(evidence.publicPath).toBe(`/passport/${wbId}/evidence/${evidence.id}`);

      // Not visible while the asset is a draft.
      expect((await call(null, "GET", evidence.publicPath as string)).statusCode).toBe(404);
      await call(alice, "POST", `/assets/${wbId}/publish`);

      const passport = (await call(null, "GET", `/passport/${wbId}`)).json().passport;
      expect(passport.publicEvidence).toEqual([
        expect.objectContaining({
          evidenceId: evidence.id,
          sha256: sha256(body),
          path: evidence.publicPath,
        }),
      ]);
      expect(passport.evidenceCommitments).toHaveLength(1);

      const photo = await call(null, "GET", evidence.publicPath as string);
      expect(photo.statusCode).toBe(200);
      expect(photo.headers["content-type"]).toBe("image/jpeg");
      expect(photo.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(photo.headers["x-content-type-options"]).toBe("nosniff");
      const served = photo.rawPayload;
      expect(served.includes("SECRETCAM")).toBe(false);
      expect(served.includes("SECRET-OWNER")).toBe(false);
      const metadata = await sharp(served).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata).toMatchObject({ width: 64, height: 48, format: "jpeg" });

      // The original stays intact and private.
      const row = await db.prisma.evidence.findUniqueOrThrow({ where: { id: evidence.id } });
      const passportBody = (await call(null, "GET", `/passport/${wbId}`)).body;
      expect(passportBody).not.toContain(row.storageKey);
      expect(passportBody).not.toContain(row.publicStorageKey as string);
      expect(passportBody).not.toContain(storage.bucket);
      const original = await fetch(
        (await call(alice, "POST", `/assets/${wbId}/evidence/${evidence.id}/download`)).json().url,
      );
      expect(sha256(Buffer.from(await original.arrayBuffer()))).toBe(row.sha256);
    });

    it("lets the owner hide a public photo and show it again, recording both", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const evidence = await added(alice, wbId, {
        body: await phonePhoto("#123456"),
        visibility: "PUBLIC",
      });
      const firstKey = (await db.prisma.evidence.findUniqueOrThrow({ where: { id: evidence.id } }))
        .publicStorageKey as string;

      const hide = await call(alice, "POST", `/assets/${wbId}/evidence/${evidence.id}/visibility`, {
        visibility: "PRIVATE",
      });
      expect(hide.statusCode).toBe(200);
      expect(hide.json()).toMatchObject({ visibility: "PRIVATE", publicPath: null });
      expect((await call(null, "GET", evidence.publicPath as string)).statusCode).toBe(404);
      expect(await storage.head(firstKey)).toBeNull();
      expect((await call(null, "GET", `/passport/${wbId}`)).json().passport.publicEvidence).toEqual(
        [],
      );

      const show = await call(alice, "POST", `/assets/${wbId}/evidence/${evidence.id}/visibility`, {
        visibility: "PUBLIC",
      });
      expect(show.statusCode).toBe(200);
      expect((await call(null, "GET", evidence.publicPath as string)).statusCode).toBe(200);

      const events = await db.prisma.provenanceEvent.findMany({
        where: { assetId: await assetId(wbId), type: "EVIDENCE_VISIBILITY_CHANGED" },
        orderBy: { sequence: "asc" },
      });
      expect(events.map((e) => (e.payload as { visibility: string }).visibility)).toEqual([
        "PRIVATE",
        "PUBLIC",
      ]);
      const [row] = await db.prisma.$queryRaw<{ broken: number | null }[]>`
        SELECT wb_verify_provenance_chain(${await assetId(wbId)}::uuid) AS broken`;
      expect(row?.broken).toBeNull();
    });

    it("refuses to make documents public", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const evidence = await added(alice, wbId, {
        body: pdf(),
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const res = await call(alice, "POST", `/assets/${wbId}/evidence/${evidence.id}/visibility`, {
        visibility: "PUBLIC",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("cannot_be_public");
    });

    it("answers private photos, unknown IDs and wrong assets the same way", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const other = await asset(alice, true);
      const priv = await added(alice, wbId, { body: await phonePhoto("#654321") });
      const pub = await added(alice, wbId, {
        body: await phonePhoto("#abcdef"),
        visibility: "PUBLIC",
      });
      const responses = await Promise.all([
        call(null, "GET", `/passport/${wbId}/evidence/${priv.id}`),
        call(null, "GET", `/passport/${wbId}/evidence/${randomUUID()}`),
        call(null, "GET", `/passport/${other}/evidence/${pub.id}`),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([404, 404, 404]);
      expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL || !TEST_STORAGE_AVAILABLE)("evidence rate limits", () => {
  let db: TestDatabase;
  let storage: Storage;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    storage = await createTestStorage();
    app = await testApp(db.prisma, {
      storage,
      rateLimits: { upload: { max: 2, timeWindowMs: 60_000 } },
    });
  });

  afterAll(async () => {
    await app?.close();
    await storage?.deleteBucket();
    await db?.drop();
  });

  it("limits upload requests per user", async () => {
    const token = await signIn(app, new TestWallet());
    const cookies = { wb_session: token };
    const res = await app.inject({
      method: "POST",
      url: "/assets",
      payload: { category: "OTHER" },
      cookies,
    });
    const { wbId } = res.json();
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/assets/${wbId}/evidence/uploads`,
        payload: {
          type: "RECEIPT",
          mimeType: "application/pdf",
          sizeBytes: 10,
          sha256: sha256(Buffer.from(`${i}`)),
        },
        cookies,
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([201, 201, 429]);
  });
});
