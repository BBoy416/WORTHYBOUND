import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageOptions {
  /** S3 API endpoint, e.g. `http://127.0.0.1:9000`. Omit for AWS S3. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Private bucket holding all evidence. */
  bucket: string;
}

export interface PresignedUpload {
  /** Send the file as the body of a PUT to this URL. */
  url: string;
  method: "PUT";
  /** Headers to send with the PUT. The browser sets Content-Length itself from the body. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface ObjectInfo {
  sizeBytes: number;
  etag: string | null;
}

export interface SetupOptions {
  /** Objects under this prefix are deleted automatically after one day. */
  stagingPrefix: string;
  /** Website origins allowed to upload directly from the browser. */
  corsOrigins: string[];
}

export interface SetupReport {
  bucketCreated: boolean;
  /** False when the storage server does not support the setting. */
  publicAccessBlocked: boolean;
  corsConfigured: boolean;
  /** Checked by reading a test object without credentials. Setup fails if this is false. */
  anonymousReadDenied: boolean;
}

const isNotFound = (error: unknown) =>
  error instanceof S3ServiceException &&
  (error.$metadata.httpStatusCode === 404 ||
    error.name === "NotFound" ||
    error.name === "NoSuchKey");

/** Some S3-compatible servers answer unsupported settings with NotImplemented or MalformedXML. */
const isUnsupported = (error: unknown) =>
  error instanceof S3ServiceException &&
  (error.$metadata.httpStatusCode === 501 ||
    error.name === "NotImplemented" ||
    error.name === "MalformedXML");

/** Content-Disposition for a download; the name is reduced to safe ASCII plus an RFC 5987 copy. */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The only code that talks to object storage. Keys are always private object keys, never URLs. */
export function createStorage(options: StorageOptions) {
  const { bucket } = options;
  const client = new S3Client({
    region: options.region,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  const unsignedUrl = (key: string) =>
    options.endpoint
      ? `${options.endpoint.replace(/\/$/, "")}/${bucket}/${key}`
      : `https://${bucket}.s3.${options.region}.amazonaws.com/${key}`;

  const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000);

  return {
    bucket,

    /**
     * A one-time browser upload to `key`. Content type and length are signed, so the storage
     * server itself rejects any other size or type, and the URL cannot choose a different key.
     * A PUT rather than a form POST, which Cloudflare R2 does not support.
     */
    async presignUpload(input: {
      key: string;
      contentType: string;
      sizeBytes: number;
      expiresInSeconds: number;
    }): Promise<PresignedUpload> {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.key,
          ContentType: input.contentType,
          ContentLength: input.sizeBytes,
        }),
        {
          expiresIn: input.expiresInSeconds,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return {
        url,
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        expiresAt: expiry(input.expiresInSeconds),
      };
    },

    /** A short-lived link that always downloads the file instead of opening it. */
    async presignDownload(input: {
      key: string;
      filename: string;
      contentType: string;
      expiresInSeconds: number;
    }): Promise<PresignedDownload> {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: input.key,
          ResponseContentDisposition: attachment(input.filename),
          ResponseContentType: input.contentType,
        }),
        { expiresIn: input.expiresInSeconds },
      );
      return { url, expiresAt: expiry(input.expiresInSeconds) };
    },

    async head(key: string): Promise<ObjectInfo | null> {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { sizeBytes: res.ContentLength ?? 0, etag: res.ETag ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async read(key: string): Promise<Readable> {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body as Readable;
    },

    async put(key: string, body: Buffer, contentType: string): Promise<void> {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    /** Server-side copy. With `ifMatch`, fails if the source changed since it was inspected. */
    async copy(from: string, to: string, ifMatch?: string): Promise<void> {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: to,
          CopySource: `${bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
          ...(ifMatch ? { CopySourceIfMatch: ifMatch } : {}),
        }),
      );
    },

    async remove(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    /** Creates the bucket if needed, blocks public access and expires abandoned uploads. */
    async setup(setup: SetupOptions): Promise<SetupReport> {
      let bucketCreated = false;
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        bucketCreated = true;
      }

      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: "expire-abandoned-uploads",
                Status: "Enabled",
                Filter: { Prefix: setup.stagingPrefix },
                Expiration: { Days: 1 },
              },
            ],
          },
        }),
      );

      let publicAccessBlocked = true;
      try {
        await client.send(
          new PutPublicAccessBlockCommand({
            Bucket: bucket,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          }),
        );
      } catch (error) {
        if (!isUnsupported(error)) throw error;
        publicAccessBlocked = false;
      }

      let corsConfigured = true;
      try {
        await client.send(
          new PutBucketCorsCommand({
            Bucket: bucket,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedMethods: ["PUT"],
                  AllowedOrigins: setup.corsOrigins,
                  AllowedHeaders: ["*"],
                  MaxAgeSeconds: 3600,
                },
              ],
            },
          }),
        );
      } catch (error) {
        if (!isUnsupported(error)) throw error;
        corsConfigured = false;
      }

      const probe = `${setup.stagingPrefix}setup-check-${Date.now()}`;
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: probe, Body: "x", ContentType: "text/plain" }),
      );
      const anonymous = await fetch(unsignedUrl(probe)).finally(() =>
        client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probe })),
      );
      const anonymousReadDenied = anonymous.status === 403 || anonymous.status === 401;
      if (!anonymousReadDenied) {
        throw new Error(`bucket ${bucket} allows reading files without credentials`);
      }
      return { bucketCreated, publicAccessBlocked, corsConfigured, anonymousReadDenied };
    },

    /** Keys under `prefix`. */
    async list(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
        token = page.NextContinuationToken;
      } while (token);
      return keys;
    },

    /** Deletes every object and the bucket itself. For throwaway test buckets only. */
    async deleteBucket(): Promise<void> {
      for (const key of await this.list("")) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    },

    destroy(): void {
      client.destroy();
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;
