import { WB_ID_PATTERN } from "@worthybound/shared";
import { z } from "zod";

/** Trimmed, non-empty text with a length limit. */
export const text = (max: number) => z.string().trim().min(1).max(max);

/** Accepts `wb-7f93a281` style input and normalizes it to `WB-7F93A281`. */
export const wbIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(WB_ID_PATTERN, "expected an asset ID like WB-7F93A281");

export const uuidSchema = z.uuid();

/** Lower-case hex SHA-256, the format stored by the database. */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lower-case hex SHA-256");

const BASE58 = "1-9A-HJ-NP-Za-km-z";

export const solanaAddressSchema = z
  .string()
  .regex(new RegExp(`^[${BASE58}]{32,44}$`), "expected a base58 Solana address");

export const solanaSignatureSchema = z
  .string()
  .regex(new RegExp(`^[${BASE58}]{64,88}$`), "expected a base58 Solana signature");

/** ISO-8601 timestamp with an explicit offset, parsed to a Date. */
export const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const httpsUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === "https:", "expected an https URL");

/** Array without duplicates. */
export const uniqueArray = <T extends z.ZodType>(item: T) =>
  z.array(item).refine((values) => new Set(values).size === values.length, "duplicate values");
