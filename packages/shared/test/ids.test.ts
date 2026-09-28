import { describe, expect, it } from "vitest";
import { DomainError, generateWbId, isWbId, parseWbId, WB_ID_PATTERN } from "../src/index.js";

describe("WorthyBound asset IDs", () => {
  it("generates IDs in the database format", () => {
    for (let i = 0; i < 1000; i++) expect(generateWbId()).toMatch(WB_ID_PATTERN);
  });

  it("generates different IDs", () => {
    const ids = new Set(Array.from({ length: 1000 }, generateWbId));
    expect(ids.size).toBeGreaterThan(990);
  });

  it.each(["WB-7F93A281", "WB-00000000", "WB-FFFFFFFF"])("accepts %s", (id) => {
    expect(isWbId(id)).toBe(true);
  });

  it.each([
    "WB-7f93a281",
    "WB-7F93A28",
    "WB-7F93A2811",
    "WB-7F93A28G",
    "XB-7F93A281",
    " WB-7F93A281",
    42,
  ])("rejects %s", (id) => {
    expect(isWbId(id)).toBe(false);
  });

  it("normalizes case and whitespace when parsing", () => {
    expect(parseWbId("  wb-7f93a281 \n")).toBe("WB-7F93A281");
  });

  it("throws a DomainError for invalid input", () => {
    expect(() => parseWbId("WB-123")).toThrow(DomainError);
    try {
      parseWbId("not-an-id");
    } catch (error) {
      expect((error as DomainError).code).toBe("INVALID_WB_ID");
    }
  });
});
