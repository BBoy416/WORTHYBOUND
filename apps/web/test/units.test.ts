import { describe, expect, it } from "vitest";
import { humanize, shortAddress } from "../src/format.js";
import { match } from "../src/router.js";
import { toBase58, toBase64 } from "../src/wallet.js";

describe("match", () => {
  it("extracts parameters", () => {
    expect(match("/assets/:wbId", "/assets/WB-7F93A281")).toEqual({ wbId: "WB-7F93A281" });
    expect(match("/assets/:wbId", "/assets/WB-7F93A281/")).toEqual({ wbId: "WB-7F93A281" });
  });
  it("rejects other paths", () => {
    expect(match("/assets/:wbId", "/assets")).toBeNull();
    expect(match("/assets/:wbId", "/verifier/WB-1")).toBeNull();
  });
});

describe("encoders", () => {
  it("base58 matches known vectors, keeping leading zeros", () => {
    expect(toBase58(new Uint8Array([]))).toBe("");
    expect(toBase58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(toBase58(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
    expect(toBase58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });
  it("base64 encodes bytes", () => {
    expect(toBase64(new Uint8Array([0, 255, 10]))).toBe("AP8K");
  });
});

describe("format", () => {
  it("humanizes enum values like the token metadata", () => {
    expect(humanize("LUXURY_WATCH")).toBe("Luxury watch");
    expect(humanize("REPORTED_STOLEN")).toBe("Reported stolen");
  });
  it("shortens addresses", () => {
    expect(shortAddress("4WFo2nZ5eqWqnstZupSt6oqq6tN2MTM4C2ARixHrWfmv")).toBe("4WFo…Wfmv");
  });
});
