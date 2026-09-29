/** Error returned by the API: `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the API on the same origin with the session cookie. */
export async function api<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...extraHeaders };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? "error", error?.message ?? res.statusText);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  api<T>("POST", path, body, headers);

/** Hex SHA-256 of a file, as the API expects when an upload is requested. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

/** Sends a file straight to storage with the presigned PUT the API returned. */
export async function putFile(upload: PresignedUpload, file: Blob): Promise<void> {
  const headers = Object.fromEntries(
    Object.entries(upload.headers).filter(([name]) => name.toLowerCase() !== "content-length"),
  );
  const res = await fetch(upload.url, { method: upload.method, headers, body: file });
  if (!res.ok) throw new ApiError(res.status, "upload_failed", "The file could not be uploaded");
}
