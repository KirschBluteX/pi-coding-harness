import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";
import { resolveHarnessRuntimeConfig } from "../../src/config/runtime-resolution.js";
import { ConfigValidationError } from "../../src/foundation/errors.js";

const temporaryDirectories: string[] = [];
const defaultConfigPath = resolve("config", "default.json");

function temporaryConfig(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "pch-config-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function cloneDefault(): Record<string, unknown> {
  return JSON.parse(readFileSync(defaultConfigPath, "utf8")) as Record<string, unknown>;
}

function moduleConfig(config: Record<string, unknown>, name: "memory" | "input_context" | "cache"): Record<string, unknown> {
  return (config.modules as Record<string, Record<string, unknown>>)[name]!;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads the checked default configuration without runtime report dependencies", () => {
    const config = loadConfig(defaultConfigPath);
    expect(config.schema_version).toBe(1);
    expect(config.modules.memory).toMatchObject({
      enabled: true, mode: "EXPERIMENTAL", capture_mode: "GUARDED_AUTO",
      capture_epoch: "MEMORY-V3.1-GUARDED-AUTO-001",
    });
    expect(config.modules.input_context).toMatchObject({ enabled: true, mode: "AUTO_GUARDED" });
    expect(config.modules.cache).toMatchObject({
      enabled: true, arm: "C1_PREFIX",
      provider_integration: "codex-local-openai-responses-positive-usage-v1",
      allow_payload_mutation: false, allow_live_canary: false,
    });
    expect(config.modules.output).toMatchObject({
      enabled: true, history_rewrite_policy: "GENERATION_BOUNDARY_ONLY",
      stable_policy_in_prefix: true, account_tool_call_arguments: true,
    });
    expect(config.performance.target_project.default_mode).toBe("BASELINE_GUARD");
    expect(config.data?.require_local_filesystem).toBe(true);
  });

  it("accepts the default config under the canonical JSON schema", () => {
    const schema = JSON.parse(readFileSync(resolve("schemas", "config.schema.json"), "utf8")) as AnySchema;
    const instance = JSON.parse(readFileSync(defaultConfigPath, "utf8")) as unknown;
    const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validator(instance), JSON.stringify(validator.errors)).toBe(true);
  });

  it("rejects unknown keys and removed activation-report fields", () => {
    const root = cloneDefault();
    root.unknown_feature = true;
    expect(() => loadConfig(temporaryConfig(root))).toThrow(ConfigValidationError);

    for (const [moduleName, key] of [
      ["memory", "promotion_report_sha256"],
      ["memory", "capture_report_sha256"],
      ["memory", "activation_basis"],
      ["input_context", "activation_report_sha256"],
      ["input_context", "activation_basis"],
    ] as const) {
      const config = cloneDefault();
      moduleConfig(config, moduleName)[key] = "a".repeat(64);
      expect(() => loadConfig(temporaryConfig(config))).toThrow(/unknown key/u);
    }
  });

  it("rejects superseded fixed Cache hit-rate promotion fields", () => {
    const config = cloneDefault();
    moduleConfig(config, "cache").promotion_targets = { warm_eligible_request_hit_rate: 0.9 };
    expect(() => loadConfig(temporaryConfig(config))).toThrow(/unknown key/u);
  });

  it.each(["model", "provider", "thinking_level", "contextWindow"])(
    "rejects the runtime override key %s",
    (key) => {
      const config = cloneDefault();
      config[key] = "forbidden";
      expect(() => loadConfig(temporaryConfig(config))).toThrow(/runtime settings come from Pi/u);
    },
  );

  it("rejects invalid bounds and enum values", () => {
    const config = cloneDefault();
    (config.requirements as Record<string, unknown>).max_initial_questions = 9;
    (config.execution as Record<string, unknown>).default_intent = "BUILT";
    expect(() => loadConfig(temporaryConfig(config))).toThrow(ConfigValidationError);
  });

  it("requires enabled and mode to agree for Memory and Input Context", () => {
    const disabledMemory = cloneDefault();
    Object.assign(moduleConfig(disabledMemory, "memory"), { enabled: false, mode: "EXPERIMENTAL" });
    expect(() => loadConfig(temporaryConfig(disabledMemory))).toThrow(/disabled mode must be OFF/u);

    const disabledContext = cloneDefault();
    Object.assign(moduleConfig(disabledContext, "input_context"), { enabled: false, mode: "AUTO_GUARDED" });
    expect(() => loadConfig(temporaryConfig(disabledContext))).toThrow(/disabled mode must be OFF/u);
  });

  it.each([
    ["soft_projection_tokens", 2001, "hard_projection_tokens", 2000, /soft_projection_tokens cannot exceed/u],
    ["max_results", 0, null, null, /max_results must be an integer in \[1, 100\]/u],
    ["max_structured_scan_rows", 50_001, null, null, /max_structured_scan_rows must be an integer in \[100, 50000\]/u],
    ["fallback", "BASELINE", null, null, /fallback must be EMPTY_OPTIONAL_PROJECTION/u],
  ] as const)("rejects invalid Memory contract %s", (key, value, secondKey, secondValue, pattern) => {
    const config = cloneDefault();
    const memory = moduleConfig(config, "memory");
    memory[key] = value;
    if (secondKey) memory[secondKey] = secondValue;
    expect(() => loadConfig(temporaryConfig(config))).toThrow(pattern);
  });

  it("resolves optional modules without reading reports or binding the selected Pi runtime", () => {
    const config = loadConfig(defaultConfigPath);
    const resolved = resolveHarnessRuntimeConfig(defaultConfigPath, config);
    expect(resolved).toMatchObject({
      config, memoryRecallError: null, memoryCaptureError: null, inputContextError: null,
    });
  });

  it("rolls Memory back to OFF as one configuration-only change", () => {
    const config = cloneDefault();
    Object.assign(moduleConfig(config, "memory"), {
      enabled: false, mode: "OFF", epoch: "MEMORY-OFF-ROLLBACK-TEST",
      capture_mode: "MANUAL_CAPTURE", capture_epoch: "MEMORY-CAPTURE-MANUAL-ROLLBACK-TEST",
    });
    expect(loadConfig(temporaryConfig(config)).modules.memory).toMatchObject({
      enabled: false, mode: "OFF", capture_mode: "MANUAL_CAPTURE",
    });
  });
});
