import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sealStructuralResult } from "../../src/input-context/structural/domain.js";
import { StructuralLookupIndex } from "../../src/input-context/structural/lookup-index.js";
import { StructuralContextService } from "../../src/input-context/structural/service.js";

async function service(): Promise<{ readonly root: string; readonly structural: StructuralContextService }> {
  const root = await mkdtemp(join(tmpdir(), "pch-structural-"));
  return { root, structural: new StructuralContextService({ workspaceRoot: root, maxFileBytes: 64_000, maxEntries: 64 }) };
}

describe("lazy structural context adapters", () => {
  it("extracts TypeScript declarations and exposes dynamic dependency uncertainty", async () => {
    const fixture = await service();
    await writeFile(join(fixture.root, "sample.ts"), [
      'import { readFile } from "node:fs/promises";',
      "export interface Item { id: string }",
      "export class Store { get(): Item { return { id: 'x' }; } }",
      "export async function load(name: string) { return import(name); }",
    ].join("\n"));
    const result = await fixture.structural.extractFile("sample.ts");
    expect(result.status).toBe("PARTIAL");
    expect(result.reasons).toContain("DYNAMIC_DEPENDENCY");
    expect(result.entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["interface", "class", "method", "function"]));
    expect(result.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ specifier: "node:fs/promises", dynamic: false }),
      expect.objectContaining({ specifier: null, dynamic: true }),
    ]));
  });

  it("parses Markdown plus JSON, YAML and TOML with explicit completeness", async () => {
    const fixture = await service();
    await writeFile(join(fixture.root, "guide.md"), "# Goal\nText [source](./source.md).\n\n## Check\n```ts\nconst ok = true;\n```\n");
    await writeFile(join(fixture.root, "value.json"), '{"server":{"port":8080}}');
    await writeFile(join(fixture.root, "value.yaml"), "server:\n  port: 8080\n");
    await writeFile(join(fixture.root, "value.toml"), "[server]\nport = 8080\n");
    const [markdown, json, yaml, toml] = await Promise.all([
      fixture.structural.extractFile("guide.md"), fixture.structural.extractFile("value.json"),
      fixture.structural.extractFile("value.yaml"), fixture.structural.extractFile("value.toml"),
    ]);
    expect(markdown).toMatchObject({ status: "COMPLETE", format: "MARKDOWN" });
    expect(markdown.entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["heading-1", "heading-2", "code"]));
    for (const result of [json, yaml, toml]) {
      expect(result.status).toBe("COMPLETE");
      expect(result.entries.some((entry) => entry.name === "server.port")).toBe(true);
    }
  });

  it("groups log failures and rejects malformed unified diffs", async () => {
    const fixture = await service();
    await writeFile(join(fixture.root, "run.log"), "INFO start\nERROR request 123 failed\nERROR request 456 failed\nWARN retry\n");
    await writeFile(join(fixture.root, "good.diff"), "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n");
    await writeFile(join(fixture.root, "bad.diff"), "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1 @@\n-old\n+new\n");
    const log = await fixture.structural.extractFile("run.log");
    expect(log.entries[0]?.excerpt).toContain("count=2");
    expect((await fixture.structural.extractFile("good.diff")).status).toBe("COMPLETE");
    expect(await fixture.structural.extractFile("bad.diff")).toMatchObject({ status: "INSUFFICIENT", reasons: ["HUNK_COUNT_MISMATCH"] });
  });

  it("is lazy, hash-invalidated and excludes vendor/generated/unknown inputs", async () => {
    const fixture = await service();
    await writeFile(join(fixture.root, "config.json"), '{"value":1}');
    expect(fixture.structural.metrics()).toMatchObject({ parses: 0, cacheHits: 0 });
    const first = await fixture.structural.extractFile("config.json");
    const second = await fixture.structural.extractFile("config.json");
    expect(second.record_sha256).toBe(first.record_sha256);
    expect(fixture.structural.metrics()).toMatchObject({ parses: 1, cacheHits: 1 });
    await writeFile(join(fixture.root, "config.json"), '{"value":2}');
    expect((await fixture.structural.extractFile("config.json")).source_sha256).not.toBe(first.source_sha256);
    expect(fixture.structural.metrics().parses).toBe(2);
    await mkdir(join(fixture.root, "vendor"));
    await writeFile(join(fixture.root, "vendor", "dep.ts"), "export const dep = 1;");
    await writeFile(join(fixture.root, "generated.ts"), "// @generated\nexport const value = 1;");
    await writeFile(join(fixture.root, "plain.txt"), "unknown");
    expect(await fixture.structural.extractFile("vendor/dep.ts")).toMatchObject({ status: "EXCLUDED", reasons: ["VENDOR_OR_BUILD_PATH"] });
    expect(await fixture.structural.extractFile("generated.ts")).toMatchObject({ status: "EXCLUDED", reasons: ["GENERATED_SOURCE"] });
    expect(await fixture.structural.extractFile("plain.txt")).toMatchObject({ status: "INSUFFICIENT", reasons: ["UNSUPPORTED_FORMAT"] });
    expect(await fixture.structural.extractFile("missing.json")).toMatchObject({ status: "INSUFFICIENT", reasons: ["SOURCE_MISSING_OR_UNREADABLE"] });
    expect(await fixture.structural.extractFile(join(fixture.root, "..", "outside.json"))).toMatchObject({
      status: "INSUFFICIENT", reasons: ["PATH_OUTSIDE_WORKSPACE"],
    });
  });

  it("does not alias path-bound results for identical bytes", async () => {
    const fixture = await service();
    await writeFile(join(fixture.root, "one.json"), '{"same":true}');
    await writeFile(join(fixture.root, "two.json"), '{"same":true}');
    const one = await fixture.structural.extractFile("one.json");
    const two = await fixture.structural.extractFile("two.json");
    expect(one.source_sha256).toBe(two.source_sha256);
    expect(one.source_path).toBe("one.json");
    expect(two.source_path).toBe("two.json");
    expect(one.record_sha256).not.toBe(two.record_sha256);
  });

  it("provides bounded warm prefix lookup with source-confirmation bindings", () => {
    const index = new StructuralLookupIndex(2);
    const result = sealStructuralResult({
      schema_version: 1, source_path: "src/a.ts", source_sha256: "a".repeat(64), byte_length: 10,
      format: "TYPESCRIPT", adapter_version: "test", status: "COMPLETE", dependency_completeness: "COMPLETE",
      entries: ["Alpha", "Alpine", "Beta"].map((name, offset) => ({
        kind: "function", name, start_line: offset + 1, end_line: offset + 1, excerpt: name, source_slice_sha256: null,
      })),
      dependencies: [], reasons: [],
    });
    expect(index.rebuild([result])).toEqual({ indexed: 2, truncated: true });
    expect(index.lookup("Al", 10)).toMatchObject({
      status: "PARTIAL", requires_source_confirmation: true,
      rows: [{ name: "Alpha", source_sha256: "a".repeat(64) }, { name: "Alpine", source_sha256: "a".repeat(64) }],
    });
    index.clear();
    expect(index.lookup("Alpha").status).toBe("NO_INDEX");
  });
});
