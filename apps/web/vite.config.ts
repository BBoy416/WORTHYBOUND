import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const api = process.env.WB_API_URL ?? "http://127.0.0.1:4000";

/** API paths; in development, page loads of these paths still get the app (as in production). */
const apiPaths = [
  "/auth",
  "/assets",
  "/evidence",
  "/passport",
  "/metadata",
  "/templates",
  "/verification-requests",
  "/verifier",
  "/verifiers",
  "/attestations",
  "/review",
  "/admin",
  "/health",
];

export default defineConfig({
  plugins: [react()],
  // Not "assets": /assets/:wbId is an API route on the same origin.
  build: { assetsDir: "static" },
  server: {
    proxy: Object.fromEntries(
      apiPaths.map((path) => [
        path,
        {
          target: api,
          bypass: (req: { headers: { accept?: string | undefined } }) =>
            req.headers.accept?.includes("text/html") ? "/index.html" : undefined,
        },
      ]),
    ),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
  },
});
