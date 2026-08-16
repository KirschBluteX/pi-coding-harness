import { describe, expect, it } from "vitest";
import {
  minimalScopePaths, scopeContains, scopePathKey, scopesMayOverlap,
} from "../../src/harness/scope-path.js";

describe("Harness scope paths", () => {
  it("normalizes separators and Unicode without changing case", () => {
    expect(scopePathKey("src\\e\u0301xample.ts")).toEqual({
      normalized: "src/éxample.ts",
      folded: "src/éxample.ts",
    });
  });

  it("uses exact paths for access and conservative aliases for conflicts", () => {
    expect(scopeContains("src", "src/example.ts")).toBe(true);
    expect(scopeContains("src/example.ts", "SRC/EXAMPLE.TS")).toBe(false);
    expect(scopesMayOverlap("src/example.ts", "SRC/EXAMPLE.TS")).toBe(true);
  });

  it("rejects traversal and portable absolute paths", () => {
    for (const value of ["../secret", "src/../secret", "C:\\secret", "//server/share", "/root/secret"]) {
      expect(() => scopePathKey(value)).toThrow(/scope path is invalid/u);
    }
  });

  it("removes exact descendant roots without merging case aliases", () => {
    expect(minimalScopePaths(["src/a", "src/a/file.ts", "SRC/A"])).toEqual(["SRC/A", "src/a"]);
  });
});
