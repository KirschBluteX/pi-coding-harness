import { describe, expect, it } from "vitest";
import { assertWalRuntimeSafe, sqliteWalRuntimeSupport } from "../../src/authority/sqlite-runtime.js";

describe("SQLite WAL runtime safety", () => {
  it.each([
    ["3.51.2", false], ["3.51.3", true], ["3.52.0", true],
    ["3.50.6", false], ["3.50.7", true], ["3.44.5", false], ["3.44.6", true],
    ["3.49.2", false], ["invalid", false], ["", false],
  ] as const)("classifies %s against the WAL-reset fix", (version, safe) => {
    expect(sqliteWalRuntimeSupport(version).safe).toBe(safe);
  });

  it("uses the embedded SQLite version when no override is supplied", () => {
    expect(sqliteWalRuntimeSupport()).toEqual(sqliteWalRuntimeSupport(process.versions.sqlite));
  });

  it("fails closed with an actionable upgrade requirement", () => {
    expect(() => assertWalRuntimeSafe("3.51.2")).toThrow(/WAL-reset.*3\.51\.3/iu);
    expect(() => assertWalRuntimeSafe("3.51.3")).not.toThrow();
  });
});
