import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { makeExecutionSubjectRef } from "../../src/task-flow/domain.js";
import { EvidenceCatalog, type EvidenceAuthority } from "../../src/input-context/evidence-catalog.js";
import { InputContextMutationGuard } from "../../src/input-context/mutation-guard.js";
import { exactEditPreimageProvesCurrentSource } from "../../src/input-context/runtime.js";
import { InputContextRepository } from "../../src/input-context/repository.js";
import { createGoalCommand, createTestAuthority, type TestAuthority } from "../helpers/authority.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";

const authorities: TestAuthority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.close(); });

function setup() {
  const authority = createTestAuthority({
    memoryMigrations: taskFlowMemoryMigrations,
    taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
    inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
  });
  authorities.push(authority);
  authority.store.transact(createGoalCommand("GOAL-IC-EVIDENCE-001"), {
    expectedVersion: 0, idempotencyKey: "create-evidence-workspace", actor: "USER",
  });
  const workspace = join(authority.directory, "workspace");
  mkdirSync(workspace);
  const connection = openAuthorityConnection({ path: authority.databasePath });
  const repository = new InputContextRepository(connection);
  const artifacts = new ArtifactStore(authority.casPath);
  const catalog = new EvidenceCatalog(repository, artifacts, workspace, "evidence-key", () => authority.clock.now());
  const subject = makeExecutionSubjectRef({
    kind: "NONE", goalId: null, subjectId: null, routeRevision: null,
    goalContractSha256: null, executionAuthorizationSha256: null,
  });
  return { authority, workspace, connection, repository, catalog, subject };
}

describe("Input Context EvidenceCatalog and mutation guard", () => {
  it("captures source expressions that reference credentials without containing credential bytes", () => {
    const fixture = setup();
    try {
      writeFileSync(join(fixture.workspace, "http.js"), "password = config.auth.password || '';\n", "utf8");
      expect(fixture.catalog.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: "http.js",
      })).toMatchObject({ status: "CAPTURED", receipt: expect.any(Object) });
      expect(fixture.repository.verifyIntegrity()).toMatchObject({ readEvidenceReceipts: 1 });
    } finally { closeAuthorityConnection(fixture.connection); }
  }, 15_000);

  it("captures exact current file evidence and rejects a write after external mutation", () => {
    const fixture = setup();
    try {
      writeFileSync(join(fixture.workspace, "source.txt"), "first", "utf8");
      const captured = fixture.catalog.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: "source.txt",
      });
      expect(captured).toMatchObject({ status: "CAPTURED", reused: false });
      expect(captured.receipt).not.toBeNull();
      expect(Buffer.from(fixture.catalog.open(captured.receipt!.receipt_id)).toString("utf8")).toBe("first");
      fixture.authority.clock.advance(1);
      const observedAgain = fixture.catalog.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: "source.txt",
      });
      expect(observedAgain).toMatchObject({ status: "CAPTURED", reused: false });
      expect(observedAgain.receipt!.receipt_id).not.toBe(captured.receipt!.receipt_id);
      expect(fixture.repository.verifyIntegrity()).toMatchObject({ readEvidenceReceipts: 2 });
      const guard = new InputContextMutationGuard(fixture.catalog);
      expect(guard.prepare([captured.receipt!.receipt_id])).toMatchObject({ allow: true, reasonCode: "CURRENT_SOURCE_PROVEN" });
      writeFileSync(join(fixture.workspace, "source.txt"), "second", "utf8");
      expect(guard.prepare([captured.receipt!.receipt_id])).toMatchObject({
        allow: false, reasonCode: "NO_CURRENT_SOURCE_PROOF",
        checks: [{ valid: false, reasonCode: "SOURCE_CHANGED" }],
      });
      expect(fixture.catalog.candidate(captured.receipt!.receipt_id)).toMatchObject({ content_freshness: "STALE" });
    } finally { closeAuthorityConnection(fixture.connection); }
  });

  it("accepts only unique non-overlapping exact edit preimages as current-source proof", () => {
    const fixture = setup();
    try {
      const path = join(fixture.workspace, "source.txt");
      writeFileSync(path, "alpha\nbeta\ngamma\n", "utf8");
      expect(exactEditPreimageProvesCurrentSource(path, {
        edits: [{ oldText: "alpha\n", newText: "one\n" }, { oldText: "gamma\n", newText: "three\n" }],
      })).toBe(true);
      expect(exactEditPreimageProvesCurrentSource(path, {
        edits: [{ oldText: "a", newText: "x" }],
      })).toBe(false);
      expect(exactEditPreimageProvesCurrentSource(path, {
        edits: [{ oldText: "alpha\nbeta", newText: "one" }, { oldText: "beta\ngamma", newText: "two" }],
      })).toBe(false);
      expect(exactEditPreimageProvesCurrentSource(path, {
        edits: [{ oldText: "missing", newText: "x" }],
      })).toBe(false);
    } finally { closeAuthorityConnection(fixture.connection); }
  });

  it("refuses secret-bearing source bytes and rejects workspace escape", () => {
    const fixture = setup();
    try {
      const credential = ["sk", "live", "A".repeat(32)].join("-");
      writeFileSync(join(fixture.workspace, "secret.txt"), `api_key=${credential}`, "utf8");
      expect(fixture.catalog.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: "secret.txt",
      })).toMatchObject({ status: "SECRET_REFUSED", receipt: null });
      writeFileSync(join(fixture.workspace, ".env"), "password=correct-horse-battery-staple\n", "utf8");
      expect(fixture.catalog.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: ".env",
      })).toMatchObject({ status: "SECRET_REFUSED", receipt: null });
      expect(() => fixture.catalog.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: "..",
      })).toThrow("escapes the workspace");
      expect(fixture.repository.verifyIntegrity()).toMatchObject({ readEvidenceReceipts: 0 });
    } finally { closeAuthorityConnection(fixture.connection); }
  });

  it("fails closed after restart when the non-authoritative local path binding is unavailable", () => {
    const fixture = setup();
    try {
      writeFileSync(join(fixture.workspace, "source.txt"), "first", "utf8");
      const captured = fixture.catalog.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: "source.txt",
      });
      const restarted = new EvidenceCatalog(
        fixture.repository, new ArtifactStore(fixture.authority.casPath), fixture.workspace, "evidence-key",
        () => fixture.authority.clock.now(),
      );
      expect(new InputContextMutationGuard(restarted).prepare([captured.receipt!.receipt_id]))
        .toMatchObject({ allow: false, checks: [{ reasonCode: "BINDING_UNAVAILABLE" }] });
      expect(sha256Hex(restarted.open(captured.receipt!.receipt_id))).toBe(captured.receipt!.evidence_sha256);
    } finally { closeAuthorityConnection(fixture.connection); }
  });

  it("treats a crash after CAS write but before receipt commit as a retryable orphan", () => {
    const fixture = setup();
    try {
      writeFileSync(join(fixture.workspace, "source.txt"), "recoverable", "utf8");
      let fail = true;
      const authority: EvidenceAuthority = {
        insertReadEvidenceReceipt: (receipt) => {
          if (fail) { fail = false; throw new Error("simulated receipt commit crash"); }
          return fixture.repository.insertReadEvidenceReceipt(receipt);
        },
        readEvidenceReceipt: (receiptId) => fixture.repository.readEvidenceReceipt(receiptId),
        appendEvidenceValidityTransition: (transition) => fixture.repository.appendEvidenceValidityTransition(transition),
        readEvidenceValidityTransitions: (receiptId) => fixture.repository.readEvidenceValidityTransitions(receiptId),
      };
      const crashing = new EvidenceCatalog(
        authority, new ArtifactStore(fixture.authority.casPath), fixture.workspace, "evidence-key",
        () => fixture.authority.clock.now(),
      );
      expect(() => crashing.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: "source.txt",
      })).toThrow("simulated receipt commit crash");
      expect(fixture.repository.verifyIntegrity()).toMatchObject({ readEvidenceReceipts: 0 });
      const recovered = fixture.catalog.captureFile({
        workspaceId: "WS-TEST-001", subject: fixture.subject, path: "source.txt",
      });
      expect(recovered).toMatchObject({ status: "CAPTURED", reused: false });
      expect(Buffer.from(fixture.catalog.open(recovered.receipt!.receipt_id)).toString("utf8")).toBe("recoverable");
    } finally { closeAuthorityConnection(fixture.connection); }
  });
});
