import { DOMAIN_ENUMS } from "@worthybound/shared";
import { describe, expect, it } from "vitest";
import * as PrismaEnums from "../src/generated/prisma/enums.js";

describe("domain enums", () => {
  it("define every Prisma enum", () => {
    expect(Object.keys(DOMAIN_ENUMS).sort()).toEqual(Object.keys(PrismaEnums).sort());
  });

  it.each(Object.entries(PrismaEnums))("match the Prisma enum %s", (name, values) => {
    expect(DOMAIN_ENUMS[name as keyof typeof DOMAIN_ENUMS]).toEqual(Object.values(values));
  });
});
