import {
  linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/authority/canonical-json.js";
import { MemoryVault, type MemoryVaultPrepared } from "../../src/memory/vault.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "pch-memory-vault-"));
  directories.push(value);
  return value;
}

function files(root: string): string[] {
  const result: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result.push(child);
    }
  };
  visit(root);
  return result;
}

function prepare(vault: MemoryVault, claimId = "MEM3-VAULT-001", version = 1): MemoryVaultPrepared {
  return vault.prepare({
    workspaceId: "WS-VAULT-001", claimId, version,
    authorityMetadata: { domain: "TEST-METADATA", claimId, version },
    body: { schema_version: 1, record_type: "MEMORY_V3_BODY", content: "Keep output concise." },
  });
}

describe("Memory Vault V1", () => {
  it("round-trips canonical content with independent ciphertext and no plaintext files", () => {
    const vault = new MemoryVault(directory(), randomBytes(32));
    const first = prepare(vault, "MEM3-VAULT-001");
    const second = prepare(vault, "MEM3-VAULT-002");
    expect(first.ciphertextSha256).not.toBe(second.ciphertextSha256);
    expect(first.wrappedKeySha256).not.toBe(second.wrappedKeySha256);
    expect(vault.open(first)).toEqual({
      schema_version: 1, record_type: "MEMORY_V3_BODY", content: "Keep output concise.",
    });
    for (const path of files(vault.root)) {
      expect(readFileSync(path, "utf8")).not.toContain("Keep output concise.");
    }
    expect(prepare(vault, "MEM3-VAULT-001")).toMatchObject({ reused: true, ciphertextSha256: first.ciphertextSha256 });
  });

  it("fails closed for a wrong install key, tamper, and a hard-linked entry", () => {
    const root = directory();
    const vault = new MemoryVault(root, randomBytes(32));
    const prepared = prepare(vault);
    const wrongKey = new MemoryVault(root, randomBytes(32));
    expect(() => wrongKey.open(prepared)).toThrow(/authentication failed/u);

    const ciphertext = files(vault.root).find((path) => path.endsWith(".ciphertext.v1"));
    if (!ciphertext) throw new Error("ciphertext fixture missing");
    const value = JSON.parse(readFileSync(ciphertext, "utf8")) as Record<string, unknown>;
    value.auth_tag_base64 = Buffer.alloc(16, 9).toString("base64");
    writeFileSync(ciphertext, canonicalJson(value), { mode: 0o600 });
    expect(() => vault.open(prepared)).toThrow(/file hash does not match authority/u);

    const clean = prepare(vault, "MEM3-VAULT-002");
    const key = files(vault.root).find((path) => path.endsWith(".key.v1") && readFileSync(path, "utf8").includes(clean.claimId));
    if (!key) throw new Error("key fixture missing");
    const alias = `${key}.alias`;
    linkSync(key, alias);
    expect(() => vault.open(clean)).toThrow(/single-link regular file/u);
    unlinkSync(alias);
    expect(vault.open(clean)).toMatchObject({ content: "Keep output concise." });
  });

  it("makes restore impossible after local key destruction and cleans exact prepared files", () => {
    const vault = new MemoryVault(directory(), randomBytes(32));
    const prepared = prepare(vault);
    expect(vault.inspect(prepared)).toEqual({ body: "PRESENT", key: "PRESENT" });
    expect(vault.destroyKey(prepared)).toBe("DESTROYED");
    expect(vault.destroyKey(prepared)).toBe("ALREADY_ABSENT");
    expect(vault.inspect(prepared)).toEqual({ body: "PRESENT", key: "MISSING" });
    expect(() => vault.open(prepared)).toThrow();

    const disposable = prepare(vault, "MEM3-VAULT-002");
    vault.discardPrepared(disposable);
    expect(vault.inspect(disposable)).toEqual({ body: "MISSING", key: "MISSING" });
  });

  it("quarantines only unreferenced old files and removes them after a second grace window", () => {
    const vault = new MemoryVault(directory(), randomBytes(32));
    const retained = prepare(vault, "MEM3-VAULT-001");
    const orphan = prepare(vault, "MEM3-VAULT-002");
    const old = new Date(1_000);
    for (const path of files(vault.root).filter((path) => path.includes(orphan.claimId) === false)) {
      const contents = readFileSync(path, "utf8");
      if (contents.includes(orphan.claimId)) utimesSync(path, old, old);
    }
    const first = vault.reconcileOrphans(
      new Set([retained.vaultRefSha256]), new Set([retained.keyRefSha256]), 10_000, 1_000,
    );
    expect([...first.quarantinedRefSha256].sort()).toEqual([orphan.keyRefSha256, orphan.vaultRefSha256].sort());
    expect(first.removedQuarantineCount).toBe(0);
    expect(vault.open(retained)).toMatchObject({ content: "Keep output concise." });
    const second = vault.reconcileOrphans(
      new Set([retained.vaultRefSha256]), new Set([retained.keyRefSha256]), 12_000, 1_000,
    );
    expect(second.removedQuarantineCount).toBe(2);
  });
});
