import { isAddress } from "@solana/addresses";
import { authNonceRequestSchema, authVerifyRequestSchema } from "@worthybound/validation";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { fingerprint, writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { newNonce, newSessionToken, sha256Hex } from "../crypto.js";
import { SESSION_COOKIE, SESSION_TTL_MS, type AuthContext } from "./guard.js";
import {
  buildSignInInput,
  matchesIssuedInput,
  NONCE_TTL_MS,
  parseSignedMessage,
  signInMessageText,
  type SignInFailure,
  verifyWalletSignature,
} from "./siws.js";

const signInInputSchema = z.object({
  domain: z.string(),
  address: z.string(),
  statement: z.string(),
  uri: z.string(),
  version: z.string(),
  chainId: z.string(),
  nonce: z.string(),
  issuedAt: z.string(),
  expirationTime: z.string(),
});

const meSchema = z.object({
  user: z.object({
    id: z.string(),
    walletAddress: z.string(),
    displayName: z.string().nullable(),
    identityStatus: z.string(),
  }),
  roles: z.array(z.string()),
  session: z.object({ expiresAt: z.iso.datetime() }),
});

const me = (auth: AuthContext) => ({
  user: auth.user,
  roles: auth.roles,
  session: { expiresAt: auth.sessionExpiresAt.toISOString() },
});

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const authRoutes: FastifyPluginAsyncZod<AppContext> = async (app, ctx) => {
  const { config, prisma, now, authenticate, rateLimits } = ctx;
  const limited = {
    rateLimit: { max: rateLimits.auth.max, timeWindow: rateLimits.auth.timeWindowMs },
  };

  app.post(
    "/auth/nonce",
    {
      config: limited,
      schema: {
        body: authNonceRequestSchema,
        response: {
          200: z.object({ input: signInInputSchema, message: z.string(), expiresAt: z.string() }),
          400: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { address } = request.body;
      if (!isAddress(address)) {
        return reply
          .code(400)
          .send({ error: { code: "invalid_request", message: "Invalid wallet address" } });
      }
      const issuedAt = now();
      const row = await prisma.authNonce.create({
        data: {
          walletAddress: address,
          nonce: newNonce(),
          domain: config.AUTH_DOMAIN,
          issuedAt,
          expiresAt: new Date(issuedAt.getTime() + NONCE_TTL_MS),
        },
      });
      const input = buildSignInInput(config, row);
      return { input, message: signInMessageText(input), expiresAt: input.expirationTime };
    },
  );

  app.post(
    "/auth/verify",
    {
      config: limited,
      schema: { body: authVerifyRequestSchema, response: { 200: meSchema, 401: errorSchema } },
    },
    async (request, reply) => {
      const { address } = request.body;
      const message = Buffer.from(request.body.message, "base64");
      const signature = Buffer.from(request.body.signature, "base64");
      const fp = fingerprint(config.SESSION_SECRET, request);

      const fail = async (reason: SignInFailure) => {
        await writeAudit(
          prisma,
          {
            actorId: null,
            action: "auth.sign_in_failed",
            targetType: "wallet",
            targetId: address,
            metadata: { reason },
          },
          fp,
        );
        return reply
          .code(401)
          .send({ error: { code: "sign_in_failed", message: "Sign-in failed" } });
      };

      const parsed = parseSignedMessage(message);
      if (!parsed?.nonce) return fail("malformed_message");
      const row = await prisma.authNonce.findUnique({ where: { nonce: parsed.nonce } });
      if (!row) return fail("unknown_nonce");
      if (!matchesIssuedInput(parsed, buildSignInInput(config, row))) return fail("field_mismatch");
      if (address !== row.walletAddress) return fail("address_mismatch");
      if (!verifyWalletSignature(address, message, signature)) return fail("invalid_signature");
      if (row.usedAt) return fail("nonce_used");
      const at = now();
      if (at >= row.expiresAt) return fail("expired");

      const token = newSessionToken();
      const signedIn = await prisma.$transaction(async (tx) => {
        const consumed = await tx.authNonce.updateMany({
          where: { id: row.id, usedAt: null, expiresAt: { gt: at } },
          data: { usedAt: at },
        });
        if (consumed.count !== 1) return null;
        const created = await tx.user.createMany({
          data: [{ walletAddress: address }],
          skipDuplicates: true,
        });
        const user = await tx.user.findUniqueOrThrow({
          where: { walletAddress: address },
          include: { roles: { where: { revokedAt: null }, select: { role: true } } },
        });
        if (created.count === 1) {
          await tx.roleAssignment.create({ data: { userId: user.id, role: "USER" } });
          user.roles.push({ role: "USER" });
        }
        const session = await tx.session.create({
          data: {
            userId: user.id,
            tokenHash: sha256Hex(token),
            createdAt: at,
            expiresAt: new Date(at.getTime() + SESSION_TTL_MS),
            ipHash: fp.ipHash,
            userAgentHash: fp.userAgentHash,
          },
        });
        await writeAudit(
          tx,
          {
            actorId: user.id,
            action: "auth.sign_in",
            targetType: "user",
            targetId: user.id,
            metadata: { sessionId: session.id, newUser: created.count === 1 },
          },
          fp,
        );
        return { user, session };
      });
      if (!signedIn) return fail("nonce_used");

      const { user, session } = signedIn;
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        expires: session.expiresAt,
      });
      return me({
        sessionId: session.id,
        sessionExpiresAt: session.expiresAt,
        user: {
          id: user.id,
          walletAddress: user.walletAddress,
          displayName: user.displayName,
          identityStatus: user.identityStatus,
        },
        roles: user.roles.map((r) => r.role),
      });
    },
  );

  app.get(
    "/auth/me",
    { preHandler: authenticate, schema: { response: { 200: meSchema } } },
    async (request) => me(request.auth as AuthContext),
  );

  app.post("/auth/logout", { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth as AuthContext;
    await prisma.session.updateMany({
      where: { id: auth.sessionId, revokedAt: null },
      data: { revokedAt: now() },
    });
    await writeAudit(
      prisma,
      {
        actorId: auth.user.id,
        action: "auth.sign_out",
        targetType: "user",
        targetId: auth.user.id,
        metadata: { sessionId: auth.sessionId },
      },
      fingerprint(config.SESSION_SECRET, request),
    );
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });
};
