import { basename } from "node:path";
import type { EvidenceCaptureKind, QueryCompleteness, RepresentationFidelity } from "./domain.js";

export interface ToolCaptureDescriptor {
  readonly captureKind: EvidenceCaptureKind;
  readonly queryCompleteness: QueryCompleteness;
  readonly representationFidelity: RepresentationFidelity;
  readonly adapterVersion: string;
  readonly path: string | null;
  readonly reusableCurrentSource: boolean;
}

const readTools = new Set(["read", "read_file", "readfile"]);
const searchTools = new Set(["grep", "rg", "search", "find"]);

function stringField(input: Readonly<Record<string, unknown>>, names: readonly string[]): string | null {
  for (const name of names) if (typeof input[name] === "string" && input[name].length > 0) return input[name];
  return null;
}

export function describeToolCapture(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  result: string,
  isError: boolean,
): ToolCaptureDescriptor {
  const normalized = basename(toolName).toLowerCase();
  const truncated = /(?:truncated|output limit|more lines omitted)/iu.test(result);
  if (readTools.has(normalized)) {
    const path = stringField(input, ["path", "file_path", "filePath"]);
    const hasRange = ["offset", "limit", "start", "end", "line_start", "line_end"].some((key) => input[key] !== undefined);
    return {
      captureKind: hasRange ? "LINE_RANGE" : "FULL_FILE",
      queryCompleteness: "NOT_APPLICABLE",
      representationFidelity: isError || truncated || path === null ? "OPAQUE" : "EXACT_DECODED",
      adapterVersion: "pi-builtin-read-v1",
      path,
      reusableCurrentSource: !isError && !truncated && path !== null,
    };
  }
  if (searchTools.has(normalized)) {
    return {
      captureKind: "QUERY_SCOPE", queryCompleteness: isError || truncated ? "PARTIAL" : "COMPLETE",
      representationFidelity: isError || truncated ? "OPAQUE" : "TYPED_EXTRACT",
      adapterVersion: "pi-builtin-query-v1", path: null, reusableCurrentSource: false,
    };
  }
  return {
    captureKind: "TOOL_OUTPUT", queryCompleteness: "NOT_APPLICABLE",
    representationFidelity: "OPAQUE", adapterVersion: "pi-generic-tool-v1",
    path: null, reusableCurrentSource: false,
  };
}
