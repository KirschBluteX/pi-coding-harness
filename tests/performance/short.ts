import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import type { CodingHarnessConfig } from "../../src/config/types.js";
import { classifyTaskFlowInput } from "../../src/task-flow/admission.js";

const config = JSON.parse(readFileSync(resolve("config", "default.json"), "utf8")) as CodingHarnessConfig;

export function runShortScenario(): number {
  const started = performance.now();
  const admission = classifyTaskFlowInput("build: update one bounded file and run its local test", config);
  if (admission.action !== "MANAGED" || admission.intent !== "BUILD") {
    throw new TypeError("Short Coding Harness admission failed");
  }
  return performance.now() - started;
}
