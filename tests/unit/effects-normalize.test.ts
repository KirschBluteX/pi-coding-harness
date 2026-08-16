import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeToolEffect } from "../../src/effects/normalize.js";

const cwd = resolve(".");

function bash(command: string) {
  return normalizeToolEffect({
    toolCallId: `CALL-${command}`,
    toolName: "bash",
    input: { command },
    cwd,
  });
}

describe("tool effect normalization", () => {
  it("treats shell metacharacters inside quoted rg patterns as data", () => {
    expect(bash('rg -n "Validate|ImportTarget" src/example.ts')).toMatchObject({
      effectClass: "READ_ONLY",
      classificationReason: "ALLOWLISTED_LOCAL_PROBE",
    });
    expect(bash("rg -n 'Validate|ImportTarget' src/example.ts")).toMatchObject({
      effectClass: "READ_ONLY",
      classificationReason: "ALLOWLISTED_LOCAL_PROBE",
    });
    expect(bash("rg Validate src/example.ts | cat")).toMatchObject({
      effectClass: "EXTERNAL_UNKNOWN_WRITE",
      classificationReason: "UNCLASSIFIED_SHELL",
    });
  });

  it("allows only-read probes joined by a conditional conjunction", () => {
    expect(bash('git status --short && rg -n "Validate|ImportTarget" src/example.ts')).toMatchObject({
      effectClass: "READ_ONLY",
      classificationReason: "ALLOWLISTED_LOCAL_PROBE",
    });
    expect(bash("git status --short && npm install")).toMatchObject({
      effectClass: "EXTERNAL_UNKNOWN_WRITE",
      classificationReason: "UNCLASSIFIED_SHELL",
    });
    for (const command of [
      "rg token ..",
      "rg token $HOME",
      "rg token ~/secret",
      "find . -delete",
      "rg --pre helper token src",
      "git diff --output=diff.txt",
    ]) {
      expect(bash(command), command).toMatchObject({
        effectClass: "EXTERNAL_UNKNOWN_WRITE",
        classificationReason: "UNCLASSIFIED_SHELL",
      });
    }
  });

  it("allows git describe as a bounded read-only metadata probe", () => {
    expect(bash("git describe --tags --always --dirty")).toMatchObject({
      effectClass: "READ_ONLY",
      classificationReason: "ALLOWLISTED_LOCAL_PROBE",
    });
    for (const command of [
      "git describe --always && npm install",
      "git describe --always > version.txt",
      "git describe --always $(npm install)",
    ]) {
      expect(bash(command), command).toMatchObject({
        effectClass: "EXTERNAL_UNKNOWN_WRITE",
        classificationReason: "UNCLASSIFIED_SHELL",
      });
    }
  });

  it("allows bounded line counts without widening workspace access", () => {
    expect(bash("wc -l internal/terraform/context_plan_import_test.go internal/terraform/context_validate_test.go"))
      .toMatchObject({
        effectClass: "READ_ONLY",
        classificationReason: "ALLOWLISTED_LOCAL_PROBE",
      });
    for (const command of ["wc -l ../outside.go", "wc --files0-from=../paths.txt"]) {
      expect(bash(command), command).toMatchObject({
        effectClass: "EXTERNAL_UNKNOWN_WRITE",
        classificationReason: "UNCLASSIFIED_SHELL",
      });
    }
  });

  it("does not treat PowerShell providers as workspace-local reads", () => {
    for (const command of [
      "Get-Content Env:PCH_HOST_SECRET",
      "Get-ChildItem Env:",
      "Get-Content Variable:HOME",
    ]) {
      expect(bash(command), command).toMatchObject({
        effectClass: "EXTERNAL_UNKNOWN_WRITE",
        classificationReason: "UNCLASSIFIED_SHELL",
      });
    }
  });

  it("keeps allowlisted validation at the reversible-write ceiling", () => {
    expect(bash("npm test")).toMatchObject({
      effectClass: "LOCAL_REVERSIBLE_WRITE",
      classificationReason: "ALLOWLISTED_LOCAL_VALIDATION",
    });
    expect(bash("npx --no-install prettier --write ../outside.js")).toMatchObject({
      effectClass: "EXTERNAL_UNKNOWN_WRITE",
      classificationReason: "UNCLASSIFIED_SHELL",
    });
  });

  it("normalizes a one-file gofmt write to its reversible file target", () => {
    expect(bash("gofmt -w src/example.go")).toMatchObject({
      effectClass: "LOCAL_REVERSIBLE_WRITE",
      classificationReason: "ALLOWLISTED_LOCAL_FORMATTER",
      normalizedTarget: resolve(cwd, "src/example.go").replaceAll("\\", "/"),
      withinWorkspace: true,
    });
    expect(bash("gofmt -w src/a.go src/b.go")).toMatchObject({
      effectClass: "LOCAL_REVERSIBLE_WRITE",
      classificationReason: "ALLOWLISTED_LOCAL_FORMATTER_BATCH",
      normalizedTargets: [
        resolve(cwd, "src/a.go").replaceAll("\\", "/"),
        resolve(cwd, "src/b.go").replaceAll("\\", "/"),
      ],
      withinWorkspace: true,
    });
    expect(bash(`gofmt -w ${Array.from({ length: 8 }, (_, index) => `src/${index}.go`).join(" ")}`))
      .toMatchObject({
        effectClass: "LOCAL_REVERSIBLE_WRITE",
        classificationReason: "ALLOWLISTED_LOCAL_FORMATTER_BATCH",
        normalizedTargets: Array.from({ length: 8 }, (_, index) =>
          resolve(cwd, `src/${index}.go`).replaceAll("\\", "/")),
      });
    expect(bash(`gofmt -w ${Array.from({ length: 9 }, (_, index) => `src/${index}.go`).join(" ")}`))
      .toMatchObject({
        effectClass: "EXTERNAL_UNKNOWN_WRITE",
        classificationReason: "OVERSIZED_LOCAL_FORMATTER_BATCH",
      });
    expect(bash("gofmt -w src/a.go src/b.go && go test ./src")).toMatchObject({
      effectClass: "EXTERNAL_UNKNOWN_WRITE",
      classificationReason: "COMPOSED_LOCAL_FORMATTER",
    });
  });
});
