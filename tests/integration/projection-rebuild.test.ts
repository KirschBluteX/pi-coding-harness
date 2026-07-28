import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { AuthorityRepository } from "../../src/authority/repositories.js";
import { AuthorityIntegrityError } from "../../src/foundation/errors.js";
import { createGoalCommand, createTestAuthority, type TestAuthority } from "../helpers/authority.js";

const authorities: TestAuthority[] = [];
afterEach(() => {
  for (const authority of authorities.splice(0)) authority.close();
});

describe("projection rebuild and authority integrity", () => {
  it("rebuilds the same snapshot after all rebuildable heads are deleted", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const lease = authority.store.acquireLease(command.goalId, "SESSION-A", 30_000);
    authority.store.transact(
      { type: "APPEND_EVENT", goalId: command.goalId, eventType: "PROGRESS_SNAPSHOTTED", payload: { next: "verify" } },
      { expectedVersion: 1, idempotencyKey: "progress", actor: "AGENT", lease },
    );
    const before = authority.store.readSnapshot(command.goalId);
    const projectionConnection = new DatabaseSync(authority.databasePath, { timeout: 5_000 });
    try { projectionConnection.exec("PRAGMA foreign_keys=ON; DELETE FROM stage_heads; DELETE FROM goal_heads;"); }
    finally { projectionConnection.close(); }
    expect(authority.store.readSnapshot(command.goalId)).toEqual(before);
  });

  it("blocks immutable receipt mutation and detects a deliberately tampered event chain", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const attacker = new DatabaseSync(authority.databasePath, { timeout: 5_000 });
    try {
      expect(() => attacker.exec("UPDATE command_receipts SET result_json='{}'")).toThrow(/immutable/u);
      attacker.exec("DROP TRIGGER no_update_events; UPDATE events SET payload_json='{}' WHERE goal_id='" + command.goalId + "'");
    } finally {
      attacker.close();
    }
    expect(() => authority.store.verifyIntegrity()).toThrow(AuthorityIntegrityError);
  });

  it("rejects command receipt tampering before idempotent reuse", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const attacker = new DatabaseSync(authority.databasePath, { timeout: 5_000 });
    try {
      const row = attacker.prepare("SELECT result_json FROM command_receipts").get() as { result_json: string };
      const result = JSON.parse(row.result_json) as Record<string, unknown>;
      result.eventType = "GOAL_CORRECTED";
      const resultJson = canonicalJson(result);
      attacker.exec("DROP TRIGGER no_update_command_receipts");
      attacker.prepare("UPDATE command_receipts SET result_json=?,result_sha256=?")
        .run(resultJson, canonicalJsonSha256(result));
    } finally {
      attacker.close();
    }
    expect(() => authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" }))
      .toThrow(AuthorityIntegrityError);
    expect(() => authority.store.verifyIntegrity()).toThrow(AuthorityIntegrityError);
  });

  it("keeps authority truth after Markdown and Pi JSONL projections are deleted", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const before = authority.store.readSnapshot(command.goalId);
    const markdown = join(authority.directory, "PROJECT-STATUS.md");
    const jsonl = join(authority.directory, "pi-session.jsonl");
    writeFileSync(markdown, "stale projection", "utf8");
    writeFileSync(jsonl, '{"stale":true}\n', "utf8");
    rmSync(markdown);
    rmSync(jsonl);
    expect(authority.store.readSnapshot(command.goalId)).toEqual(before);
    expect(authority.store.verifyIntegrity()).toEqual({ goalCount: 1, eventCount: 1 });
  });

  it("reads stable store metadata once when rebuilding a multi-event snapshot", () => {
    const authority = createTestAuthority();
    authorities.push(authority);
    const command = createGoalCommand();
    authority.store.transact(command, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
    const lease = authority.store.acquireLease(command.goalId, "SESSION-A", 30_000);
    for (let index = 1; index <= 5; index += 1) {
      authority.store.transact(
        { type: "APPEND_EVENT", goalId: command.goalId, eventType: "PROGRESS_SNAPSHOTTED", payload: { index } },
        { expectedVersion: index, idempotencyKey: `progress-${index}`, actor: "AGENT", lease },
      );
    }
    const connection = new DatabaseSync(authority.databasePath, { readOnly: true, timeout: 5_000 });
    try {
      const repository = new AuthorityRepository(connection);
      const storeMeta = vi.spyOn(repository, "storeMeta");
      expect(repository.events(command.goalId)).toHaveLength(6);
      expect(storeMeta).toHaveBeenCalledTimes(1);
    } finally {
      connection.close();
    }
  });
});
