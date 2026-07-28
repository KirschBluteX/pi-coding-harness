import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { createGoalCommand, createTestAuthority } from "../helpers/authority.js";
import { declaredPerformanceRoot } from "../helpers/performance-root.js";

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function timed<T>(action: () => T): { elapsed: number; value: T } {
  const started = performance.now();
  const value = action();
  return { elapsed: performance.now() - started, value };
}

const enabled = process.env.PCH_PHASE1_PERFORMANCE === "1";

describe.skipIf(!enabled)("Phase 1 performance budgets", () => {
  it("meets warm authority, snapshot, CAS and lease P95 budgets with 100 raw samples", () => {
    const performanceRoot = declaredPerformanceRoot("phase-1");
    const authority = createTestAuthority({ baseDirectory: performanceRoot.epochRoot });
    try {
      const goal = createGoalCommand();
      authority.store.transact(goal, { expectedVersion: 0, idempotencyKey: "create", actor: "USER" });
      let lease = authority.store.acquireLease(goal.goalId, "PERF-SESSION", 3_600_000);
      let version = 1;
      for (let index = 0; index < 10; index += 1) {
        authority.store.transact(
          { type: "APPEND_EVENT", goalId: goal.goalId, eventType: "PROGRESS_SNAPSHOTTED", payload: { index } },
          { expectedVersion: version, idempotencyKey: `warmup-${index}`, actor: "RUNTIME", lease },
        );
        version += 1;
        authority.store.readSnapshot(goal.goalId);
        lease = authority.store.renewLease(lease, 3_600_000, version);
      }

      const eventSamples: number[] = [];
      const eventBeginSamples: number[] = [];
      const eventBodySamples: number[] = [];
      const eventCommitSamples: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        const boundaries: Partial<Record<"before-begin" | "after-begin" | "before-commit" | "after-commit", number>> = {};
        const measurement = timed(() => authority.store.transact(
          { type: "APPEND_EVENT", goalId: goal.goalId, eventType: "PROGRESS_SNAPSHOTTED", payload: { index } },
          { expectedVersion: version, idempotencyKey: `event-${index}`, actor: "RUNTIME", lease },
          (point) => {
            if (point === "before-begin" || point === "after-begin" || point === "before-commit" || point === "after-commit") {
              boundaries[point] = performance.now();
            }
          },
        ));
        eventSamples.push(measurement.elapsed);
        eventBeginSamples.push((boundaries["after-begin"] ?? 0) - (boundaries["before-begin"] ?? 0));
        eventBodySamples.push((boundaries["before-commit"] ?? 0) - (boundaries["after-begin"] ?? 0));
        eventCommitSamples.push((boundaries["after-commit"] ?? 0) - (boundaries["before-commit"] ?? 0));
        version = measurement.value.goalVersion;
      }

      const snapshotSamples = Array.from({ length: 100 }, () => timed(() => authority.store.readSnapshot(goal.goalId)).elapsed);
      const leaseSamples: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        const measurement = timed(() => authority.store.renewLease(lease, 3_600_000, version));
        leaseSamples.push(measurement.elapsed);
        lease = measurement.value;
      }

      const artifactStore = new ArtifactStore(authority.casPath);
      const content = Buffer.alloc(1024 * 1024, 0x5a);
      const casSamples: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        content.writeUInt32LE(index, 0);
        casSamples.push(timed(() => artifactStore.put(content, {
          mediaType: "application/octet-stream",
          classification: "INTERNAL",
          retentionClass: "PERFORMANCE_EPOCH",
        })).elapsed);
      }

      const budgets = {
        single_event_commit_p95_ms: 20,
        snapshot_read_p95_ms: 8,
        cas_1mib_put_p95_ms: 35,
        lease_renew_p95_ms: 8,
      };
      const metrics = {
        single_event_commit_p50_ms: percentile(eventSamples, 0.5),
        single_event_commit_p95_ms: percentile(eventSamples, 0.95),
        single_event_begin_p95_ms: percentile(eventBeginSamples, 0.95),
        single_event_body_p95_ms: percentile(eventBodySamples, 0.95),
        single_event_commit_flush_p95_ms: percentile(eventCommitSamples, 0.95),
        snapshot_read_p50_ms: percentile(snapshotSamples, 0.5),
        snapshot_read_p95_ms: percentile(snapshotSamples, 0.95),
        cas_1mib_put_p50_ms: percentile(casSamples, 0.5),
        cas_1mib_put_p95_ms: percentile(casSamples, 0.95),
        lease_renew_p50_ms: percentile(leaseSamples, 0.5),
        lease_renew_p95_ms: percentile(leaseSamples, 0.95),
        additional_model_requests: 0,
      };
      const status = metrics.single_event_commit_p95_ms <= budgets.single_event_commit_p95_ms
        && metrics.snapshot_read_p95_ms <= budgets.snapshot_read_p95_ms
        && metrics.cas_1mib_put_p95_ms <= budgets.cas_1mib_put_p95_ms
        && metrics.lease_renew_p95_ms <= budgets.lease_renew_p95_ms ? "PASS" : "FAIL";
      const report = {
        schema_version: 1,
        status,
        phase: "PHASE-01",
        epoch: `P1-${Date.now()}`,
        fingerprint: {
          host: hostname(),
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          cpu: cpus()[0]?.model ?? "unknown",
          logical_cpu_count: cpus().length,
          total_memory_bytes: totalmem(),
          authority_data_root: performanceRoot.dataRoot,
          authority_data_root_source: performanceRoot.dataRootSource,
          authority_database_volume_root: parse(authority.databasePath).root,
          source_project_volume_root: parse(resolve(".")).root,
          sqlite_durability: "WAL_SYNCHRONOUS_FULL",
        },
        sample_count_per_metric: 100,
        samples: {
          single_event_commit_ms: eventSamples,
          single_event_begin_ms: eventBeginSamples,
          single_event_body_ms: eventBodySamples,
          single_event_commit_flush_ms: eventCommitSamples,
          snapshot_read_ms: snapshotSamples,
          cas_1mib_put_ms: casSamples,
          lease_renew_ms: leaseSamples,
        },
        metrics,
        budgets,
      };
      const reports = resolve("reports");
      mkdirSync(reports, { recursive: true });
      writeFileSync(resolve(reports, "phase-1-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      expect(status).toBe("PASS");
    } finally {
      authority.close();
    }
  }, 120_000);
});
