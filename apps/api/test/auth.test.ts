import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "../src/auth/guard.js";
import { NONCE_TTL_MS, signInMessageText, type SignInInput } from "../src/auth/siws.js";
import { grantAdmin } from "../src/cli/admin-grant.js";
import { sha256Hex } from "../src/crypto.js";
import {
  createTestDatabase,
  requestNonce,
  signIn,
  TEST_DATABASE_URL,
  testApp,
  testClock,
  testConfig,
  TestWallet,
  verifyPayload,
  type TestDatabase,
} from "./helpers.js";

describe.skipIf(!TEST_DATABASE_URL)("wallet authentication", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  const clock = testClock();

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await testApp(db.prisma, {
      now: clock.now,
      register: (app, ctx) => {
        app.get("/test/admin", { preHandler: ctx.requireRole("ADMIN") }, async () => ({
          ok: true,
        }));
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const verify = (payload: object) => app.inject({ method: "POST", url: "/auth/verify", payload });
  const me = (token?: string) =>
    app.inject({ method: "GET", url: "/auth/me", cookies: token ? { wb_session: token } : {} });

  async function lastFailure(address: string) {
    const log = await db.prisma.auditLog.findFirst({
      where: { action: "auth.sign_in_failed", targetId: address },
      orderBy: { createdAt: "desc" },
    });
    return (log?.metadata as { reason?: string } | undefined)?.reason;
  }

  /** Signs a message built from the issued request with some fields changed. */
  async function signModified(wallet: TestWallet, change: Partial<SignInInput>) {
    const { input } = await requestNonce(app, wallet.address);
    const message = signInMessageText({ ...input, ...change });
    return verifyPayload(wallet.address, message, wallet.sign(message));
  }

  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  describe("nonce", () => {
    it("issues a Sign In With Solana message bound to the domain, devnet and the wallet", async () => {
      const wallet = new TestWallet();
      const { input, message, expiresAt } = await requestNonce(app, wallet.address);
      expect(input).toMatchObject({
        domain: "worthybound.test",
        address: wallet.address,
        uri: "https://worthybound.test",
        version: "1",
        chainId: "solana:devnet",
      });
      expect(input.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(message).toBe(signInMessageText(input));
      expect(message).toContain(
        `worthybound.test wants you to sign in with your Solana account:\n${wallet.address}`,
      );
      expect(new Date(expiresAt).getTime() - new Date(input.issuedAt).getTime()).toBe(NONCE_TTL_MS);
      const row = await db.prisma.authNonce.findUniqueOrThrow({ where: { nonce: input.nonce } });
      expect(row).toMatchObject({ walletAddress: wallet.address, usedAt: null });
    });

    it.each([
      ["a base58 string that is not a 32-byte key", { address: "z".repeat(44) }],
      ["unknown fields", { address: new TestWallet().address, userId: "x" }],
      ["a missing address", {}],
    ])("rejects %s", async (_name, payload) => {
      const res = await app.inject({ method: "POST", url: "/auth/nonce", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    });

    it("accepts JSON only", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/nonce",
        headers: { "content-type": "text/plain" },
        payload: JSON.stringify({ address: new TestWallet().address }),
      });
      expect(res.statusCode).toBe(415);
    });
  });

  describe("sign-in", () => {
    it("creates an unverified user with the USER role and an httpOnly session cookie", async () => {
      const wallet = new TestWallet();
      const { message } = await requestNonce(app, wallet.address);
      const res = await verify(verifyPayload(wallet.address, message, wallet.sign(message)));

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user).toMatchObject({
        walletAddress: wallet.address,
        identityStatus: "UNVERIFIED",
      });
      expect(body.roles).toEqual(["USER"]);
      expect(new Date(body.session.expiresAt).getTime()).toBe(
        clock.now().getTime() + SESSION_TTL_MS,
      );

      const cookie = res.cookies.find((c) => c.name === "wb_session");
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
      const token = cookie?.value as string;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const session = await db.prisma.session.findFirstOrThrow({
        where: { userId: body.user.id },
      });
      expect(session.tokenHash).toBe(sha256Hex(token));
      expect(session.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(session.ipHash).not.toBe(sha256Hex("127.0.0.1"));

      const audit = await db.prisma.auditLog.findFirstOrThrow({
        where: { action: "auth.sign_in", actorId: body.user.id },
      });
      expect(audit.metadata).toEqual({ sessionId: session.id, newUser: true });

      const meRes = await me(token);
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json()).toEqual(body);
    });

    it("signs a returning wallet into the same account without duplicating roles", async () => {
      const wallet = new TestWallet();
      await signIn(app, wallet);
      await signIn(app, wallet);
      const user = await db.prisma.user.findUniqueOrThrow({
        where: { walletAddress: wallet.address },
        include: { roles: true, sessions: true },
      });
      expect(user.roles.map((r) => r.role)).toEqual(["USER"]);
      expect(user.sessions).toHaveLength(2);
      const logs = await db.prisma.auditLog.findMany({
        where: { action: "auth.sign_in", actorId: user.id },
        orderBy: { createdAt: "asc" },
      });
      expect(logs.map((l) => (l.metadata as { newUser: boolean }).newUser)).toEqual([true, false]);
    });

    it("never stores the wallet signature, message or session token", async () => {
      const wallet = new TestWallet();
      const token = await signIn(app, wallet);
      const dump = JSON.stringify([
        await db.prisma.session.findMany(),
        await db.prisma.auditLog.findMany(),
      ]);
      expect(dump).not.toContain(token);
    });
  });

  describe("replay protection", () => {
    it("rejects a signed message that was already used", async () => {
      const wallet = new TestWallet();
      const { message } = await requestNonce(app, wallet.address);
      const payload = verifyPayload(wallet.address, message, wallet.sign(message));
      expect((await verify(payload)).statusCode).toBe(200);
      const replay = await verify(payload);
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toEqual({
        error: { code: "sign_in_failed", message: "Sign-in failed" },
      });
      expect(await lastFailure(wallet.address)).toBe("nonce_used");
    });

    it("accepts only one of several simultaneous uses of the same message", async () => {
      const wallet = new TestWallet();
      const { message } = await requestNonce(app, wallet.address);
      const payload = verifyPayload(wallet.address, message, wallet.sign(message));
      const results = await Promise.all(Array.from({ length: 8 }, () => verify(payload)));
      expect(results.map((r) => r.statusCode).sort()).toEqual([
        200, 401, 401, 401, 401, 401, 401, 401,
      ]);
      expect(
        await db.prisma.session.count({ where: { user: { walletAddress: wallet.address } } }),
      ).toBe(1);
    });

    it("rejects an expired message", async () => {
      const wallet = new TestWallet();
      const { message } = await requestNonce(app, wallet.address);
      clock.advance(NONCE_TTL_MS);
      const res = await verify(verifyPayload(wallet.address, message, wallet.sign(message)));
      expect(res.statusCode).toBe(401);
      expect(await lastFailure(wallet.address)).toBe("expired");
    });
  });

  describe("rejected messages", () => {
    it.each<[string, Partial<SignInInput>]>([
      ["another website (phishing)", { domain: "worthyb0und.test" }],
      ["another URI", { uri: "https://evil.test" }],
      ["Solana mainnet", { chainId: "solana:mainnet" }],
      ["an edited statement", { statement: "Approve transfer of all assets" }],
      ["an extended expiry", { expirationTime: "2099-01-01T00:00:00.000Z" }],
    ])("rejects a message for %s", async (_name, change) => {
      const wallet = new TestWallet();
      expect((await verify(await signModified(wallet, change))).statusCode).toBe(401);
      expect(await lastFailure(wallet.address)).toBe("field_mismatch");
    });

    it("rejects a message with added resources", async () => {
      const wallet = new TestWallet();
      const { message } = await requestNonce(app, wallet.address);
      const extended = `${message}\nResources:\n- https://evil.test`;
      expect(
        (await verify(verifyPayload(wallet.address, extended, wallet.sign(extended)))).statusCode,
      ).toBe(401);
      expect(await lastFailure(wallet.address)).toBe("field_mismatch");
    });

    it("rejects someone signing in as another person's wallet", async () => {
      const victim = new TestWallet();
      const attacker = new TestWallet();
      const { message } = await requestNonce(app, victim.address);
      const res = await verify(verifyPayload(victim.address, message, attacker.sign(message)));
      expect(res.statusCode).toBe(401);
      expect(await lastFailure(victim.address)).toBe("invalid_signature");
      expect(await db.prisma.user.count({ where: { walletAddress: victim.address } })).toBe(0);
    });

    it("rejects a signature presented for a different wallet than the nonce", async () => {
      const victim = new TestWallet();
      const attacker = new TestWallet();
      const { message } = await requestNonce(app, victim.address);
      const res = await verify(verifyPayload(attacker.address, message, attacker.sign(message)));
      expect(res.statusCode).toBe(401);
      expect(await lastFailure(attacker.address)).toBe("address_mismatch");
    });

    it("rejects a forged signature", async () => {
      const wallet = new TestWallet();
      const { message } = await requestNonce(app, wallet.address);
      expect(
        (await verify(verifyPayload(wallet.address, message, randomBytes(64)))).statusCode,
      ).toBe(401);
      expect(await lastFailure(wallet.address)).toBe("invalid_signature");
    });

    it("rejects a nonce that was never issued", async () => {
      const wallet = new TestWallet();
      const { input } = await requestNonce(app, wallet.address);
      const message = signInMessageText({
        ...input,
        nonce: "0".repeat(32),
      });
      expect(
        (await verify(verifyPayload(wallet.address, message, wallet.sign(message)))).statusCode,
      ).toBe(401);
      expect(await lastFailure(wallet.address)).toBe("unknown_nonce");
    });

    it("rejects text that is not a sign-in message", async () => {
      const wallet = new TestWallet();
      const text = "Please send me 10 SOL";
      expect(
        (await verify(verifyPayload(wallet.address, text, wallet.sign(text)))).statusCode,
      ).toBe(401);
      expect(await lastFailure(wallet.address)).toBe("malformed_message");
    });
  });

  describe("sessions", () => {
    it("rejects requests without a valid session", async () => {
      expect((await me()).statusCode).toBe(401);
      const res = await me(randomBytes(32).toString("base64url"));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthenticated");
    });

    it("ends the session on logout", async () => {
      const wallet = new TestWallet();
      const token = await signIn(app, wallet);
      const res = await app.inject({
        method: "POST",
        url: "/auth/logout",
        cookies: { wb_session: token },
      });
      expect(res.statusCode).toBe(204);
      expect(res.cookies.find((c) => c.name === "wb_session")?.value).toBe("");
      expect((await me(token)).statusCode).toBe(401);
      const session = await db.prisma.session.findUniqueOrThrow({
        where: { tokenHash: sha256Hex(token) },
      });
      expect(session.revokedAt).not.toBeNull();
      expect(
        await db.prisma.auditLog.count({
          where: { action: "auth.sign_out", actorId: session.userId },
        }),
      ).toBe(1);
    });

    it("expires sessions after 7 days", async () => {
      const token = await signIn(app, new TestWallet());
      clock.advance(SESSION_TTL_MS - 1);
      expect((await me(token)).statusCode).toBe(200);
      clock.advance(1);
      expect((await me(token)).statusCode).toBe(401);
    });
  });

  describe("roles", () => {
    it("reads roles from the database on every request", async () => {
      const wallet = new TestWallet();
      const token = await signIn(app, wallet);
      const admin = () =>
        app.inject({ method: "GET", url: "/test/admin", cookies: { wb_session: token } });

      const denied = await admin();
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("forbidden");

      expect(await grantAdmin(db.prisma, wallet.address)).toBe("granted");
      expect((await admin()).statusCode).toBe(200);
      expect((await me(token)).json().roles.sort()).toEqual(["ADMIN", "USER"]);

      await db.prisma.roleAssignment.updateMany({
        where: { user: { walletAddress: wallet.address }, role: "ADMIN" },
        data: { revokedAt: clock.now() },
      });
      expect((await admin()).statusCode).toBe(403);
    });

    it("requires a session before checking roles", async () => {
      expect((await app.inject({ method: "GET", url: "/test/admin" })).statusCode).toBe(401);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("rate limiting", () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await testApp(db.prisma, {
      rateLimits: {
        auth: { max: 3, timeWindowMs: 60_000 },
        register: { max: 1000, timeWindowMs: 60_000 },
        write: { max: 1000, timeWindowMs: 60_000 },
        public: { max: 1000, timeWindowMs: 60_000 },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("limits sign-in requests per IP address", async () => {
    const address = new TestWallet().address;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push(
        (await app.inject({ method: "POST", url: "/auth/nonce", payload: { address } })).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 429]);
    const res = await app.inject({ method: "POST", url: "/auth/nonce", payload: { address } });
    expect(res.json().error.code).toBe("rate_limited");
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("client IP behind a proxy", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** Signs in with the given X-Forwarded-For header and returns the session's IP hash. */
  const ipHashVia = async (app: FastifyInstance, forwardedFor: string) => {
    const wallet = new TestWallet();
    const { message } = await requestNonce(app, wallet.address);
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-forwarded-for": forwardedFor },
      payload: verifyPayload(wallet.address, message, wallet.sign(message)),
    });
    expect(res.statusCode, res.body).toBe(200);
    const session = await db.prisma.session.findFirstOrThrow({
      where: { user: { walletAddress: wallet.address } },
    });
    return session.ipHash;
  };

  it("ignores X-Forwarded-For unless TRUST_PROXY is set", async () => {
    const direct = await testApp(db.prisma);
    try {
      expect(await ipHashVia(direct, "203.0.113.1")).toBe(await ipHashVia(direct, "203.0.113.2"));
    } finally {
      await direct.close();
    }
  });

  it("uses the address added by the trusted proxy", async () => {
    const proxied = await testApp(db.prisma, { config: testConfig({ TRUST_PROXY: "1" }) });
    try {
      const a = await ipHashVia(proxied, "203.0.113.1");
      expect(a).not.toBe(await ipHashVia(proxied, "203.0.113.2"));
      // Only the last hop is trusted; a client-supplied entry before it is ignored.
      expect(await ipHashVia(proxied, "198.51.100.7, 203.0.113.1")).toBe(a);
    } finally {
      await proxied.close();
    }
  });
});
