import { sha256Hex } from "../../foundation/crypto.js";
import type { Node as TypeScriptNode } from "typescript";
import { sealStructuralResult, type StructuralContextResult, type StructuralDependency, type StructuralEntry, type StructuralFormat } from "./domain.js";

export interface StructuralAdapterInput {
  readonly sourcePath: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly byteLength: number;
  readonly maxEntries: number;
}

function boundedExcerpt(value: string, maxBytes = 512): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes - 3) break;
    result += character;
  }
  return `${result}...`;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle;
  }
  return low + 1;
}

function entryFromOffsets(
  input: StructuralAdapterInput,
  starts: readonly number[],
  kind: string,
  name: string,
  start: number,
  end: number,
): StructuralEntry {
  const slice = input.source.slice(start, end);
  return {
    kind,
    name,
    start_line: lineAt(starts, start),
    end_line: lineAt(starts, Math.max(start, end - 1)),
    excerpt: boundedExcerpt(slice.trim()),
    source_slice_sha256: sha256Hex(slice),
  };
}

function finish(input: StructuralAdapterInput, options: {
  readonly format: StructuralFormat;
  readonly version: string;
  readonly entries: readonly StructuralEntry[];
  readonly dependencies?: readonly StructuralDependency[];
  readonly reasons?: readonly string[];
  readonly insufficient?: boolean;
  readonly dependenciesApplicable?: boolean;
}): StructuralContextResult {
  const reasons = [...new Set(options.reasons ?? [])].sort();
  const truncated = options.entries.length > input.maxEntries;
  const entries = options.entries.slice(0, input.maxEntries);
  if (truncated) reasons.push("ENTRY_LIMIT");
  const dependencies = options.dependencies ?? [];
  const dynamic = dependencies.some((entry) => entry.dynamic || entry.specifier === null);
  if (dynamic) reasons.push("DYNAMIC_DEPENDENCY");
  const uniqueReasons = [...new Set(reasons)].sort();
  return sealStructuralResult({
    schema_version: 1,
    source_path: input.sourcePath,
    source_sha256: input.sourceSha256,
    byte_length: input.byteLength,
    format: options.format,
    adapter_version: options.version,
    status: options.insufficient ? "INSUFFICIENT" : uniqueReasons.length > 0 ? "PARTIAL" : "COMPLETE",
    dependency_completeness: options.dependenciesApplicable === false ? "NOT_APPLICABLE"
      : dynamic ? "PARTIAL" : "COMPLETE",
    entries,
    dependencies,
    reasons: uniqueReasons,
  });
}

function nodeName(node: { readonly name?: { getText(): string } }): string {
  return node.name?.getText() ?? "<anonymous>";
}

export async function adaptTypeScript(input: StructuralAdapterInput): Promise<StructuralContextResult> {
  const ts = await import("typescript");
  const extension = input.sourcePath.toLowerCase();
  const scriptKind = extension.endsWith(".tsx") ? ts.ScriptKind.TSX
    : extension.endsWith(".jsx") ? ts.ScriptKind.JSX
      : extension.endsWith(".js") || extension.endsWith(".mjs") || extension.endsWith(".cjs")
        ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(input.sourcePath, input.source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = (sourceFile as unknown as { readonly parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return finish(input, {
    format: "TYPESCRIPT", version: `typescript-${ts.version}`, entries: [], reasons: ["PARSE_ERROR"], insufficient: true,
  });
  const starts = lineStarts(input.source);
  const entries: StructuralEntry[] = [];
  const dependencies: StructuralDependency[] = [];
  const pushNode = (kind: string, name: string, node: { getStart(): number; getEnd(): number }): void => {
    entries.push(entryFromOffsets(input, starts, kind, name, node.getStart(), node.getEnd()));
  };
  const visit = (node: TypeScriptNode, owner: string | null): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      dependencies.push({ kind: "IMPORT", specifier, line: lineAt(starts, node.getStart()), dynamic: specifier === null });
      pushNode("import", specifier ?? "<dynamic>", node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      dependencies.push({ kind: "EXPORT", specifier, line: lineAt(starts, node.getStart()), dynamic: specifier === null });
      pushNode("export", specifier ?? "<dynamic>", node);
    } else if (ts.isCallExpression(node)
      && ((node.expression.kind === ts.SyntaxKind.ImportKeyword)
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      const specifier = argument && ts.isStringLiteralLike(argument) ? argument.text : null;
      dependencies.push({
        kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? "IMPORT" : "REQUIRE",
        specifier,
        line: lineAt(starts, node.getStart()),
        dynamic: specifier === null,
      });
    } else if (ts.isFunctionDeclaration(node)) pushNode("function", nodeName(node), node);
    else if (ts.isClassDeclaration(node)) pushNode("class", nodeName(node), node);
    else if (ts.isInterfaceDeclaration(node)) pushNode("interface", nodeName(node), node);
    else if (ts.isTypeAliasDeclaration(node)) pushNode("type", nodeName(node), node);
    else if (ts.isEnumDeclaration(node)) pushNode("enum", nodeName(node), node);
    else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      pushNode("method", `${owner ?? "<anonymous>"}.${nodeName(node)}`, node);
    } else if (ts.isVariableStatement(node) && node.parent === sourceFile) {
      for (const declaration of node.declarationList.declarations) pushNode("variable", declaration.name.getText(), declaration);
    }
    const nextOwner = ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ? nodeName(node) : owner;
    ts.forEachChild(node, (child) => visit(child, nextOwner));
  };
  visit(sourceFile, null);
  return finish(input, { format: "TYPESCRIPT", version: `typescript-${ts.version}`, entries, dependencies });
}

function mdText(node: Record<string, unknown>): string {
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child) => typeof child === "object" && child !== null ? mdText(child as Record<string, unknown>) : "").join("");
}

export async function adaptMarkdown(input: StructuralAdapterInput): Promise<StructuralContextResult> {
  try {
    const { fromMarkdown } = await import("mdast-util-from-markdown");
    const tree = fromMarkdown(input.source) as unknown as { readonly children?: readonly Record<string, unknown>[] };
    const children = tree.children ?? [];
    const entries: StructuralEntry[] = [];
    const dependencies: StructuralDependency[] = [];
    const headings = children.filter((node) => node.type === "heading");
    for (let index = 0; index < headings.length; index += 1) {
      const node = headings[index]!;
      const position = node.position as { start?: { line?: number }; end?: { line?: number } } | undefined;
      const next = headings[index + 1]?.position as { start?: { line?: number } } | undefined;
      const start = position?.start?.line ?? 1;
      const end = next?.start?.line ? next.start.line - 1 : input.source.split("\n").length;
      const excerpt = mdText(node);
      entries.push({
        kind: `heading-${typeof node.depth === "number" ? String(node.depth) : "unknown"}`, name: excerpt, start_line: start, end_line: end,
        excerpt: boundedExcerpt(excerpt), source_slice_sha256: null,
      });
    }
    const walk = (node: Record<string, unknown>): void => {
      const position = node.position as { start?: { line?: number }; end?: { line?: number } } | undefined;
      if (node.type === "code") entries.push({
        kind: "code", name: typeof node.lang === "string" ? node.lang : "plain",
        start_line: position?.start?.line ?? 1, end_line: position?.end?.line ?? position?.start?.line ?? 1,
        excerpt: boundedExcerpt(typeof node.value === "string" ? node.value : ""), source_slice_sha256: null,
      });
      if (node.type === "link" || node.type === "definition") dependencies.push({
        kind: "LINK", specifier: typeof node.url === "string" ? node.url : null,
        line: position?.start?.line ?? 1, dynamic: typeof node.url !== "string",
      });
      if (Array.isArray(node.children)) for (const child of node.children) {
        if (typeof child === "object" && child !== null) walk(child as Record<string, unknown>);
      }
    };
    for (const child of children) walk(child);
    return finish(input, { format: "MARKDOWN", version: "mdast-from-markdown-2", entries, dependencies });
  } catch {
    return finish(input, { format: "MARKDOWN", version: "mdast-from-markdown-2", entries: [], reasons: ["PARSE_ERROR"], insufficient: true });
  }
}

function configEntries(value: unknown, maxEntries: number): StructuralEntry[] {
  const entries: StructuralEntry[] = [];
  const visit = (current: unknown, path: string, depth: number): void => {
    if (entries.length > maxEntries || depth > 32) return;
    if (Array.isArray(current)) {
      entries.push({ kind: "array", name: path || "$", start_line: 1, end_line: 1, excerpt: `[${current.length} items]`, source_slice_sha256: null });
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
    } else if (typeof current === "object" && current !== null) {
      entries.push({ kind: "object", name: path || "$", start_line: 1, end_line: 1, excerpt: null, source_slice_sha256: null });
      for (const [key, entry] of Object.entries(current)) visit(entry, path ? `${path}.${key}` : key, depth + 1);
    } else {
      const encoded = JSON.stringify(current);
      entries.push({ kind: "value", name: path || "$", start_line: 1, end_line: 1, excerpt: boundedExcerpt(encoded ?? String(current)), source_slice_sha256: null });
    }
  };
  visit(value, "", 0);
  return entries;
}

export async function adaptConfig(input: StructuralAdapterInput, format: "JSON" | "YAML" | "TOML"): Promise<StructuralContextResult> {
  try {
    let value: unknown;
    let version: string;
    if (format === "JSON") {
      value = JSON.parse(input.source) as unknown;
      version = "json-es2023";
    } else if (format === "YAML") {
      const yaml = await import("yaml");
      const document = yaml.parseDocument(input.source, { prettyErrors: false });
      if (document.errors.length > 0) throw new TypeError("YAML parse failed");
      value = document.toJS({ maxAliasCount: 100 });
      version = "yaml-2";
    } else {
      const toml = await import("smol-toml");
      value = toml.parse(input.source);
      version = "smol-toml-1";
    }
    return finish(input, {
      format, version, entries: configEntries(value, input.maxEntries), dependenciesApplicable: false,
    });
  } catch {
    return finish(input, {
      format, version: format === "JSON" ? "json-es2023" : format === "YAML" ? "yaml-2" : "smol-toml-1",
      entries: [], reasons: ["PARSE_ERROR"], insufficient: true, dependenciesApplicable: false,
    });
  }
}

export function adaptLog(input: StructuralAdapterInput): StructuralContextResult {
  const signatures = new Map<string, { count: number; first: number; last: number; excerpt: string }>();
  const lines = input.source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/\b(?:error|fatal|panic|exception|traceback|warn(?:ing)?)\b/iu.test(line)) continue;
    const signature = line.toLowerCase()
      .replace(/\b[0-9a-f]{8,}\b/giu, "<id>")
      .replace(/\b\d+(?:\.\d+)?\b/gu, "<n>")
      .replace(/\s+/gu, " ").trim();
    const current = signatures.get(signature);
    if (current) { current.count += 1; current.last = index + 1; }
    else signatures.set(signature, { count: 1, first: index + 1, last: index + 1, excerpt: line });
  }
  const entries = [...signatures.entries()].map(([signature, value]): StructuralEntry => ({
    kind: "log-signature", name: signature, start_line: value.first, end_line: value.last,
    excerpt: boundedExcerpt(`${value.excerpt} [count=${value.count}]`), source_slice_sha256: null,
  }));
  return finish(input, { format: "LOG", version: "pch-log-v1", entries, dependenciesApplicable: false });
}

export function adaptUnifiedDiff(input: StructuralAdapterInput): StructuralContextResult {
  const lines = input.source.split("\n");
  const entries: StructuralEntry[] = [];
  const reasons: string[] = [];
  let sawFile = false;
  let sawHunk = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("Binary files ")) { reasons.push("BINARY_DIFF"); continue; }
    if (!lines[index]!.startsWith("--- ")) continue;
    const next = lines[index + 1];
    if (!next?.startsWith("+++ ")) { reasons.push("MALFORMED_FILE_HEADER"); continue; }
    sawFile = true;
    entries.push({
      kind: "diff-file", name: `${lines[index]!.slice(4)} -> ${next.slice(4)}`,
      start_line: index + 1, end_line: index + 2, excerpt: boundedExcerpt(`${lines[index]}\n${next}`),
      source_slice_sha256: sha256Hex(`${lines[index]}\n${next}`),
    });
    index += 1;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(lines[index]!);
    if (!match) continue;
    sawHunk = true;
    const oldExpected = match[2] === undefined ? 1 : Number(match[2]);
    const newExpected = match[4] === undefined ? 1 : Number(match[4]);
    let oldActual = 0;
    let newActual = 0;
    let end = index + 1;
    while (end < lines.length && !lines[end]!.startsWith("@@ ") && !lines[end]!.startsWith("diff --git ")
      && !lines[end]!.startsWith("--- ")) {
      const prefix = lines[end]![0];
      if (prefix === " " || prefix === "-") oldActual += 1;
      if (prefix === " " || prefix === "+") newActual += 1;
      if (prefix !== " " && prefix !== "-" && prefix !== "+" && prefix !== "\\" && lines[end] !== "") reasons.push("MALFORMED_HUNK_LINE");
      end += 1;
    }
    if (oldActual !== oldExpected || newActual !== newExpected) reasons.push("HUNK_COUNT_MISMATCH");
    entries.push({
      kind: "diff-hunk", name: (match[5] ?? "").trim() || `${match[1]}:${match[3]}`,
      start_line: index + 1, end_line: end, excerpt: boundedExcerpt(lines[index]!),
      source_slice_sha256: sha256Hex(lines.slice(index, end).join("\n")),
    });
  }
  if (!sawFile || !sawHunk) reasons.push("INCOMPLETE_DIFF");
  return finish(input, {
    format: "UNIFIED_DIFF", version: "pch-unified-diff-v1", entries, reasons,
    insufficient: reasons.length > 0, dependenciesApplicable: false,
  });
}
