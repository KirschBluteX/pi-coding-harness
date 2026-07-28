import { canonicalJsonSha256 } from "../../authority/canonical-json.js";

export type StructuralFormat = "TYPESCRIPT" | "MARKDOWN" | "JSON" | "YAML" | "TOML" | "LOG" | "UNIFIED_DIFF" | "UNKNOWN";
export type StructuralStatus = "COMPLETE" | "PARTIAL" | "INSUFFICIENT" | "EXCLUDED";

export interface StructuralEntry {
  readonly kind: string;
  readonly name: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly excerpt: string | null;
  readonly source_slice_sha256: string | null;
}

export interface StructuralDependency {
  readonly kind: "IMPORT" | "EXPORT" | "REQUIRE" | "LINK";
  readonly specifier: string | null;
  readonly line: number;
  readonly dynamic: boolean;
}

export interface StructuralContextResult {
  readonly schema_version: 1;
  readonly source_path: string;
  readonly source_sha256: string;
  readonly byte_length: number;
  readonly format: StructuralFormat;
  readonly adapter_version: string;
  readonly status: StructuralStatus;
  readonly dependency_completeness: "COMPLETE" | "PARTIAL" | "NOT_APPLICABLE";
  readonly entries: readonly StructuralEntry[];
  readonly dependencies: readonly StructuralDependency[];
  readonly reasons: readonly string[];
  readonly record_sha256: string;
}

export type StructuralResultBody = Omit<StructuralContextResult, "record_sha256">;

export function sealStructuralResult(body: StructuralResultBody): StructuralContextResult {
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-STRUCTURAL-CONTEXT-V1", body }),
  };
}
