import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const legacyMemorySources = [
  "src/memory/engine.ts",
  "src/memory/index-drainer.ts",
  "src/memory/ranking.ts",
  "src/memory/retrieval.ts",
  "src/memory/telemetry.ts",
] as const;

function canonicalPath(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseConfig(name: string): ts.ParsedCommandLine {
  const configPath = resolve(projectRoot, name);
  const readResult = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (readResult.error) {
    throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    projectRoot,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnostics(parsed.errors, {
      getCanonicalFileName: canonicalPath,
      getCurrentDirectory: () => projectRoot,
      getNewLine: () => "\n",
    }));
  }
  return parsed;
}

describe("runtime build surface", () => {
  it("keeps legacy Memory v2 sources in the ordinary TypeScript compile", () => {
    const ordinaryConfig = parseConfig("tsconfig.json");
    const ordinaryRoots = new Set(ordinaryConfig.fileNames.map(canonicalPath));

    expect(legacyMemorySources.filter(
      (source) => !ordinaryRoots.has(canonicalPath(resolve(projectRoot, source))),
    )).toEqual([]);
  });

  it("does not emit production-unreachable legacy Memory v2 modules", () => {
    const runtimeConfig = parseConfig("tsconfig.runtime.json");
    const emitted = new Set<string>();
    const program = ts.createProgram({
      rootNames: runtimeConfig.fileNames,
      options: runtimeConfig.options,
    });
    const result = program.emit(undefined, (fileName) => emitted.add(canonicalPath(fileName)));

    expect(result.emitSkipped).toBe(false);
    expect(legacyMemorySources.filter((source) => {
      const output = source.replace(/^src\//, "dist/").replace(/\.ts$/, ".js");
      return emitted.has(canonicalPath(resolve(projectRoot, output)));
    })).toEqual([]);
  }, 15_000);
});
