import { render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../src/App.js";
import { Router } from "../src/router.js";
import { SessionProvider } from "../src/session.js";

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => { status?: number; json?: unknown } | undefined;

/** Replaces fetch with a table of routes ("METHOD /path") and records every call. */
export function mockFetch(routes: Record<string, Handler | { status?: number; json?: unknown }>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>),
    );
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call = { method, url, headers, body };
    calls.push(call);
    const path = url.startsWith("http") ? url : url.split("?")[0];
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${url}`];
    const result = typeof route === "function" ? route(call) : route;
    if (!result)
      return new Response(JSON.stringify({ error: { code: "not_found", message: "Not found" } }), {
        status: 404,
      });
    return new Response(result.json === undefined ? "" : JSON.stringify(result.json), {
      status: result.status ?? 200,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

export function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  return render(
    <Router>
      <SessionProvider>
        <App />
      </SessionProvider>
    </Router>,
  );
}

export const me = (roles = ["USER"], identityStatus = "VERIFIED") => ({
  user: {
    id: "u1",
    walletAddress: "4WFo2nZ5eqWqnstZupSt6oqq6tN2MTM4C2ARixHrWfmv",
    displayName: null,
    identityStatus,
  },
  roles,
  session: { expiresAt: "2026-10-12T12:00:00.000Z" },
});

export const unauthenticated = {
  status: 401,
  json: { error: { code: "unauthenticated", message: "Sign in" } },
};
