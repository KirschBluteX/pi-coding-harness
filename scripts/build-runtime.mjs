import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "tsconfig.runtime.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root, { noEmitOnError: true }, configPath);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [
  ...(config.error ? [config.error] : []), ...parsed.errors, ...ts.getPreEmitDiagnostics(program),
];
const diagnosticHost = {
  getCanonicalFileName: (path) => path,
  getCurrentDirectory: () => root,
  getNewLine: () => "\n",
};
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));
  process.exitCode = 1;
} else {
  // Clean only this package's known generated directory, after type checking.
  // Deleted source modules must not survive an upgrade as stale executables.
  const output = resolve(root, "dist");
  if (!parsed.options.outDir || resolve(parsed.options.outDir) !== output) throw new Error("Unexpected runtime output directory");
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory())) {
    throw new Error("Refusing to clean a linked or non-directory runtime output");
  }
  rmSync(output, { recursive: true, force: true });
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(emitted.diagnostics, diagnosticHost));
    process.exitCode = 1;
  } else process.stdout.write("PCH runtime built with stale output removed.\n");
}
