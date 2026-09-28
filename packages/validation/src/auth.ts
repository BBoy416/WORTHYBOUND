import { z } from "zod";
import { solanaAddressSchema } from "./common.js";

const base64 = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64");

/** Step 1 of Sign In With Solana: the wallet asks for a sign-in message. */
export const authNonceRequestSchema = z.strictObject({
  address: solanaAddressSchema,
});
export type AuthNonceRequestInput = z.infer<typeof authNonceRequestSchema>;

/** Step 2: the wallet returns the exact message it signed and the Ed25519 signature, base64. */
export const authVerifyRequestSchema = z.strictObject({
  address: solanaAddressSchema,
  message: base64(4096),
  signature: base64(88),
});
export type AuthVerifyRequestInput = z.infer<typeof authVerifyRequestSchema>;
