import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const name of ["window", "document", "navigator", "Element", "HTMLElement", "SVGElement", "Node", "DOMParser"]) {
  const value = name === "window" ? dom.window : name === "document" ? dom.window.document : dom.window[name];
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { default: mermaid } = await import("mermaid");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportArg = process.argv.indexOf("--report");
const reportPath = reportArg >= 0 ? resolve(process.argv[reportArg + 1]) : null;
const failures = [];
const checked = [];
let mermaidCount = 0;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".tmp", "reports", "references"].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
for (const path of walk(root)) {
  const text = readFileSync(path, "utf8");
  const name = relative(root, path).replaceAll("\\", "/");
  checked.push(name);
  const fences = text.match(/^```/gm) ?? [];
  if (fences.length % 2 !== 0) failures.push(`${name}: unbalanced fenced code blocks`);

  const diagramPattern = /```mermaid\s*\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = diagramPattern.exec(text)) !== null) {
    mermaidCount += 1;
    try {
      await mermaid.parse(match[1], { suppressErrors: false });
    } catch (error) {
      failures.push(`${name}: Mermaid ${mermaidCount}: ${error.message}`);
    }
  }

  const linkPattern = /\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g;
  while ((match = linkPattern.exec(text)) !== null) {
    const raw = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
    if (!raw || raw.includes(":")) continue;
    const target = resolve(dirname(path), decodeURIComponent(raw));
    try {
      if (!statSync(target)) failures.push(`${name}: missing link target ${raw}`);
    } catch {
      failures.push(`${name}: missing link target ${raw}`);
    }
  }
}

const report = { status: failures.length ? "FAIL" : "PASS", markdown_files_checked: checked.length, mermaid_diagrams_parsed: mermaidCount, failures };
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, rendered, "utf8");
}
process.stdout.write(rendered);
if (failures.length) process.exitCode = 1;
