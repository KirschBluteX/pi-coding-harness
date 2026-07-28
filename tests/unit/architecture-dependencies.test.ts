import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(projectRoot, "src");
const foundationRoot = resolve(sourceRoot, "foundation");
const primitives = ["clock", "crypto", "errors", "ids", "validation"] as const;

function canonicalPath(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sourceFiles(): readonly string[] {
  return ts.sys.readDirectory(sourceRoot, [".ts"], undefined, undefined).map((path) => resolve(path));
}

function staticModuleSpecifiers(path: string): readonly string[] {
  const source = ts.sys.readFile(path);
  if (source === undefined) throw new Error(`Unable to read ${path}`);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  for (const statement of file.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function staticRuntimeModuleSpecifiers(path: string): readonly string[] {
  const source = ts.sys.readFile(path);
  if (source === undefined) throw new Error(`Unable to read ${path}`);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return file.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly !== true
      && ts.isStringLiteral(statement.moduleSpecifier)) return [statement.moduleSpecifier.text];
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly !== true
      && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) return [statement.moduleSpecifier.text];
    return [];
  });
}

function resolveLocalModule(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return canonicalPath(resolve(dirname(importer), specifier.replace(/\.js$/u, ".ts")));
}

describe("architecture dependencies", () => {
  it("owns stable primitives in the lowest-level Foundation Module", () => {
    expect(primitives.filter((name) => !existsSync(resolve(foundationRoot, `${name}.ts`)))).toEqual([]);
    expect(primitives.filter((name) => existsSync(resolve(sourceRoot, "runtime", `${name}.ts`)))).toEqual([]);
  });

  it("keeps Foundation independent from domain and runtime orchestration", () => {
    const root = `${canonicalPath(foundationRoot)}/`;
    const offenders = primitives.flatMap((name) => {
      const path = resolve(foundationRoot, `${name}.ts`);
      if (!existsSync(path)) return [];
      return staticModuleSpecifiers(path).flatMap((specifier) => {
        if (specifier.startsWith("node:")) return [];
        const target = resolveLocalModule(path, specifier);
        return target === null || target.startsWith(root) ? [] : [`${relative(projectRoot, path)} -> ${specifier}`];
      });
    });
    expect(offenders).toEqual([]);
  });

  it("forbids legacy primitive seams and repository dependencies on orchestration", () => {
    const runtimeRoot = `${canonicalPath(resolve(sourceRoot, "runtime"))}/`;
    const legacyPrimitive = /(?:^|\/)runtime\/(?:clock|crypto|errors|ids|validation)\.js$/u;
    const offenders = sourceFiles().flatMap((path) => {
      const repository = /(?:^|\/)(?:repository\.ts|repositories\/[^/]+\.ts)$/u.test(canonicalPath(path));
      return staticModuleSpecifiers(path).flatMap((specifier) => {
        if (legacyPrimitive.test(specifier)) return [`${relative(projectRoot, path)} -> ${specifier}`];
        const target = resolveLocalModule(path, specifier);
        return repository && target?.startsWith(runtimeRoot) ? [`${relative(projectRoot, path)} -> ${specifier}`] : [];
      });
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the Multi Worker implementation off the Host startup graph", () => {
    const hostRuntime = resolve(sourceRoot, "harness", "host", "runtime.ts");
    expect(staticRuntimeModuleSpecifiers(hostRuntime)).not.toContain("../worker/executor.js");
  });
});
