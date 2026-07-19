/**
 * requiredEnv, extracted from the byte-identical `required` copies in main.ts
 * and production.ts. Both composition roots read required config from
 * process.env and must fail identically on a missing variable.
 */
import { describe, expect, it } from "vitest";
import { requiredEnv } from "../src/env.js";

describe("requiredEnv", () => {
  it("returns the value when present", () => {
    expect(requiredEnv({ FOO: "bar" }, "FOO")).toBe("bar");
  });

  it("throws a clear error naming the missing variable", () => {
    expect(() => requiredEnv({}, "MISSING")).toThrow("missing required environment variable MISSING");
  });

  it("treats an empty-string value as missing", () => {
    expect(() => requiredEnv({ EMPTY: "" }, "EMPTY")).toThrow("EMPTY");
  });
});
