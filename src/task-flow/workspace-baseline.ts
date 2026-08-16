import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import { hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";
import { createId } from "../foundation/ids.js";
import { sealTaskFlowRecord, type WorkCellRecord, type WorkspaceBaselineRecord } from "./domain.js";

const ignoredDirectories = new Set([".git", ".coding-harness", "node_modules", "dist", "build", ".cache"]);
const maximumFiles = 4_096;
const maximumBytes = 64 * 1024 * 1024;
const maximumDirectFiles = 128;
const maximumDirectBytes = 8 * 1024 * 1024;
const maximumManifestChars = 262_144;

interface HashCacheEntry {
  readonly stamp: string;
  readonly sha256: string;
}

export interface WorkspaceBaselineCaptureInput {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly workspaceSecret: Uint8Array;
  readonly cell: WorkCellRecord;
  readonly direct: boolean;
  readonly nowMs: number;
}

function contained(root: string, candidate: string): boolean {
  const delta = relative(resolve(root), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function normalizedRoot(workspace: string, value: string): { readonly relative: string; readonly absolute: string } {
  const text = value.normalize("NFC").trim().replaceAll("\\", "/");
  if (!text || isAbsolute(text)) throw new TypeError(`Task Flow scope must be workspace-relative: ${value}`);
  const absolute = resolve(workspace, text);
  if (!contained(workspace, absolute)) throw new TypeError(`Task Flow scope escapes the workspace: ${value}`);
  if (existsSync(absolute)) {
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink() || !contained(workspace, realpathSync(absolute))) {
      throw new TypeError(`Task Flow scope resolves through or to an unsafe link: ${value}`);
    }
  }
  return { relative: relative(workspace, absolute).replaceAll("\\", "/") || ".", absolute };
}

export class WorkspaceBaselineCapture {
  private readonly hashCache = new Map<string, HashCacheEntry>();

  clear(): void {
    this.hashCache.clear();
  }

  capture(input: WorkspaceBaselineCaptureInput): WorkspaceBaselineRecord {
    const normalizedRoots = [...new Set([...input.cell.read_roots, ...input.cell.write_roots])]
      .map((root) => normalizedRoot(input.workspace, root))
      .sort((left, right) => left.absolute.length - right.absolute.length || left.relative.localeCompare(right.relative));
    const roots = normalizedRoots.filter((root, index) => !normalizedRoots.slice(0, index)
      .some((parent) => contained(parent.absolute, root.absolute)));
    const manifest: Array<Readonly<Record<string, unknown>>> = [];
    let fileCount = 0;
    let byteCount = 0;
    const fileLimit = input.direct ? maximumDirectFiles : maximumFiles;
    const byteLimit = input.direct ? maximumDirectBytes : maximumBytes;
    const visit = (absolute: string, relativePath: string): void => {
      if (fileCount >= fileLimit || byteCount > byteLimit) {
        throw new TypeError("WorkCell baseline exceeds the bounded snapshot budget; narrow its read/write roots");
      }
      if (!existsSync(absolute)) {
        manifest.push({ path_hmac: hmacSha256Hex(input.workspaceSecret, relativePath), kind: "ABSENT" });
        return;
      }
      const entry = lstatSync(absolute);
      if (entry.isSymbolicLink() || !contained(input.workspace, realpathSync(absolute))) {
        throw new TypeError(`Unsafe baseline link at ${relativePath}`);
      }
      if (entry.isDirectory()) {
        manifest.push({ path_hmac: hmacSha256Hex(input.workspaceSecret, relativePath), kind: "DIRECTORY" });
        for (const child of readdirSync(absolute, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name))) {
          if (ignoredDirectories.has(child.name)) continue;
          visit(resolve(absolute, child.name), relativePath === "." ? child.name : `${relativePath}/${child.name}`);
        }
        return;
      }
      if (!entry.isFile()) throw new TypeError(`Unsupported baseline entry at ${relativePath}`);
      fileCount += 1;
      byteCount += entry.size;
      if (fileCount > fileLimit || byteCount > byteLimit) {
        throw new TypeError("WorkCell baseline exceeds the bounded snapshot budget; narrow its read/write roots");
      }
      manifest.push({
        path_hmac: hmacSha256Hex(input.workspaceSecret, relativePath),
        kind: "FILE",
        bytes: entry.size,
        sha256: this.fileHash(absolute, entry),
      });
    };
    for (const root of roots) visit(root.absolute, root.relative);
    const manifestJson = canonicalJson(manifest);
    if (manifestJson.length > maximumManifestChars) {
      throw new TypeError("WorkCell baseline exceeds the authority manifest budget; narrow its read/write roots");
    }
    return sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
      schema_version: 1,
      baseline_id: createId("BASELINE"),
      workspace_id: input.workspaceId,
      goal_id: input.goalId,
      filesystem_identity_hmac: hmacSha256Hex(
        input.workspaceSecret,
        input.workspace.replaceAll("\\", "/").toLowerCase(),
      ),
      content_root_sha256: sha256Hex(manifestJson),
      environment_sha256: canonicalJsonSha256({ node: process.version, platform: process.platform, arch: process.arch }),
      oracle_set_sha256: canonicalJsonSha256(input.cell.oracle),
      scope_manifest: manifest,
      created_at_ms: input.nowMs,
    }, "record_sha256");
  }

  private fileHash(path: string, entry: NonNullable<ReturnType<typeof lstatSync>>): string {
    const stamp = `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.ctimeMs}`;
    const cached = this.hashCache.get(path);
    if (cached?.stamp === stamp) return cached.sha256;
    const value = sha256Hex(readFileSync(path));
    this.hashCache.delete(path);
    this.hashCache.set(path, { stamp, sha256: value });
    while (this.hashCache.size > maximumFiles) this.hashCache.delete(this.hashCache.keys().next().value!);
    return value;
  }
}
