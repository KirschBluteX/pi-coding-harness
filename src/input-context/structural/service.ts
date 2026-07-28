import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { sha256Hex } from "../../foundation/crypto.js";
import { adaptConfig, adaptLog, adaptMarkdown, adaptTypeScript, adaptUnifiedDiff } from "./adapters.js";
import { sealStructuralResult, type StructuralContextResult, type StructuralFormat } from "./domain.js";
import { StructuralLookupIndex, type StructuralLookupResult } from "./lookup-index.js";

const excludedSegments = new Set([".git", "node_modules", "vendor", "dist", "build", "coverage", ".cache"]);
const generatedHeader = /(?:@generated|generated file|do not edit)/iu;

function portablePath(path: string): string { return path.replace(/\\/gu, "/"); }

function detectFormat(path: string): StructuralFormat {
  const extension = extname(path).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "TYPESCRIPT";
  if (extension === ".md" || extension === ".markdown") return "MARKDOWN";
  if (extension === ".json") return "JSON";
  if (extension === ".yaml" || extension === ".yml") return "YAML";
  if (extension === ".toml") return "TOML";
  if (extension === ".log") return "LOG";
  if (extension === ".diff" || extension === ".patch") return "UNIFIED_DIFF";
  return "UNKNOWN";
}

function unavailable(input: {
  readonly path: string; readonly sha256: string; readonly bytes: number; readonly format: StructuralFormat;
  readonly status: "INSUFFICIENT" | "EXCLUDED"; readonly reason: string;
}): StructuralContextResult {
  return sealStructuralResult({
    schema_version: 1, source_path: input.path, source_sha256: input.sha256, byte_length: input.bytes,
    format: input.format, adapter_version: "pch-structural-router-v1", status: input.status,
    dependency_completeness: "NOT_APPLICABLE", entries: [], dependencies: [], reasons: [input.reason],
  });
}

export class StructuralContextService {
  private readonly cache = new Map<string, StructuralContextResult>();
  private parseCount = 0;
  private hitCount = 0;
  private readonly lookupIndex = new StructuralLookupIndex();

  constructor(private readonly options: {
    readonly workspaceRoot: string;
    readonly maxFileBytes?: number;
    readonly maxEntries?: number;
    readonly maxRepoMapFiles?: number;
  }) {}

  metrics(): { readonly parses: number; readonly cacheHits: number; readonly cached: number } {
    return { parses: this.parseCount, cacheHits: this.hitCount, cached: this.cache.size };
  }

  async extractFile(path: string, signal?: AbortSignal): Promise<StructuralContextResult> {
    signal?.throwIfAborted();
    const root = await realpath(resolve(this.options.workspaceRoot));
    const absolute = resolve(root, path);
    const relation = relative(root, absolute);
    if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
      return unavailable({ path: portablePath(relation || "."), sha256: sha256Hex(""), bytes: 0, format: detectFormat(path), status: "INSUFFICIENT", reason: "PATH_OUTSIDE_WORKSPACE" });
    }
    const normalizedRelation = portablePath(relation);
    const relationSegments = normalizedRelation.toLowerCase().split("/");
    if (relationSegments.some((segment) => excludedSegments.has(segment))) return unavailable({
      path: normalizedRelation, sha256: sha256Hex(""), bytes: 0, format: detectFormat(path), status: "EXCLUDED", reason: "VENDOR_OR_BUILD_PATH",
    });
    let metadata;
    try { metadata = await lstat(absolute); }
    catch { return unavailable({ path: normalizedRelation, sha256: sha256Hex(""), bytes: 0, format: detectFormat(path), status: "INSUFFICIENT", reason: "SOURCE_MISSING_OR_UNREADABLE" }); }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return unavailable({ path: normalizedRelation, sha256: sha256Hex(""), bytes: 0, format: detectFormat(path), status: "INSUFFICIENT", reason: metadata.isSymbolicLink() ? "SYMLINK_REFUSED" : "NOT_A_FILE" });
    }
    const maxBytes = this.options.maxFileBytes ?? 2_097_152;
    if (metadata.size > maxBytes) return unavailable({
      path: normalizedRelation, sha256: sha256Hex(""), bytes: metadata.size, format: detectFormat(path), status: "INSUFFICIENT", reason: "FILE_BUDGET_EXCEEDED",
    });
    const canonical = await realpath(absolute);
    const canonicalRelation = relative(root, canonical);
    if (canonicalRelation.startsWith("..") || isAbsolute(canonicalRelation)) {
      return unavailable({ path: normalizedRelation, sha256: sha256Hex(""), bytes: 0, format: detectFormat(path), status: "INSUFFICIENT", reason: "REALPATH_OUTSIDE_WORKSPACE" });
    }
    let bytes: Uint8Array;
    try { bytes = await readFile(canonical); }
    catch { return unavailable({ path: normalizedRelation, sha256: sha256Hex(""), bytes: metadata.size, format: detectFormat(path), status: "INSUFFICIENT", reason: "SOURCE_MISSING_OR_UNREADABLE" }); }
    signal?.throwIfAborted();
    return this.extractBytes(normalizedRelation, bytes);
  }

  async extractBytes(sourcePath: string, bytes: Uint8Array): Promise<StructuralContextResult> {
    const normalizedPath = portablePath(sourcePath);
    const hash = sha256Hex(bytes);
    const format = detectFormat(normalizedPath);
    const maxBytes = this.options.maxFileBytes ?? 2_097_152;
    if (bytes.byteLength > maxBytes) return unavailable({
      path: normalizedPath, sha256: hash, bytes: bytes.byteLength, format, status: "INSUFFICIENT", reason: "FILE_BUDGET_EXCEEDED",
    });
    const segments = normalizedPath.toLowerCase().split("/");
    if (segments.some((segment) => excludedSegments.has(segment))) return unavailable({
      path: normalizedPath, sha256: hash, bytes: bytes.byteLength, format, status: "EXCLUDED", reason: "VENDOR_OR_BUILD_PATH",
    });
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return unavailable({ path: normalizedPath, sha256: hash, bytes: bytes.byteLength, format, status: "INSUFFICIENT", reason: "NON_UTF8_SOURCE" }); }
    if (generatedHeader.test(source.slice(0, 1_024))) return unavailable({
      path: normalizedPath, sha256: hash, bytes: bytes.byteLength, format, status: "EXCLUDED", reason: "GENERATED_SOURCE",
    });
    if (format === "UNKNOWN") return unavailable({
      path: normalizedPath, sha256: hash, bytes: bytes.byteLength, format, status: "INSUFFICIENT", reason: "UNSUPPORTED_FORMAT",
    });
    const key = `${normalizedPath}:${format}:${hash}:${this.options.maxEntries ?? 256}`;
    const cached = this.cache.get(key);
    if (cached) { this.hitCount += 1; return cached; }
    this.parseCount += 1;
    const input = {
      sourcePath: normalizedPath, source, sourceSha256: hash, byteLength: bytes.byteLength,
      maxEntries: this.options.maxEntries ?? 256,
    };
    const result = format === "TYPESCRIPT" ? await adaptTypeScript(input)
      : format === "MARKDOWN" ? await adaptMarkdown(input)
        : format === "JSON" || format === "YAML" || format === "TOML" ? await adaptConfig(input, format)
          : format === "LOG" ? adaptLog(input) : adaptUnifiedDiff(input);
    this.cache.set(key, result);
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  async repoMap(paths: readonly string[], signal?: AbortSignal): Promise<readonly StructuralContextResult[]> {
    const limit = this.options.maxRepoMapFiles ?? 64;
    if (paths.length > limit) throw new RangeError(`Structural repo map exceeds ${limit} explicit files`);
    const results: StructuralContextResult[] = [];
    for (const path of [...new Set(paths)].sort()) {
      signal?.throwIfAborted();
      results.push(await this.extractFile(path, signal));
    }
    this.lookupIndex.rebuild(results.filter((result) => result.status === "COMPLETE" || result.status === "PARTIAL"));
    return results;
  }

  lookup(query: string, limit = 20): StructuralLookupResult { return this.lookupIndex.lookup(query, limit); }
  clearIndex(): void { this.lookupIndex.clear(); }
}
