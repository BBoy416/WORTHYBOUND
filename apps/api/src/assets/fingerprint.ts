import { createHmac } from "node:crypto";
import { type AssetCategory, serialFingerprintInput } from "@worthybound/shared";

/** Version of SERIAL_FINGERPRINT_KEY; rotating the key means recomputing every fingerprint. */
export const SERIAL_FINGERPRINT_KEY_VERSION = 1;

export interface SerialFingerprint {
  serialFingerprint: string;
  serialFingerprintKeyVersion: number;
}

/** Keyed so the stored value cannot be matched against a list of known serials without the key. */
export function serialFingerprint(
  key: string,
  asset: { category: AssetCategory; brand: string | null; serialNumber: string },
): SerialFingerprint {
  return {
    serialFingerprint: createHmac("sha256", key)
      .update(serialFingerprintInput(asset.category, asset.brand, asset.serialNumber))
      .digest("hex"),
    serialFingerprintKeyVersion: SERIAL_FINGERPRINT_KEY_VERSION,
  };
}
