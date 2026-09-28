export const DOMAIN_ERROR_CODES = [
  "INVALID_WB_ID",
  "INVALID_TRANSITION",
  "FORBIDDEN_TRANSITION",
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/** A business rule violation. `code` is stable and safe to return to clients. */
export class DomainError extends Error {
  override name = "DomainError";

  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}
