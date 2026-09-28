import { describe, expect, it } from "vitest";
import {
  canPublish,
  missingPublishFields,
  normalizeBrand,
  normalizeSerial,
  serialFingerprintInput,
} from "../src/index.js";

describe("asset rules", () => {
  it("requires brand and model before publishing", () => {
    expect(missingPublishFields({ brand: null, model: null })).toEqual(["brand", "model"]);
    expect(missingPublishFields({ brand: "Rolex", model: "  " })).toEqual(["model"]);
    expect(missingPublishFields({ brand: "Rolex", model: "Submariner" })).toEqual([]);
  });

  it("publishes only drafts and tokenized assets that were never published", () => {
    expect(canPublish("DRAFT", null)).toBe(true);
    expect(canPublish("TOKENIZED", null)).toBe(true);
    expect(canPublish("ACTIVE", new Date())).toBe(false);
    expect(canPublish("REVOKED", null)).toBe(false);
  });

  it("normalizes serials so formatting differences still match", () => {
    expect(normalizeSerial("ab-12 34")).toBe("AB1234");
    expect(normalizeSerial("AB.12/34_")).toBe("AB1234");
    expect(normalizeSerial("ＡＢ１２３４")).toBe("AB1234");
    expect(normalizeSerial("AB1234")).not.toBe(normalizeSerial("AB1235"));
  });

  it("normalizes brands", () => {
    expect(normalizeBrand("ROLEX.")).toBe(normalizeBrand("rolex"));
    expect(normalizeBrand("Audemars Piguet")).toBe("audemarspiguet");
    expect(normalizeBrand(null)).toBe("");
  });

  it("builds a versioned fingerprint input from category, brand and serial", () => {
    expect(serialFingerprintInput("LUXURY_WATCH", "Rolex", "ab-1234")).toBe(
      "wb-serial-v1|LUXURY_WATCH|rolex|AB1234",
    );
    expect(serialFingerprintInput("LUXURY_WATCH", "ROLEX", "AB 1234")).toBe(
      serialFingerprintInput("LUXURY_WATCH", "rolex", "ab1234"),
    );
    expect(serialFingerprintInput("JEWELRY", "Rolex", "AB1234")).not.toBe(
      serialFingerprintInput("LUXURY_WATCH", "Rolex", "AB1234"),
    );
  });
});
