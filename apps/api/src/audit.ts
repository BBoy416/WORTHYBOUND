import type { Prisma, PrismaClient } from "@worthybound/database";
import type { FastifyRequest } from "fastify";
import { hmacHex } from "./crypto.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface RequestFingerprint {
  ipHash: string;
  userAgentHash: string | null;
}

export function fingerprint(secret: string, request: FastifyRequest): RequestFingerprint {
  const userAgent = request.headers["user-agent"];
  return {
    ipHash: hmacHex(secret, request.ip),
    userAgentHash: userAgent ? hmacHex(secret, userAgent) : null,
  };
}

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata?: Prisma.InputJsonObject;
}

/** Appends to the append-only audit log. */
export async function writeAudit(
  db: Db,
  entry: AuditEntry,
  fp: RequestFingerprint | null,
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata ?? {},
      ipHash: fp?.ipHash ?? null,
      userAgentHash: fp?.userAgentHash ?? null,
    },
  });
}
