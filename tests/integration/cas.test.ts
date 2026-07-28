import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AtomicFileModule from "../../src/artifacts/atomic-file.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { publishAtomicNoReplace } from "../../src/artifacts/atomic-file.js";
import { ArtifactIntegrityError, UnsafePathError } from "../../src/foundation/errors.js";

vi.mock("../../src/artifacts/atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AtomicFileModule>();
  return { ...actual, publishAtomicNoReplace: vi.fn(actual.publishAtomicNoReplace) };
});

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "pch-cas-test-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("content-addressed ArtifactStore", () => {
  it("publishes complete bytes once and verifies same-content collisions", () => {
    const store = new ArtifactStore(join(directory(), "cas"));
    const content = Buffer.alloc(1024 * 1024, 0x5a);
    const first = store.put(content, { mediaType: "application/octet-stream", classification: "INTERNAL", retentionClass: "GOAL" });
    const second = store.put(content, { mediaType: "application/octet-stream", classification: "INTERNAL", retentionClass: "GOAL" });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ locator: first.locator, sha256: first.sha256, created: false });
    expect(publishAtomicNoReplace).toHaveBeenCalledTimes(1);
    expect(Buffer.from(store.open(first.locator))).toEqual(content);
    expect(store.retain(first.locator).valid).toBe(true);
  }, 15_000);

  it("detects tampering and rejects malformed locators", () => {
    const store = new ArtifactStore(join(directory(), "cas"));
    const record = store.put("evidence", { mediaType: "text/plain", classification: "INTERNAL", retentionClass: "GOAL" });
    const path = join(store.root, record.sha256.slice(0, 2), record.sha256);
    expect(readFileSync(path, "utf8")).toBe("evidence");
    writeFileSync(path, "tampered", "utf8");
    expect(store.verify(record.locator).valid).toBe(false);
    expect(() => store.open(record.locator)).toThrow(ArtifactIntegrityError);
    expect(() => store.put("evidence", { mediaType: "text/plain", classification: "INTERNAL", retentionClass: "GOAL" }))
      .toThrow(ArtifactIntegrityError);
    expect(publishAtomicNoReplace).toHaveBeenCalledTimes(1);
    expect(() => store.open("pch-cas://sha256/../../escape")).toThrow(/Invalid CAS locator/u);
  });

  it("requires encryption metadata for SECRET bytes", () => {
    const store = new ArtifactStore(join(directory(), "cas"));
    expect(() => store.put("secret", { mediaType: "text/plain", classification: "SECRET", retentionClass: "GOAL" })).toThrow(/encryption/u);
    const encrypted = store.put(Buffer.from("ciphertext"), {
      mediaType: "application/octet-stream", classification: "SECRET", retentionClass: "GOAL", encrypted: true, encryptionKeyId: "KEY-TEST",
    });
    expect(encrypted.encryptionKeyId).toBe("KEY-TEST");
  });

  it("rejects a CAS root reached through a symlink or junction when supported", () => {
    const root = directory();
    const actual = join(root, "actual");
    const initial = new ArtifactStore(actual);
    expect(initial.root).toBeTruthy();
    const linked = join(root, "linked");
    try {
      symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() => new ArtifactStore(linked)).toThrow(UnsafePathError);
  });

  it("rejects a shard replaced by a symlink or junction after Store creation", () => {
    const store = new ArtifactStore(join(directory(), "cas"));
    const record = store.put("replace shard", { mediaType: "text/plain", classification: "INTERNAL", retentionClass: "GOAL" });
    const shard = join(store.root, record.sha256.slice(0, 2));
    rmSync(shard, { recursive: true, force: true });
    const external = join(directory(), "external");
    mkdirSync(external);
    try {
      symlinkSync(external, shard, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() => store.verify(record.locator)).toThrow(UnsafePathError);
  });
});
