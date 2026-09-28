/** Custom SQLSTATE codes raised by the integrity triggers (see the integrity migration). */
export const DatabaseErrorCode = {
  APPEND_ONLY: "WB001",
  IMMUTABLE: "WB002",
  AUTHORITY: "WB003",
} as const;
export type DatabaseErrorCode = (typeof DatabaseErrorCode)[keyof typeof DatabaseErrorCode];

interface ErrorShape {
  code?: unknown;
  meta?: { driverAdapterError?: { cause?: { code?: unknown } } };
}

/**
 * Returns true if the error carries the given PostgreSQL SQLSTATE, either as a raw
 * node-postgres error or wrapped by Prisma's driver adapter.
 */
export function isDatabaseError(error: unknown, sqlState: string): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as ErrorShape;
  return e.code === sqlState || e.meta?.driverAdapterError?.cause?.code === sqlState;
}
