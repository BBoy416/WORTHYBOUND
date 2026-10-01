import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
};

/** Page loads that must reach the API even when the browser asks for HTML. */
const API_ONLY = [/^\/metadata\//, /^\/health$/, /^\/passport\/[^/]+\/evidence\//];

/**
 * Serves the built web app (apps/web) from `dir` on the API's origin, so sign-in cookies and
 * passport links (`/passport/:wbId`) work on one domain. Browser page loads (Accept: text/html)
 * get the app; API calls (Accept: application/json) reach the routes as before.
 */
export async function registerWebApp(app: FastifyInstance, dir: string): Promise<void> {
  const index = await readFile(join(dir, "index.html"));

  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") return;
    if (!request.headers.accept?.includes("text/html")) return;
    const path = request.url.split("?")[0] ?? "/";
    if (path.startsWith("/static/") || API_ONLY.some((pattern) => pattern.test(path))) return;
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(index);
  });

  const sendFile = async (subdir: string, file: string, cache: string, reply: FastifyReply) => {
    const type = TYPES[file.split(".").pop() ?? ""];
    if (!type || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(file)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
    }
    try {
      const body = await readFile(join(dir, subdir, file));
      return reply.type(type).header("cache-control", cache).send(body);
    } catch {
      return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
    }
  };

  // Vite puts hashed bundles in static/ (build.assetsDir), so they can be cached for good.
  app.get<{ Params: { file: string } }>("/static/:file", (request, reply) =>
    sendFile("static", request.params.file, "public, max-age=31536000, immutable", reply),
  );
  // Unhashed files from apps/web/public, at fixed paths that browsers and link previews request.
  for (const file of ["favicon.png", "apple-touch-icon.png", "og-image.png"]) {
    app.get(`/${file}`, (_request, reply) => sendFile("", file, "public, max-age=86400", reply));
  }
}
