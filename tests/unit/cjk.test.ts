import { describe, expect, it } from "vitest";
import { cjkNgrams, memorySearchTerms } from "../../src/memory/cjk.js";

describe("Memory CJK projection", () => {
  it("emits stable unique 2-gram and 3-gram terms", () => {
    expect(cjkNgrams("缓存命中率")).toEqual([
      "中率", "命中", "命中率", "存命", "存命中", "缓存", "缓存命",
    ]);
  });

  it("combines normalized words with CJK terms", () => {
    const terms = memorySearchTerms("SQLite 缓存命中");
    expect(terms).toContain("sqlite");
    expect(terms).toContain("缓存");
    expect(terms).toContain("缓存命");
    expect(terms).toEqual([...terms].sort());
  });
});
