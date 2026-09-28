import { describe, expect, it } from "vitest";
import { DatabaseErrorCode, isDatabaseError } from "../src/errors.js";

describe("isDatabaseError", () => {
  it("matches a raw node-postgres error", () => {
    expect(isDatabaseError({ code: "WB001" }, DatabaseErrorCode.APPEND_ONLY)).toBe(true);
  });

  it("matches an error wrapped by the Prisma driver adapter", () => {
    const error = { code: "P2039", meta: { driverAdapterError: { cause: { code: "WB003" } } } };
    expect(isDatabaseError(error, DatabaseErrorCode.AUTHORITY)).toBe(true);
    expect(isDatabaseError(error, DatabaseErrorCode.IMMUTABLE)).toBe(false);
  });

  it.each([null, undefined, "WB001", 42, new Error("WB001")])("does not match %s", (value) => {
    expect(isDatabaseError(value, DatabaseErrorCode.APPEND_ONLY)).toBe(false);
  });
});
