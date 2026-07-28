import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("aggregate verification order", () => {
  it("runs isolated performance epochs before I/O-heavy validation", () => {
    const script = readFileSync(resolve("scripts", "verify-project.ps1"), "utf8");
    const performance = script.indexOf("Invoke-Step 'performance'");
    const compile = script.indexOf("Invoke-Step 'compile'");
    const functional = script.indexOf("Invoke-Step 'tests'");
    const lifecycle = script.indexOf("Invoke-Step 'lifecycle'");

    expect(performance).toBeGreaterThan(-1);
    expect(performance).toBeLessThan(compile);
    expect(performance).toBeLessThan(functional);
    expect(performance).toBeLessThan(lifecycle);
  });

  it("schema-validates the provider Cache activation evidence", () => {
    const validator = readFileSync(resolve("scripts", "validate-json.mjs"), "utf8");
    expect(validator).toContain('["manifests/CACHE-PROVIDER-EVIDENCE.json", "cache-provider-evidence"]');
  });

  it("derives aggregate test counts from the Vitest JSON result", () => {
    const script = readFileSync(resolve("scripts", "verify-project.ps1"), "utf8");
    expect(script).toContain("--reporter=json");
    expect(script).toContain("node_modules\\.bin\\vitest.cmd");
    expect(script).not.toMatch(/& npx vitest/u);
    expect(script).toContain("numPassedTests");
    expect(script).not.toMatch(/tests_expected\s*=\s*\[ordered\]@\{\s*passed\s*=\s*\d+/u);
  });
});
