import type { IdentityStatus, PrismaClient, Role } from "@worthybound/database";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { sha256Hex } from "../crypto.js";

export const SESSION_COOKIE = "wb_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthContext {
  sessionId: string;
  sessionExpiresAt: Date;
  user: {
    id: string;
    walletAddress: string;
    displayName: string | null;
    identityStatus: IdentityStatus;
  };
  /** Active roles, read from the database on every request. */
  roles: Role[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const unauthenticated = (reply: FastifyReply) =>
  reply.code(401).send({ error: { code: "unauthenticated", message: "Sign in required" } });

/** Loads the session from the cookie; rejects missing, unknown, revoked and expired sessions. */
export function createAuthenticate(
  prisma: PrismaClient,
  now: () => Date,
): preHandlerAsyncHookHandler {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    if (request.auth) return;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return unauthenticated(reply);
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: {
        user: { include: { roles: { where: { revokedAt: null }, select: { role: true } } } },
      },
    });
    if (!session || session.revokedAt || session.expiresAt <= now()) {
      return unauthenticated(reply);
    }
    const { user } = session;
    request.auth = {
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt,
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        displayName: user.displayName,
        identityStatus: user.identityStatus,
      },
      roles: user.roles.map((r) => r.role),
    };
  };
}

/** Requires a session holding at least one of the roles. */
export function createRequireRole(authenticate: preHandlerAsyncHookHandler) {
  return (...roles: Role[]): preHandlerAsyncHookHandler =>
    async function requireRole(request, reply) {
      await authenticate.call(this, request, reply);
      if (reply.sent) return;
      if (!request.auth?.roles.some((role) => roles.includes(role))) {
        return reply
          .code(403)
          .send({ error: { code: "forbidden", message: "Insufficient permissions" } });
      }
    };
}
