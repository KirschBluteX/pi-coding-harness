import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256, parseCanonicalJson } from "../../src/authority/canonical-json.js";

describe("PCH-CJ1 canonical JSON", () => {
  it("normalizes strings and sorts object keys lexicographically", () => {
    const value = { z: [true, null, 4], b: 2, a: "e\u0301", 2: "two", 10: "ten" };
    const rendered = canonicalJson(value);
    expect(rendered).toBe('{"10":"ten","2":"two","a":"é","b":2,"z":[true,null,4]}');
    expect(parseCanonicalJson(rendered)).toEqual({ 10: "ten", 2: "two", a: "é", b: 2, z: [true, null, 4] });
  });

  it("produces a stable lowercase SHA-256", () => {
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(canonicalJsonSha256({ a: 1, b: 2 }));
    expect(canonicalJsonSha256({ a: 1 })).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("serializes finite decimal contract values without changing integer bytes", () => {
    expect(canonicalJson({ confidence: 0.95, integer: 2, negativeZero: -0 })).toBe('{"confidence":0.95,"integer":2,"negativeZero":0}');
    expect(parseCanonicalJson('{"confidence":0.95,"integer":2,"negativeZero":0}')).toEqual({ confidence: 0.95, integer: 2, negativeZero: 0 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe JSON number %s", (value) => {
    expect(() => canonicalJson({ value })).toThrow(/finite JSON number/u);
  });

  it("rejects undefined, cycles and NFC-colliding keys", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(/not canonical JSON/u);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/u);
    expect(() => canonicalJson({ "e\u0301": 1, "é": 2 })).toThrow(/collide/u);
  });
});
