import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

describe("migration manifest state projections", () => {
  it("allows hashless state projections without weakening other rewritten entries", () => {
    const manifestSchema = JSON.parse(
      readFileSync(resolve("schemas", "migration-manifest.schema.json"), "utf8"),
    ) as { $defs: Record<string, unknown> };
    const entrySchema: AnySchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: manifestSchema.$defs,
      $ref: "#/$defs/entry",
    };
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(entrySchema);
    const digest = "A".repeat(64);
    const rewritten = {
      id: "MIG-999",
      source: "X:\\source\\example.ts",
      destination: "src/example.ts",
      source_sha256: digest,
      destination_sha256: digest,
      category: "CODE",
      purpose: "Regression fixture.",
      disposition: "REWRITTEN",
      rewritten: true,
      reason: "Regression fixture.",
    };
    const stateProjection = {
      ...rewritten,
      destination: "manifests/PROJECT-STATE.json",
      source_sha256: null,
      destination_sha256: null,
      category: "RUN_ARTIFACT",
    };

    expect(validate(rewritten), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(stateProjection), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...rewritten, source_sha256: null })).toBe(false);
    expect(validate({ ...stateProjection, destination_sha256: digest })).toBe(false);
  });
});
