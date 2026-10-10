import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.js";

const root = resolve(import.meta.dirname, "../..");

describe("standalone Single entry", () => {
  it("publishes an independent CLI without installing Pi as a peer", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(manifest.bin?.pch).toBe("./dist/cli/index.js");
    expect(manifest.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional).toBe(true);
    expect(existsSync(resolve(root, "src", "cli", "index.ts"))).toBe(true);
  });

  it("rejects unsafe gateway URLs before creating the data root", async () => {
    const dataRoot = resolve(root, ".tmp", `pch-cli-rejected-${randomUUID()}`);
    await expect(main([
      "run", "Edit a file", "--workspace", root, "--data-root", dataRoot,
      "--base-url", "https://user:password@example.invalid/v1", "--model", "fixture",
      "--context-window", "8192",
    ], { PCH_API_KEY: "fixture" })).rejects.toThrow(/must not contain credentials/i);
    expect(existsSync(dataRoot)).toBe(false);
  });
});
