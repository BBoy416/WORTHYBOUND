import { createHash, randomBytes, randomUUID } from "node:crypto";
import { merkleRoot } from "@worthybound/shared";
import type { Storage } from "@worthybound/storage";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { CheckEngineError } from "@worthybound/automated-checks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { grantAdmin } from "../src/cli/admin-grant.js";
import { recordKyc } from "../src/cli/kyc-record.js";
import { readAll } from "../src/evidence/inspect.js";
import {
  type Clock,
  createTestDatabase,
  createTestStorage,
  fakeCheckEngine,
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

/** A detailed JPEG (a pattern of waves); plain photos are too simple to fingerprint. */
const texturedPhoto = (seed: number, size = 256) => {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v =
        128 + 120 * Math.sin(x / (20 + seed * 9) + seed) * Math.cos(y / (17 + seed * 5) + seed * 2);
      raw.fill(Math.round(v), (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .jpeg()
    .toBuffer();
};

/** Minimal ISO media file headers, enough for type detection. */
/** A JPEG of random grey blocks, so its fingerprint differs from every other photo. */
const blockPhoto = () =>
  sharp(randomBytes(16 * 16), { raw: { width: 16, height: 16, channels: 1 } })
    .resize(256, 256, { kernel: "nearest" })
    .jpeg()
    .toBuffer();

const mediaFile = (brand: "mp42" | "qt  ") =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from(`ftyp${brand}`),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from(`${brand}isom`),
    randomBytes(64),
  ]);

const box = (type: string, ...contents: Buffer[]) => {
  const body = Buffer.concat(contents);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
};

/** A small MP4 whose user data holds a GPS location, as phones record it. */
const videoWithLocation = () =>
  Buffer.concat([
    box("ftyp", Buffer.from("mp42\0\0\0\0mp42isom")),
    box(
      "moov",
      box("mvhd", Buffer.alloc(100)),
      box(
        "trak",
        box("tkhd", Buffer.alloc(84)),
        box("udta", box("©xyz", Buffer.from("+46.2044+006.1432/"))),
      ),
      box("udta", box("©xyz", Buffer.from("+46.2044+006.1432/"))),
      box("meta", Buffer.from("com.apple.quicktime.location.ISO6709")),
    ),
    box("mdat", randomBytes(256)),
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
  const engine = fakeCheckEngine();

  beforeAll(async () => {
    db = await createTestDatabase();
    storage = await createTestStorage();
    clock = testClock();
    app = await testApp(db.prisma, { storage, now: clock.now, checkEngine: engine });
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

  const call = (who: Owner | null, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
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
    captureSessionId?: string;
    captureShot?: string;
  }

  const meta = (file: FileSpec) => ({
    type: file.type ?? "PHOTO",
    mimeType: file.mimeType ?? "image/jpeg",
    sizeBytes: file.body.length,
    sha256: file.sha256 ?? sha256(file.body),
    ...(file.visibility ? { visibility: file.visibility } : {}),
    ...(file.originalFilename ? { originalFilename: file.originalFilename } : {}),
    ...(file.captureSessionId
      ? { captureSessionId: file.captureSessionId, captureShot: file.captureShot }
      : {}),
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

    it("shows the owner a small preview of an image without its metadata", async () => {
      const [alice, mallory] = [await owner(), await owner()];
      const wbId = await asset(alice);
      const body = await sharp({
        create: { width: 1200, height: 800, channels: 3, background: "#224466" },
      })
        .jpeg()
        .withExif({ IFD0: { Make: "SECRETCAM", Artist: "SECRET-OWNER" } })
        .toBuffer();
      const evidence = await added(alice, wbId, { body });
      const url = `/assets/${wbId}/evidence/${evidence.id}/preview`;

      const res = await call(alice, "GET", url);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/webp");
      expect(res.headers["cache-control"]).toBe("private, max-age=3600");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(res.rawPayload.includes("SECRETCAM")).toBe(false);
      const metadata = await sharp(res.rawPayload).metadata();
      expect([metadata.format, metadata.width, metadata.height, metadata.exif]).toEqual([
        "webp",
        480,
        320,
        undefined,
      ]);

      // Made once, then kept next to the private file.
      const key = `previews/${await assetId(wbId)}/${evidence.id}.webp`;
      expect(await storage.head(key)).not.toBeNull();
      expect((await call(alice, "GET", url)).rawPayload.equals(res.rawPayload)).toBe(true);

      const theirs = await call(mallory, "GET", url);
      const missing = await call(
        mallory,
        "GET",
        `/assets/${wbId}/evidence/${randomUUID()}/preview`,
      );
      expect(theirs.statusCode).toBe(404);
      expect(theirs.json().error.code).toBe(missing.json().error.code);
      expect((await call(null, "GET", url)).statusCode).toBe(401);
    });

    it("has no preview for PDFs", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const evidence = await added(alice, wbId, {
        body: pdf(),
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const res = await call(alice, "GET", `/assets/${wbId}/evidence/${evidence.id}/preview`);
      expect(res.statusCode).toBe(404);
    });

    it("gives each asset in the owner's list a thumbnail, preferring a public photo", async () => {
      const alice = await owner();
      const [withPublic, withPrivate, without] = [
        await asset(alice),
        await asset(alice),
        await asset(alice),
      ];
      await added(alice, withPublic, { body: await phonePhoto("#110000") });
      const shown = await added(alice, withPublic, {
        body: await phonePhoto("#220000"),
        visibility: "PUBLIC",
      });
      const hidden = await added(alice, withPrivate, { body: await phonePhoto("#330000") });
      await added(alice, without, { body: pdf(), type: "RECEIPT", mimeType: "application/pdf" });

      const res = await call(alice, "GET", "/assets");
      expect(res.statusCode).toBe(200);
      const thumbnails = Object.fromEntries(
        res
          .json<{ items: { wbId: string; thumbnailPath: string | null }[] }>()
          .items.map((a) => [a.wbId, a.thumbnailPath]),
      );
      expect(thumbnails).toEqual({
        [withPublic]: `/assets/${withPublic}/evidence/${shown.id}/preview`,
        [withPrivate]: `/assets/${withPrivate}/evidence/${hidden.id}/preview`,
        [without]: null,
      });
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

    it("stops showing and counting a photo once a dispute about it is upheld (ADR 0017)", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const priv = await added(alice, wbId, { body: await phonePhoto("#a1b2c3") });
      const pub = await added(alice, wbId, {
        body: await phonePhoto("#405060"),
        visibility: "PUBLIC",
      });
      const buyer = await owner();
      const admin = await owner();
      for (const who of [buyer, admin]) {
        await recordKyc(
          db.prisma,
          {
            walletAddress: who.wallet.address,
            provider: "test-kyc",
            reference: randomUUID(),
            status: "VERIFIED",
          },
          clock.now,
        );
      }
      await grantAdmin(db.prisma, admin.wallet.address);
      const dispute = (evidenceId: string) =>
        call(buyer, "POST", "/disputes", {
          assetId: wbId,
          evidenceId,
          reason: "This photo is from a sales listing",
        });
      // Others cannot dispute private evidence they cannot see.
      expect((await dispute(priv.id)).statusCode).toBe(404);
      const opened = await dispute(pub.id);
      expect(opened.statusCode, opened.body).toBe(201);
      const { id } = opened.json<{ id: string }>();
      expect((await call(admin, "POST", `/admin/disputes/${id}/review`, {})).statusCode).toBe(200);
      const decided = await call(admin, "POST", `/admin/disputes/${id}/resolution`, {
        outcome: "UPHELD",
        resolution: "The photo appears on a dealer's website.",
      });
      expect(decided.statusCode, decided.body).toBe(200);
      expect(decided.json()).toMatchObject({ evidence: { type: "PHOTO", visibility: "PUBLIC" } });

      const passport = (await call(null, "GET", `/passport/${wbId}`)).json().passport;
      expect(passport.publicEvidence).toEqual([]);
      expect((await call(null, "GET", pub.publicPath as string)).statusCode).toBe(404);
      const trust = (await call(alice, "GET", `/assets/${wbId}/trust`)).json();
      expect(trust.excludedProofs).toContainEqual({
        proofId: `evidence:${pub.id}`,
        reason: "REJECTED",
      });
    });
  });
  describe("AI checks", () => {
    type Check = { status: string; problems: string[]; checkedAt: string | null } | null;
    const evidenceChecks = async (who: Owner, wbId: string) =>
      Object.fromEntries(
        (await call(who, "GET", `/assets/${wbId}/evidence`))
          .json<{ items: { id: string; automatedCheck: Check }[] }>()
          .items.map((e) => [e.id, e.automatedCheck]),
      );
    const trust = async (who: Owner, wbId: string) =>
      (await call(who, "GET", `/assets/${wbId}/trust`)).json<{
        score: number;
        factors: { code: string; detail?: { source?: string } }[];
        deductions: { code: string; count?: number }[];
        capsApplied: { code: string }[];
      }>();
    const run = () =>
      (app.automatedChecks as NonNullable<FastifyInstance["automatedChecks"]>).runOnce();
    // Uploads in other tests queue checks too; each test counts only its own.
    beforeEach(async () => {
      while ((await run()) > 0);
    });
    const passing = engine.evidence;
    const passportChecks = async (wbId: string) =>
      (await call(null, "GET", `/passport/${wbId}`)).json().passport.automatedChecks;

    it("checks every owner upload, without its metadata", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const photo = await added(alice, wbId, { body: await phonePhoto("#102030") });
      const receipt = await added(alice, wbId, {
        body: pdf(),
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const other = await added(alice, wbId, {
        body: pdf(),
        type: "OTHER",
        mimeType: "application/pdf",
      });
      const pending = { status: "PENDING", problems: [], checkedAt: null };
      expect(await evidenceChecks(alice, wbId)).toEqual({
        [photo.id]: pending,
        [receipt.id]: pending,
        [other.id]: null,
      });
      expect((await call(alice, "GET", `/assets/${wbId}/automated-checks`)).json()).toEqual({
        available: true,
      });
      const before = await trust(alice, wbId);

      engine.evidenceCalls.length = 0;
      expect(await run()).toBe(2);

      const sent = engine.evidenceCalls.find((c) => c.evidence.type === "PHOTO");
      expect(sent?.asset).toMatchObject({ category: "LUXURY_WATCH", brand: "Rolex" });
      expect(sent?.file.mimeType).toBe("image/jpeg");
      const sentPhoto = Buffer.from(sent?.file.data ?? []);
      expect(sentPhoto.includes("SECRETCAM")).toBe(false);
      expect((await sharp(sentPhoto).metadata()).exif).toBeUndefined();
      expect(engine.evidenceCalls.find((c) => c.evidence.type === "RECEIPT")?.file).toMatchObject({
        mimeType: "application/pdf",
      });

      const checks = await evidenceChecks(alice, wbId);
      expect(checks[photo.id]).toMatchObject({ status: "PASSED", problems: [] });
      expect(checks[receipt.id]).toMatchObject({ status: "PASSED" });
      expect(checks[other.id]).toBeNull();
      const after = await trust(alice, wbId);
      expect(after.score).toBeGreaterThan(before.score);
      expect(after.factors.filter((f) => f.detail?.source === "AUTOMATED")).toHaveLength(2);
      const stored = await db.prisma.automatedCheck.findMany({
        where: { assetId: await assetId(wbId) },
      });
      expect(stored.map((c) => [c.engine, c.model, c.checkVersion])).toEqual([
        ["fake", "fake-model-1", "evidence-check-v3"],
        ["fake", "fake-model-1", "evidence-check-v3"],
      ]);
      expect(stored.map((c) => c.sha256).sort()).toEqual([photo.sha256, receipt.sha256].sort());
      const latest = Math.max(...stored.map((c) => c.createdAt.getTime()));
      expect(await passportChecks(wbId)).toEqual({
        filesPassed: 2,
        lastPassedAt: new Date(latest).toISOString(),
      });

      // Later uploads are queued straight away; checked files are not checked again.
      const next = await upload(alice, wbId, { body: await phonePhoto("#203040") });
      expect(next.res.json().automatedCheck).toMatchObject({ status: "PENDING" });
      engine.evidenceCalls.length = 0;
      expect(await run()).toBe(1);
      expect(engine.evidenceCalls).toHaveLength(1);
      expect(await run()).toBe(0);
    });

    it("tells the owner the problem, keeps the details for admins and lowers the score", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      engine.evidence = async () => ({
        result: "FAILED",
        problems: ["SCREEN_OR_PRINT"],
        summary: "Moire pattern across the dial: DETAIL-FOR-ADMINS.",
        confidence: 0.85,
        documentNumber: null,
        model: "fake-model-1",
      });
      try {
        await added(alice, wbId, { body: await phonePhoto("#304050") });
        await run();
      } finally {
        engine.evidence = passing;
      }
      const [check] = Object.values(await evidenceChecks(alice, wbId));
      expect(check).toMatchObject({ status: "FAILED", problems: ["SCREEN_OR_PRINT"] });
      const list = await call(alice, "GET", `/assets/${wbId}/evidence`);
      expect(list.body).not.toContain("DETAIL-FOR-ADMINS");
      const score = await trust(alice, wbId);
      expect(score.deductions).toContainEqual(
        expect.objectContaining({ code: "FAILED_AUTOMATED_CHECKS", count: 1 }),
      );
      expect(score.capsApplied.map((c) => c.code)).not.toContain("AUTOMATED_CHECKS_PASSED");
      const passport = await call(null, "GET", `/passport/${wbId}`);
      expect(passport.json().passport.automatedChecks).toBeNull();
      expect(passport.body).not.toContain("DETAIL-FOR-ADMINS");

      const url = `/admin/assets/${wbId}/automated-checks`;
      expect((await call(alice, "GET", url)).statusCode).toBe(403);
      const admin = await owner();
      await grantAdmin(db.prisma, admin.wallet.address);
      const details = await call(admin, "GET", url);
      expect(details.statusCode, details.body).toBe(200);
      expect(details.json().items).toEqual([
        expect.objectContaining({
          result: "FAILED",
          problems: ["SCREEN_OR_PRINT"],
          summary: expect.stringContaining("DETAIL-FOR-ADMINS"),
          confidence: 0.85,
          engine: "fake",
          wbId,
          evidence: { type: "PHOTO", mimeType: "image/jpeg", reviewStatus: "PENDING" },
        }),
      ]);
      const failed = await call(admin, "GET", "/admin/automated-checks?result=FAILED&limit=100");
      expect(failed.statusCode, failed.body).toBe(200);
      expect(failed.json().items.every((c: { result: string }) => c.result === "FAILED")).toBe(
        true,
      );
      expect(failed.json().items.map((c: { wbId: string }) => c.wbId)).toContain(wbId);
      const first = await call(admin, "GET", "/admin/automated-checks?limit=1");
      const second = await call(
        admin,
        "GET",
        `/admin/automated-checks?limit=1&cursor=${first.json().nextCursor}`,
      );
      expect(second.json().items[0].id).not.toBe(first.json().items[0].id);
      expect((await call(alice, "GET", "/admin/automated-checks")).statusCode).toBe(403);
      expect(
        await db.prisma.auditLog.count({
          where: { action: "evidence.automated_check", targetId: wbId },
        }),
      ).toBe(1);
    });

    it("fails files already attached to another asset without calling the service", async () => {
      const alice = await owner();
      const body = await phonePhoto("#405060");
      await added(alice, await asset(alice, true), { body });
      await run();
      const wbId = await asset(alice, true);
      const copy = await added(alice, wbId, { body });
      engine.evidenceCalls.length = 0;
      await run();
      expect(engine.evidenceCalls).toHaveLength(0);
      expect((await evidenceChecks(alice, wbId))[copy.id]).toMatchObject({
        status: "FAILED",
        problems: ["REUSED_FILE"],
      });
    });

    it("fails near-identical photos on another asset without calling the service", async () => {
      const alice = await owner();
      const original = await texturedPhoto(1);
      await added(alice, await asset(alice, true), { body: original });
      await run();
      clock.advance(1_000);
      const wbId = await asset(alice, true);
      const copy = await added(alice, wbId, {
        body: await sharp(original).resize(200).jpeg({ quality: 70 }).toBuffer(),
      });
      const different = await added(alice, wbId, { body: await texturedPhoto(4) });
      const plain = await added(alice, wbId, { body: await phonePhoto("#445566") });
      const fingerprints = await db.prisma.evidence.findMany({
        where: { id: { in: [copy.id, different.id, plain.id] } },
        select: { id: true, perceptualHash: true },
      });
      expect(fingerprints.find((e) => e.id === plain.id)?.perceptualHash).toBeNull();
      expect(fingerprints.filter((e) => e.perceptualHash !== null)).toHaveLength(2);

      engine.evidenceCalls.length = 0;
      await run();
      expect(engine.evidenceCalls).toHaveLength(2);
      const checks = await evidenceChecks(alice, wbId);
      expect(checks[copy.id]).toMatchObject({ status: "FAILED", problems: ["SIMILAR_PHOTO"] });
      expect(checks[different.id]).toMatchObject({ status: "PASSED" });
      expect(checks[plain.id]).toMatchObject({ status: "PASSED" });
      const stored = await db.prisma.automatedCheck.findFirstOrThrow({
        where: { evidenceId: copy.id },
      });
      expect(stored).toMatchObject({
        engine: "worthybound",
        model: "perceptual-hash-v1",
        confidence: null,
      });
    });

    it("fails receipts written by an image editor and sends other PDF metadata along", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const edited = (text: string) =>
        Buffer.from(
          `%PDF-1.4\n% ${text}\n1 0 obj\n<< /Producer (Adobe Photoshop 25.0) >>\nendobj\n%%EOF\n`,
        );
      const receipt = await added(alice, wbId, {
        body: edited(randomUUID()),
        type: "RECEIPT",
        mimeType: "application/pdf",
      });
      const certificate = await added(alice, wbId, {
        body: edited(randomUUID()),
        type: "CERTIFICATE",
        mimeType: "application/pdf",
      });
      engine.evidenceCalls.length = 0;
      await run();
      expect(engine.evidenceCalls.map((c) => c.evidence.type)).toEqual(["CERTIFICATE"]);
      expect(engine.evidenceCalls[0]?.pdfMetadata).toMatchObject({
        producer: "Adobe Photoshop 25.0",
      });
      const checks = await evidenceChecks(alice, wbId);
      expect(checks[receipt.id]).toMatchObject({
        status: "FAILED",
        problems: ["DOCUMENT_TAMPERING"],
      });
      expect(checks[certificate.id]).toMatchObject({ status: "PASSED" });
      const stored = await db.prisma.automatedCheck.findMany({
        where: { evidenceId: { in: [receipt.id, certificate.id] } },
      });
      expect(stored.find((c) => c.evidenceId === receipt.id)).toMatchObject({
        engine: "worthybound",
        model: "pdf-metadata-v1",
      });
      expect(stored.find((c) => c.evidenceId === certificate.id)?.summary).toContain(
        'PDF metadata: producer "Adobe Photoshop 25.0"',
      );
    });

    it("fails documents whose number is already on another asset", async () => {
      const alice = await owner();
      const first = await asset(alice, true);
      const second = await asset(alice, true);
      const printed = ["INV-2024-0042", "inv 2024 0042"];
      engine.evidence = async () => ({
        ...(await passing({} as never)),
        documentNumber: printed.shift() ?? null,
      });
      try {
        const kept = await added(alice, first, {
          body: pdf(),
          type: "RECEIPT",
          mimeType: "application/pdf",
        });
        await run();
        clock.advance(1_000);
        const reused = await added(alice, second, {
          body: pdf(),
          type: "RECEIPT",
          mimeType: "application/pdf",
        });
        await run();
        expect((await evidenceChecks(alice, first))[kept.id]).toMatchObject({
          status: "PASSED",
        });
        expect((await evidenceChecks(alice, second))[reused.id]).toMatchObject({
          status: "FAILED",
          problems: ["REUSED_DOCUMENT"],
        });
        const hashes = await db.prisma.automatedCheck.findMany({
          where: { evidenceId: { in: [kept.id, reused.id] } },
          select: { documentNumberHash: true, summary: true },
        });
        expect(new Set(hashes.map((h) => h.documentNumberHash)).size).toBe(1);
        expect(hashes.some((h) => h.summary.includes(first))).toBe(true);
        expect(JSON.stringify(hashes)).not.toContain("0042");
      } finally {
        engine.evidence = passing;
      }
    });

    it("retries outages later and gives up on errors that will not go away", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const photo = await added(alice, wbId, { body: await phonePhoto("#506070") });
      engine.evidence = async () => {
        throw new CheckEngineError("service returned 503", true);
      };
      try {
        await run();
        expect((await evidenceChecks(alice, wbId))[photo.id]).toMatchObject({ status: "PENDING" });
        // Not due yet.
        expect(await run()).toBe(0);
        clock.advance(60_000);
        engine.evidence = async () => {
          throw new CheckEngineError("the model refused to answer", false);
        };
        expect(await run()).toBe(1);
      } finally {
        engine.evidence = passing;
      }
      expect((await evidenceChecks(alice, wbId))[photo.id]).toMatchObject({
        status: "UNAVAILABLE",
      });
      const job = await db.prisma.automatedJob.findFirstOrThrow({ where: { entityId: photo.id } });
      expect(job).toMatchObject({ status: "FAILED", attempts: 2 });
    });

    it("does not check files of revoked assets and shows only the owner that checks run", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const photo = await added(alice, wbId, { body: await phonePhoto("#607080") });
      await db.prisma.asset.update({ where: { wbId }, data: { status: "REVOKED" } });
      engine.evidenceCalls.length = 0;
      expect(await run()).toBe(1);
      expect(engine.evidenceCalls).toHaveLength(0);
      expect(await db.prisma.automatedCheck.count({ where: { evidenceId: photo.id } })).toBe(0);

      const bob = await owner();
      expect((await call(bob, "GET", `/assets/${wbId}/automated-checks`)).statusCode).toBe(404);
      expect((await call(null, "GET", `/assets/${wbId}/automated-checks`)).statusCode).toBe(401);
      expect((await call(alice, "PUT", `/assets/${wbId}/automated-checks`, {})).statusCode).toBe(
        404,
      );
    });

    it("tells the check what each capture shot should show, and the code", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const session = (await call(alice, "POST", `/assets/${wbId}/capture-sessions`)).json();
      const shot = (captureShot: string, seed: number) =>
        texturedPhoto(seed).then((body) =>
          added(alice, wbId, { body, captureSessionId: session.id, captureShot }),
        );
      await shot("DIAL", 21);
      await shot("CODE", 22);
      engine.evidenceCalls.length = 0;
      expect(await run()).toBe(2);
      expect(engine.evidenceCalls.map((c) => c.capture)).toEqual([
        { shot: "DIAL", instruction: "The dial, face on", code: null },
        {
          shot: "CODE",
          instruction: "The item next to the code written on paper",
          code: session.code,
        },
      ]);
    });
  });

  describe("guided capture", () => {
    interface Session {
      id: string;
      code: string;
      status: string;
      shots: {
        shot: string;
        instruction: string;
        evidenceId: string | null;
        receivedAt: string | null;
      }[];
      expiresAt: string;
      completedAt: string | null;
    }
    const start = (who: Owner, wbId: string) =>
      call(who, "POST", `/assets/${wbId}/capture-sessions`);
    const sessions = async (who: Owner, wbId: string) =>
      (await call(who, "GET", `/assets/${wbId}/capture-sessions`)).json<{ items: Session[] }>()
        .items;
    let seed = 100;
    const shot = async (who: Owner, wbId: string, session: Session, captureShot: string) =>
      upload(who, wbId, {
        body: await texturedPhoto(seed++),
        captureSessionId: session.id,
        captureShot,
      });

    it("starts a session with a one-time code and the shots for the category", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const res = await start(alice, wbId);
      expect(res.statusCode, res.body).toBe(201);
      const session = res.json<Session>();
      expect(session.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect(session).toMatchObject({ status: "OPEN", completedAt: null });
      expect(session.shots.map((s) => s.shot)).toEqual([
        "DIAL",
        "CASEBACK",
        "CLASP",
        "SERIAL",
        "SIDE",
        "CODE",
      ]);
      expect(new Date(session.expiresAt).getTime() - clock.now().getTime()).toBe(15 * 60_000);

      const again = await start(alice, wbId);
      expect(again.statusCode).toBe(200);
      expect(again.json().id).toBe(session.id);
      expect((await sessions(alice, wbId)).map((s) => s.id)).toEqual([session.id]);

      const bob = await owner();
      expect((await start(bob, wbId)).statusCode).toBe(404);
      expect((await call(bob, "GET", `/assets/${wbId}/capture-sessions`)).statusCode).toBe(404);
      expect((await call(null, "POST", `/assets/${wbId}/capture-sessions`)).statusCode).toBe(401);
    });

    it("records each shot with the server's time and completes the session with the last one", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const session = (await start(alice, wbId)).json<Session>();
      const requestedAt = clock.now().toISOString();

      const first = await shot(alice, wbId, session, "DIAL");
      expect(first.res.statusCode, first.res.body).toBe(201);
      expect(first.res.json()).toMatchObject({ captureShot: "DIAL", capturedAt: requestedAt });
      const again = await requestUpload(alice, wbId, {
        body: await texturedPhoto(seed++),
        captureSessionId: session.id,
        captureShot: "DIAL",
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe("capture_shot_taken");
      const notAsked = await requestUpload(alice, wbId, {
        body: await texturedPhoto(seed++),
        captureSessionId: session.id,
        captureShot: "VIN",
      });
      expect(notAsked.statusCode).toBe(422);
      expect(notAsked.json().error.code).toBe("capture_shot_not_required");
      const otherWbId = await asset(alice);
      const wrongAsset = await requestUpload(alice, otherWbId, {
        body: await texturedPhoto(seed++),
        captureSessionId: session.id,
        captureShot: "CLASP",
      });
      expect(wrongAsset.statusCode).toBe(404);

      for (const name of ["CASEBACK", "CLASP", "SERIAL", "SIDE"]) {
        expect((await shot(alice, wbId, session, name)).res.statusCode).toBe(201);
      }
      expect((await sessions(alice, wbId))[0]?.status).toBe("OPEN");
      clock.advance(60_000);
      expect((await shot(alice, wbId, session, "CODE")).res.statusCode).toBe(201);

      const [done] = await sessions(alice, wbId);
      expect(done).toMatchObject({ status: "COMPLETED", completedAt: clock.now().toISOString() });
      expect(done?.shots.every((s) => s.evidenceId && s.receivedAt)).toBe(true);
      const id = await assetId(wbId);
      expect(
        await db.prisma.provenanceEvent.findMany({
          where: { assetId: id, type: "CAPTURE_COMPLETED" },
          select: { payload: true },
        }),
      ).toEqual([{ payload: { captureSessionId: session.id, shots: 6 } }]);
      const photos = await db.prisma.evidence.findMany({ where: { captureSessionId: session.id } });
      expect(photos.map((e) => e.type)).toEqual(Array(6).fill("PHOTO"));
      expect(new Set(photos.map((e) => e.captureShot)).size).toBe(6);

      // Photos added outside a session are not capture shots.
      const plain = await added(alice, wbId, { body: await phonePhoto("#445566") });
      expect(plain).toMatchObject({ captureShot: null });
      // Completed sessions take no more shots; a new one can be started.
      const late = await requestUpload(alice, wbId, {
        body: await texturedPhoto(seed++),
        captureSessionId: session.id,
        captureShot: "DIAL",
      });
      expect(late.json().error.code).toBe("capture_session_closed");
      expect((await start(alice, wbId)).statusCode).toBe(201);
    });

    it("counts checked photos from a completed session more in the Trust Score", async () => {
      const alice = await owner();
      const wbId = await asset(alice, true);
      const session = (await start(alice, wbId)).json<Session>();
      for (const name of session.shots.map((s) => s.shot)) {
        const { res } = await upload(alice, wbId, {
          body: await blockPhoto(),
          captureSessionId: session.id,
          captureShot: name,
        });
        expect(res.statusCode, res.body).toBe(201);
      }
      const plain = await added(alice, wbId, { body: await phonePhoto("#778899") });
      const checks = app.automatedChecks as NonNullable<FastifyInstance["automatedChecks"]>;
      while ((await checks.runOnce()) > 0);

      const trust = (await call(alice, "GET", `/assets/${wbId}/trust`)).json<{
        factors: { proofId?: string; detail?: { source?: string; capturedMultiplier?: number } }[];
      }>();
      const automated = trust.factors.filter((f) => f.detail?.source === "AUTOMATED");
      const captured = await db.prisma.automatedCheck.findMany({
        where: { evidence: { captureSessionId: session.id }, result: "PASSED" },
        select: { id: true },
      });
      expect(captured).toHaveLength(session.shots.length);
      for (const { id } of captured) {
        expect(automated.find((f) => f.proofId === `check:${id}`)?.detail).toMatchObject({
          capturedMultiplier: 1.5,
        });
      }
      const plainCheck = await db.prisma.automatedCheck.findFirstOrThrow({
        where: { evidenceId: plain.id },
      });
      expect(
        automated.find((f) => f.proofId === `check:${plainCheck.id}`)?.detail?.capturedMultiplier,
      ).toBeUndefined();
    });

    it("refuses shots that arrive after the code expired", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      const session = (await start(alice, wbId)).json<Session>();
      clock.advance(60_000);
      const body = await texturedPhoto(seed++);
      const req = await requestUpload(alice, wbId, {
        body,
        captureSessionId: session.id,
        captureShot: "DIAL",
      });
      expect(req.statusCode, req.body).toBe(201);
      const { uploadId, upload: form } = req.json();
      await sendFile(form, body, "image/jpeg");
      clock.advance(14 * 60_000 + 1);

      const res = await complete(alice, uploadId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("capture_session_closed");
      expect(await db.prisma.evidence.count({ where: { captureSessionId: session.id } })).toBe(0);
      expect((await sessions(alice, wbId))[0]?.status).toBe("EXPIRED");
      const next = await start(alice, wbId);
      expect(next.statusCode).toBe(201);
      expect(next.json().code).not.toBe(session.code);
    });

    it("limits sessions per item per day", async () => {
      const alice = await owner();
      const wbId = await asset(alice);
      for (let i = 0; i < 3; i++) {
        expect((await start(alice, wbId)).statusCode).toBe(201);
        clock.advance(16 * 60_000);
      }
      const res = await start(alice, wbId);
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe("capture_limit_reached");
      clock.advance(24 * 60 * 60_000);
      expect((await start(alice, wbId)).statusCode).toBe(201);
    });
  });

  describe("checks before buying", () => {
    const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const base58 = (bytes: Uint8Array) => {
      let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
      let text = "";
      for (; value > 0n; value /= 58n) text = BASE58[Number(value % 58n)] + text;
      for (const byte of bytes) {
        if (byte !== 0) break;
        text = `1${text}`;
      }
      return text;
    };
    interface Check {
      id: string;
      status: string;
      asset: { wbId: string; status: string; transferBlocked: boolean };
      owner: {
        confirmed: boolean;
        confirmedAt: string | null;
        code: string | null;
        codeExpiresAt: string | null;
        message: string | null;
      };
      item: {
        shots: { shot: string; receivedAt: string | null }[];
        comparing: boolean;
        result: string | null;
        reason: string | null;
        recordedPhotos: { path: string }[];
      };
    }
    const startCheck = (who: Owner, wbId: string) =>
      call(who, "POST", `/assets/${wbId}/purchase-checks`);
    const getCheck = async (who: Owner, id: string) =>
      (await call(who, "GET", `/purchase-checks/${id}`)).json<Check>();
    /** Signs the code as shown to the buyer; `code` is sent as typed by the seller. */
    const confirm = (who: Owner, wbId: string, code: string, signer: TestWallet = who.wallet) =>
      call(who, "POST", `/assets/${wbId}/owner-confirmations`, {
        code: code.toLowerCase(),
        signature: base58(
          signer.sign(`WorthyBound: I confirm to a buyer that I own ${wbId}.\nCode: ${code}`),
        ),
      });
    const sendPhoto = (
      who: Owner | null,
      id: string,
      shot: string,
      body: Buffer,
      type = "image/jpeg",
    ) =>
      app.inject({
        method: "POST",
        url: `/purchase-checks/${id}/photos/${shot}`,
        payload: body,
        headers: { "content-type": type },
        cookies: who ? { wb_session: who.token } : {},
      });
    let seed = 500;
    /** Every shot the check asks for; returns the check after the last one. */
    const takeAll = async (who: Owner, check: Check) => {
      let res;
      for (const s of check.item.shots) {
        res = await sendPhoto(who, check.id, s.shot, await texturedPhoto(seed++));
        expect(res.statusCode, res.body).toBe(200);
      }
      return res?.json<Check>() as Check;
    };
    /** A published asset with a completed capture session. */
    const recordedAsset = async (who: Owner) => {
      const wbId = await asset(who, true);
      const session = (await call(who, "POST", `/assets/${wbId}/capture-sessions`)).json<{
        id: string;
        shots: { shot: string }[];
      }>();
      const ids: string[] = [];
      for (const { shot: captureShot } of session.shots) {
        const { res } = await upload(who, wbId, {
          body: await texturedPhoto(seed++),
          captureSessionId: session.id,
          captureShot,
        });
        expect(res.statusCode, res.body).toBe(201);
        ids.push(res.json().id);
      }
      return { wbId, ids };
    };
    /** Runs every due job, including the checks of uploads made in other tests. */
    const run = async () => {
      const checks = app.automatedChecks as NonNullable<FastifyInstance["automatedChecks"]>;
      while ((await checks.runOnce()) > 0);
    };

    it("confirms the current owner to the buyer without naming them", async () => {
      const alice = await owner();
      const bob = await owner();
      const carol = await owner();
      const wbId = await asset(alice, true);

      const res = await startCheck(bob, wbId);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.body).not.toContain(alice.wallet.address);
      const check = res.json<Check>();
      expect(check).toMatchObject({ status: "OPEN", owner: { confirmed: false } });
      expect(check.owner.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect(check.owner.message).toBe(
        `WorthyBound: I confirm to a buyer that I own ${wbId}.\nCode: ${check.owner.code}`,
      );
      expect(new Date(check.owner.codeExpiresAt as string).getTime() - clock.now().getTime()).toBe(
        5 * 60_000,
      );
      expect(check.item.shots.map((s) => s.shot)).toEqual([
        "DIAL",
        "CASEBACK",
        "CLASP",
        "SERIAL",
        "SIDE",
      ]);
      const again = await startCheck(bob, wbId);
      expect(again.statusCode).toBe(200);
      expect(again.json().id).toBe(check.id);

      expect((await startCheck(alice, wbId)).json().error.code).toBe("own_asset");
      expect((await startCheck(bob, await asset(alice))).statusCode).toBe(404);
      expect((await startCheck(null as unknown as Owner, wbId)).statusCode).toBe(401);
      expect((await call(carol, "GET", `/purchase-checks/${check.id}`)).statusCode).toBe(404);

      const code = check.owner.code as string;
      expect((await confirm(alice, wbId, code, carol.wallet)).json().error.code).toBe(
        "invalid_signature",
      );
      expect((await confirm(alice, wbId, "ABCDEF")).json().error.code).toBe("invalid_code");
      expect((await confirm(carol, wbId, code)).statusCode).toBe(404);
      const confirmed = await confirm(alice, wbId, code);
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toEqual({ confirmed: true, confirmedAt: clock.now().toISOString() });
      expect((await getCheck(bob, check.id)).owner).toEqual({
        confirmed: true,
        confirmedAt: clock.now().toISOString(),
        code: null,
        codeExpiresAt: null,
        message: null,
        codeCheck: null,
      });
      expect((await confirm(alice, wbId, code)).json().error.code).toBe("invalid_code");
      await expect(
        db.prisma.purchaseCheck.update({
          where: { id: check.id },
          data: { ownerSignature: "1".repeat(88) },
        }),
      ).rejects.toThrow(/owner confirmation is final/);
      expect(
        await db.prisma.auditLog.count({
          where: {
            action: { in: ["purchase_check.started", "purchase_check.owner_confirmed"] },
            targetId: wbId,
          },
        }),
      ).toBe(2);

      // A code is valid for 5 minutes; the buyer can ask for a new one.
      const dave = await owner();
      const late = (await startCheck(dave, wbId)).json<Check>();
      clock.advance(5 * 60_000 + 1);
      expect((await getCheck(dave, late.id)).owner.code).toBeNull();
      expect((await confirm(alice, wbId, late.owner.code as string)).json().error.code).toBe(
        "invalid_code",
      );
      const renewed = await call(dave, "POST", `/purchase-checks/${late.id}/owner-code`);
      expect(renewed.statusCode, renewed.body).toBe(200);
      const fresh = renewed.json<Check>().owner.code as string;
      expect(fresh).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect((await confirm(alice, wbId, fresh)).statusCode).toBe(200);
      expect((await getCheck(dave, late.id)).owner.confirmed).toBe(true);
    });

    it("compares the buyer's photos with the recorded ones", async () => {
      const alice = await owner();
      const bob = await owner();
      const { wbId, ids } = await recordedAsset(alice);
      const shown = await call(alice, "POST", `/assets/${wbId}/evidence/${ids[0]}/visibility`, {
        visibility: "PUBLIC",
      });
      expect(shown.statusCode, shown.body).toBe(200);
      await run();

      const check = (await startCheck(bob, wbId)).json<Check>();
      const first = await sendPhoto(bob, check.id, "DIAL", await phonePhoto("#224466"));
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json<Check>().item.shots[0]?.receivedAt).toBe(clock.now().toISOString());
      const stored = await call(bob, "GET", `/purchase-checks/${check.id}/photos/DIAL`);
      expect(stored.statusCode).toBe(200);
      expect(stored.headers["content-type"]).toBe("image/jpeg");
      expect(stored.rawPayload.includes("SECRETCAM")).toBe(false);
      expect((await sharp(stored.rawPayload).metadata()).exif).toBeUndefined();
      expect(
        (await call(alice, "GET", `/purchase-checks/${check.id}/photos/DIAL`)).statusCode,
      ).toBe(404);

      const code = async (res: Promise<{ json: () => { error: { code: string } } }>) =>
        (await res).json().error.code;
      expect(await code(sendPhoto(bob, check.id, "DIAL", await texturedPhoto(seed++)))).toBe(
        "shot_taken",
      );
      expect(await code(sendPhoto(bob, check.id, "CODE", await texturedPhoto(seed++)))).toBe(
        "shot_not_required",
      );
      expect(await code(sendPhoto(bob, check.id, "CLASP", pdf()))).toBe("not_a_photo");
      expect(
        (await sendPhoto(alice, check.id, "CLASP", await texturedPhoto(seed++))).statusCode,
      ).toBe(404);
      expect(
        (await sendPhoto(null, check.id, "CLASP", await texturedPhoto(seed++))).statusCode,
      ).toBe(401);

      engine.matchCalls.length = 0;
      let last;
      for (const s of ["CASEBACK", "CLASP", "SERIAL", "SIDE"]) {
        last = await sendPhoto(bob, check.id, s, await texturedPhoto(seed++));
        expect(last.statusCode, last.body).toBe(200);
      }
      expect(last?.json<Check>().item).toMatchObject({ comparing: true, result: null });
      await run();

      expect(engine.matchCalls).toHaveLength(1);
      const sent = engine.matchCalls[0];
      expect(sent?.asset).toEqual({
        category: "LUXURY_WATCH",
        brand: "Rolex",
        model: "Submariner",
      });
      expect(sent?.reference.map((r) => r.label)).toEqual([
        "owner photo: DIAL",
        "owner photo: CASEBACK",
        "owner photo: CLASP",
        "owner photo: SERIAL",
        "owner photo: SIDE",
      ]);
      expect(sent?.candidate.map((c) => c.label)).toEqual([
        "buyer photo: DIAL",
        "buyer photo: CASEBACK",
        "buyer photo: CLASP",
        "buyer photo: SERIAL",
        "buyer photo: SIDE",
      ]);
      const done = await getCheck(bob, check.id);
      expect(done.status).toBe("COMPLETED");
      expect(done.item).toMatchObject({ comparing: false, result: "MATCH", reason: null });
      expect(done.item.recordedPhotos).toEqual([{ path: `/passport/${wbId}/evidence/${ids[0]}` }]);
      expect(JSON.stringify(done)).not.toContain("scratches");
      const row = await db.prisma.purchaseCheck.findUniqueOrThrow({ where: { id: check.id } });
      expect(row).toMatchObject({
        itemSummary: "The same scratches on the bezel.",
        engine: "fake",
        checkVersion: "item-match-v2",
      });
      expect(row.referenceEvidenceIds).toHaveLength(5);
      await expect(
        db.prisma.purchaseCheck.update({
          where: { id: check.id },
          data: { itemResult: "NO_MATCH" },
        }),
      ).rejects.toThrow(/status COMPLETED is final/);
      expect(await code(sendPhoto(bob, check.id, "SIDE", await texturedPhoto(seed++)))).toBe(
        "purchase_check_closed",
      );
    });

    it("is inconclusive once revoked, without recorded photos, or when the comparison fails", async () => {
      const bob = await owner();
      const alice = await owner();
      const matchCalls = engine.matchCalls.length;

      const revoked = await recordedAsset(alice);
      const first = (await startCheck(bob, revoked.wbId)).json<Check>();
      await takeAll(bob, first);
      await db.prisma.asset.update({ where: { wbId: revoked.wbId }, data: { status: "REVOKED" } });
      await run();
      expect((await getCheck(bob, first.id)).item).toMatchObject({
        result: "INCONCLUSIVE",
        reason: "The item's passport was revoked",
      });

      const bare = await asset(alice, true);
      const second = (await startCheck(bob, bare)).json<Check>();
      await takeAll(bob, second);
      await run();
      expect((await getCheck(bob, second.id)).item).toMatchObject({
        result: "INCONCLUSIVE",
        reason: "The item has no recorded photos to compare with",
      });
      expect(engine.matchCalls).toHaveLength(matchCalls);

      const recorded = await recordedAsset(alice);
      await run();
      const third = (await startCheck(bob, recorded.wbId)).json<Check>();
      await takeAll(bob, third);
      const matching = engine.match;
      engine.match = async () => {
        throw new CheckEngineError("the model refused to answer", false);
      };
      try {
        await run();
      } finally {
        engine.match = matching;
      }
      expect((await getCheck(bob, third.id)).item).toMatchObject({
        result: "INCONCLUSIVE",
        reason: "The photos could not be compared",
      });
    });

    it("expires unfinished checks and limits checks per item per day", async () => {
      const alice = await owner();
      const bob = await owner();
      const wbId = await asset(alice, true);
      const check = (await startCheck(bob, wbId)).json<Check>();
      clock.advance(60 * 60_000);
      expect((await getCheck(bob, check.id)).status).toBe("EXPIRED");
      const late = await sendPhoto(bob, check.id, "DIAL", await texturedPhoto(seed++));
      expect(late.json().error.code).toBe("purchase_check_closed");
      expect((await call(bob, "POST", `/purchase-checks/${check.id}/owner-code`)).statusCode).toBe(
        409,
      );

      for (let i = 1; i < 10; i++) {
        expect((await startCheck(bob, wbId)).statusCode).toBe(201);
        clock.advance(60 * 60_000);
      }
      const limited = await startCheck(bob, wbId);
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("purchase_check_limit_reached");
      clock.advance(24 * 60 * 60_000);
      expect((await startCheck(bob, wbId)).statusCode).toBe(201);
    });

    describe("remotely", () => {
      interface Request {
        id: string;
        code: string;
        expiresAt: string;
        filmed: boolean;
        session: { id: string; code: string; shots: { shot: string }[]; expiresAt: string } | null;
      }
      const startRemote = (who: Owner, wbId: string) =>
        call(who, "POST", `/assets/${wbId}/remote-checks`);
      const requests = async (who: Owner, wbId: string) =>
        (await call(who, "GET", `/assets/${wbId}/remote-checks`)).json<{ items: Request[] }>()
          .items;
      const film = (who: Owner, wbId: string, checkId: string) =>
        call(who, "POST", `/assets/${wbId}/remote-checks/${checkId}/capture-session`);
      /** Uploads a shot of the session: the video shot as a video, the others as photos. */
      const shoot = async (who: Owner, wbId: string, sessionId: string, captureShot: string) =>
        (
          await upload(
            who,
            wbId,
            captureShot === "VIDEO"
              ? {
                  body: videoWithLocation(),
                  type: "VIDEO",
                  mimeType: "video/mp4",
                  captureSessionId: sessionId,
                  captureShot,
                }
              : { body: await texturedPhoto(seed++), captureSessionId: sessionId, captureShot },
          )
        ).res;

      it("lets the owner film the item with the buyer's code and compares the photos", async () => {
        const alice = await owner();
        const bob = await owner();
        const { wbId } = await recordedAsset(alice);
        await run();

        const res = await startRemote(bob, wbId);
        expect(res.statusCode, res.body).toBe(201);
        expect(res.body).not.toContain(alice.wallet.address);
        const check = res.json<Check & { kind: string; expiresAt: string }>();
        expect(check).toMatchObject({
          kind: "REMOTE",
          status: "OPEN",
          owner: { confirmed: false, message: null, codeCheck: null },
          item: { videoAvailable: false, result: null },
        });
        const code = check.owner.code as string;
        expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
        expect(new Date(check.expiresAt).getTime() - clock.now().getTime()).toBe(24 * 3_600_000);
        expect(check.owner.codeExpiresAt).toBe(check.expiresAt);
        const shots = ["DIAL", "CASEBACK", "CLASP", "SERIAL", "SIDE", "CODE", "VIDEO"];
        expect(check.item.shots.map((s) => s.shot)).toEqual(shots);
        expect((await startRemote(bob, wbId)).json().id).toBe(check.id);
        expect((await startRemote(alice, wbId)).json().error.code).toBe("own_asset");

        // The buyer does not take photos, and the code is not signed.
        const photo = await sendPhoto(bob, check.id, "DIAL", await texturedPhoto(seed++));
        expect(photo.json().error.code).toBe("purchase_check_kind");
        const renew = await call(bob, "POST", `/purchase-checks/${check.id}/owner-code`);
        expect(renew.json().error.code).toBe("purchase_check_kind");
        expect((await confirm(alice, wbId, code)).json().error.code).toBe("invalid_code");
        expect((await call(bob, "POST", `/purchase-checks/${check.id}/video`)).statusCode).toBe(
          404,
        );

        // The owner sees the request without the buyer, and films the item with the code.
        const [request] = await requests(alice, wbId);
        expect(request).toMatchObject({ id: check.id, code, filmed: false, session: null });
        expect(JSON.stringify(request)).not.toContain(bob.wallet.address);
        expect((await call(bob, "GET", `/assets/${wbId}/remote-checks`)).statusCode).toBe(404);
        expect((await film(bob, wbId, check.id)).statusCode).toBe(404);
        const started = await film(alice, wbId, check.id);
        expect(started.statusCode, started.body).toBe(201);
        const session = started.json<NonNullable<Request["session"]>>();
        expect(session.code).toBe(code);
        expect(session.shots.map((s) => s.shot)).toEqual(shots);
        expect(new Date(session.expiresAt).getTime() - clock.now().getTime()).toBe(15 * 60_000);
        expect((await film(alice, wbId, check.id)).json().id).toBe(session.id);
        // The owner's own sessions are separate.
        const own = await call(alice, "POST", `/assets/${wbId}/capture-sessions`);
        expect(own.statusCode).toBe(201);
        expect(own.json().id).not.toBe(session.id);

        const wrongType = await requestUpload(alice, wbId, {
          body: await texturedPhoto(seed++),
          captureSessionId: session.id,
          captureShot: "VIDEO",
        });
        expect(wrongType.statusCode).toBe(400);
        for (const shot of shots.slice(0, -1)) {
          expect((await shoot(alice, wbId, session.id, shot)).statusCode).toBe(201);
        }
        const progress = await getCheck(bob, check.id);
        expect(progress.item.shots.filter((s) => s.receivedAt)).toHaveLength(6);
        expect(progress.owner.confirmed).toBe(false);

        const garbled = await upload(alice, wbId, {
          body: mediaFile("mp42"),
          type: "VIDEO",
          mimeType: "video/mp4",
          captureSessionId: session.id,
          captureShot: "VIDEO",
        });
        expect(garbled.res.json().error.code).toBe("video_unreadable");

        clock.advance(60_000);
        engine.matchCalls.length = 0;
        const video = await shoot(alice, wbId, session.id, "VIDEO");
        expect(video.statusCode, video.body).toBe(201);
        const filmed = await getCheck(bob, check.id);
        expect(filmed).toMatchObject({
          status: "OPEN",
          owner: {
            confirmed: true,
            confirmedAt: clock.now().toISOString(),
            code,
            codeCheck: "PENDING",
          },
          item: { comparing: true, videoAvailable: true, result: null },
        });
        expect((await requests(alice, wbId))[0]).toMatchObject({ filmed: true });

        const link = await call(bob, "POST", `/purchase-checks/${check.id}/video`);
        expect(link.statusCode, link.body).toBe(200);
        const downloaded = await fetch(link.json().url);
        expect(downloaded.status).toBe(200);
        expect(downloaded.headers.get("content-disposition")).toContain(
          `remote-check-${check.id}.mp4`,
        );
        // The buyer's copy plays the same media without the location; the original is sealed.
        const copy = Buffer.from(await downloaded.arrayBuffer());
        const stored = await db.prisma.evidence.findUniqueOrThrow({
          where: { id: video.json().id },
        });
        const original = await readAll(await storage.read(stored.storageKey));
        expect(copy.length).toBe(original.length);
        expect(original.includes("+46.2044")).toBe(true);
        expect(copy.includes("+46.2044")).toBe(false);
        expect(copy.includes("com.apple.quicktime")).toBe(false);
        expect(copy.subarray(-256).equals(original.subarray(-256))).toBe(true);
        expect((await call(alice, "POST", `/purchase-checks/${check.id}/video`)).statusCode).toBe(
          404,
        );

        await run();
        expect(engine.matchCalls).toHaveLength(1);
        // Compared with the photos recorded before, not with the session filmed for the check.
        const sent = engine.matchCalls[0];
        expect(sent?.reference.map((r) => r.label)).toEqual([
          "owner photo: DIAL",
          "owner photo: CASEBACK",
          "owner photo: CLASP",
          "owner photo: SERIAL",
          "owner photo: SIDE",
        ]);
        expect(sent?.candidate.map((c) => c.label)).toEqual([
          "seller photo: DIAL",
          "seller photo: CASEBACK",
          "seller photo: CLASP",
          "seller photo: SERIAL",
          "seller photo: SIDE",
        ]);
        const row = await db.prisma.purchaseCheck.findUniqueOrThrow({ where: { id: check.id } });
        const filmedSession = await db.prisma.evidence.findMany({
          where: { captureSessionId: session.id },
          select: { id: true },
        });
        expect(row.referenceEvidenceIds.some((id) => filmedSession.some((e) => e.id === id))).toBe(
          false,
        );
        const compared = await getCheck(bob, check.id);
        expect(compared.item).toMatchObject({
          comparing: false,
          result: "MATCH",
          videoAvailable: true,
        });
        expect(compared.owner).toMatchObject({ codeCheck: "SHOWN" });
        expect(await requests(alice, wbId)).toEqual([]);
        expect(
          await db.prisma.auditLog.count({
            where: {
              action: { in: ["purchase_check.filmed", "purchase_check.video_viewed"] },
              targetId: check.id,
            },
          }),
        ).toBe(2);
        await expect(
          db.prisma.purchaseCheck.update({
            where: { id: check.id },
            data: { ownerCode: "ABCDEF" },
          }),
        ).rejects.toThrow(/remote or receipt check code cannot be changed/);
      });

      it("does not count the shots toward the evidence limit", async () => {
        const alice = await owner();
        const wbId = await asset(alice, true);
        for (let i = 0; i < 100; i++) {
          const res = await requestUpload(alice, wbId, {
            body: pdf(`${i}`),
            type: "RECEIPT",
            mimeType: "application/pdf",
          });
          expect(res.statusCode).toBe(201);
        }
        const check = (await startRemote(await owner(), wbId)).json<Check>();
        const session = (await film(alice, wbId, check.id)).json<{ id: string }>();
        const shot = await requestUpload(alice, wbId, {
          body: await texturedPhoto(seed++),
          captureSessionId: session.id,
          captureShot: "DIAL",
        });
        expect(shot.statusCode, shot.body).toBe(201);
        const res = await requestUpload(alice, wbId, {
          body: pdf(),
          type: "RECEIPT",
          mimeType: "application/pdf",
        });
        expect(res.json().error.code).toBe("evidence_limit_reached");
      });

      it("expires when the owner does not film in time, and is limited per item per day", async () => {
        const alice = await owner();
        const bob = await owner();
        const wbId = await asset(alice, true);
        const check = (await startRemote(bob, wbId)).json<Check>();
        clock.advance(24 * 3_600_000 - 5 * 60_000);
        // A session ends with the check.
        const session = (await film(alice, wbId, check.id)).json<{ expiresAt: string }>();
        expect(session.expiresAt).toBe(new Date(clock.now().getTime() + 5 * 60_000).toISOString());
        clock.advance(5 * 60_000);
        expect((await getCheck(bob, check.id)).status).toBe("EXPIRED");
        expect((await film(alice, wbId, check.id)).json().error.code).toBe("purchase_check_closed");
        expect(await requests(alice, wbId)).toEqual([]);

        for (let i = 0; i < 3; i++) {
          expect((await startRemote(await owner(), wbId)).statusCode).toBe(201);
        }
        // An in-person check is separate from the buyer's remote one.
        expect((await startCheck(bob, wbId)).statusCode).toBe(201);
        const limited = await startRemote(await owner(), wbId);
        expect(limited.statusCode).toBe(429);
        expect(limited.json().error.code).toBe("purchase_check_limit_reached");
      });
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
