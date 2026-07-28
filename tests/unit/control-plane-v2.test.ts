import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCurrentControlFrame, assertCurrentControlFrame } from "../../src/control/control-frame.js";
import { evaluateOraclePolicy } from "../../src/effects/oracle-policy.js";
import { ProjectionDeltaLedger, applyProjectionDelta } from "../../src/input-context/projection-delta.js";
import { sha256Hex } from "../../src/foundation/crypto.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("CurrentControlFrame", () => {
  it("changes on authority or tool-surface changes and rejects a stale turn", () => {
    const base = {
      goal_id: "GOAL-1", authority_version: 3, goal_contract_sha256: sha256Hex("contract"),
      route_sha256: sha256Hex("route"), work_cell_id: "CELL-1",
      execution_authorization_sha256: sha256Hex("auth"), lease_generation: 2, fencing_token: 2,
      tool_surface_sha256: sha256Hex("tools-a"),
    } as const;
    const frame = createCurrentControlFrame(base);
    expect(() => assertCurrentControlFrame(frame.control_frame_sha256, frame)).not.toThrow();
    const advanced = createCurrentControlFrame({ ...base, authority_version: 4 });
    expect(() => assertCurrentControlFrame(frame.control_frame_sha256, advanced)).toThrow("PCH_STALE_CONTROL_FRAME");
    expect(createCurrentControlFrame({ ...base, tool_surface_sha256: sha256Hex("tools-b") }).control_frame_sha256)
      .not.toBe(frame.control_frame_sha256);
  });
});

describe("OraclePolicy", () => {
  it("requires a frozen command and rejects external effects in transitive lifecycle scripts", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pch-oracle-")); roots.push(cwd);
    writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ scripts: {
      pretest: "npm run local:prepare", test: "vitest run", posttest: "node scripts/cleanup.mjs",
      "local:prepare": "tsc --noEmit", "test:remote": "npm run remote:prepare && vitest run",
      "remote:prepare": "curl https://example.invalid",
    } }));
    const allowed = evaluateOraclePolicy({ command: "npm test", cwd, declared_commands: ["npm test"] });
    expect(allowed).toMatchObject({
      allow: true, timeout_ms: 120_000, max_output_bytes: 50 * 1024,
      network: "STATIC_EXTERNAL_EFFECT_SCREEN", environment: "PI_INHERITED_NOT_SANDBOXED",
      package_script_graph_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(evaluateOraclePolicy({ command: "npm test", cwd, declared_commands: [] }).reason_code).toBe("ORACLE_NOT_FROZEN");
    expect(evaluateOraclePolicy({ command: "npm run test:remote", cwd, declared_commands: ["npm run test:remote"] }).reason_code)
      .toBe("ORACLE_SCRIPT_EXTERNAL_EFFECT_DENIED");
  });

  it("rejects missing scripts and invalid execution bounds", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pch-oracle-bounds-")); roots.push(cwd);
    writeFileSync(resolve(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(evaluateOraclePolicy({ command: "npm run test:missing", cwd, declared_commands: ["npm run test:missing"] }).reason_code)
      .toBe("ORACLE_SCRIPT_NOT_FOUND");
    expect(evaluateOraclePolicy({ command: "npm test", cwd, declared_commands: ["npm test"], timeout_ms: 999 }).reason_code)
      .toBe("ORACLE_TIMEOUT_INVALID");
    expect(evaluateOraclePolicy({ command: "npm test", cwd, declared_commands: ["npm test"], max_output_bytes: 9_000_000 }).reason_code)
      .toBe("ORACLE_OUTPUT_BOUND_INVALID");
  });

  it("allows bounded local builds while rejecting npm exec and workspace escapes", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pch-oracle-build-")); roots.push(cwd);
    const localBuild = "node_modules/.bin/esbuild src/index.js --bundle --outfile=dist/index.js";
    expect(evaluateOraclePolicy({ command: localBuild, cwd, declared_commands: [localBuild] })).toMatchObject({
      allow: true, reason_code: "ORACLE_POLICY_PASS",
    });
    const npmExec = "npm exec esbuild -- src/index.js --bundle --outfile=dist/index.js";
    expect(evaluateOraclePolicy({ command: npmExec, cwd, declared_commands: [npmExec] })).toMatchObject({
      allow: false, reason_code: "ORACLE_NPM_EXEC_DENIED", message: expect.stringContaining("npm exec may install"),
    });
    const escaping = "node_modules/.bin/esbuild src/index.js --bundle --outfile=../index.js";
    expect(evaluateOraclePolicy({ command: escaping, cwd, declared_commands: [escaping] })).toMatchObject({
      allow: false, reason_code: "ORACLE_BUILD_OUTPUT_OUTSIDE_WORKSPACE",
    });
  });

  it("allows bounded local Go tests and rejects remote packages or execution flags", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "pch-oracle-go-")); roots.push(cwd);
    writeFileSync(resolve(cwd, "go.mod"), "module example.test/project\n\ngo 1.22\n");
    const command = "go test ./internal/terraform -run=^TestContext2Plan_import -count=1 -timeout=30m";
    expect(evaluateOraclePolicy({ command, cwd, declared_commands: [command], timeout_ms: 900_000 })).toMatchObject({
      allow: true, reason_code: "ORACLE_POLICY_PASS",
    });
    const remote = "go test github.com/hashicorp/terraform/internal/terraform -count=1";
    expect(evaluateOraclePolicy({ command: remote, cwd, declared_commands: [remote] })).toMatchObject({
      allow: false, reason_code: "ORACLE_GO_TEST_PACKAGE_DENIED",
    });
    const traversal = "go test ./internal/../outside -count=1";
    expect(evaluateOraclePolicy({ command: traversal, cwd, declared_commands: [traversal] })).toMatchObject({
      allow: false, reason_code: "ORACLE_GO_TEST_PACKAGE_DENIED",
    });
    const wrapper = "go test ./internal/terraform -exec=helper.exe";
    expect(evaluateOraclePolicy({ command: wrapper, cwd, declared_commands: [wrapper] })).toMatchObject({
      allow: false, reason_code: "ORACLE_GO_TEST_ARGUMENT_DENIED",
    });
  });
});

describe("ProjectionDeltaLedger", () => {
  const one = { contentSha256: sha256Hex("one"), role: "user", customType: null };
  const two = { contentSha256: sha256Hex("two"), role: "assistant", customType: null };

  it("sends append-only deltas, rotates on branches, and requests reconcile on root mismatch", () => {
    const bridge = new ProjectionDeltaLedger("session");
    const first = bridge.plan([one]); bridge.commit(first);
    const host = { lineage_id: first.lineage_id, sequence_root: first.new_sequence_root, count: 1 };
    const second = bridge.plan([one, two]);
    expect(second).toMatchObject({ previous_count: 1, new_count: 2, full_reconcile: false });
    expect(second.append).toEqual([two]);
    expect(applyProjectionDelta(host, second).accepted).toBe(true);
    expect(applyProjectionDelta({ ...host, sequence_root: sha256Hex("wrong") }, second).reconcile_required).toBe(true);
    bridge.commit(second);
    expect(bridge.plan([two])).toMatchObject({ previous_count: 0, new_count: 1, full_reconcile: true });
  });
});
