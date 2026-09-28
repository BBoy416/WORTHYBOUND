import { DomainError } from "@worthybound/shared";

/** An error whose code and message are safe to return to clients. */
export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

/** Converts lifecycle rule violations into 409 responses. */
export function fromDomainError(error: unknown): unknown {
  if (error instanceof DomainError) {
    return new ApiError(409, error.code.toLowerCase(), error.message);
  }
  return error;
}
