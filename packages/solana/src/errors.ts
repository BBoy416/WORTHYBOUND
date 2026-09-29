import { isSolanaError, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM } from "@solana/kit";

/**
 * The custom program error code in a failed transaction (e.g. 6010 StaleUpdate), found in the
 * error or its causes (preflight failures wrap it), or undefined.
 */
export function customProgramErrorCode(error: unknown): number | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 10; depth++) {
    if (isSolanaError(e, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) return e.context.code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The chain already holds this update or a newer one; retrying would change nothing. */
export class StaleChainUpdateError extends Error {
  constructor() {
    super("a newer update is already recorded on-chain");
    this.name = "StaleChainUpdateError";
  }
}
