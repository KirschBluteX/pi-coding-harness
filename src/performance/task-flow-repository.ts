import type { AuthorityConnection } from "../authority/database.js";
import { runImmediateTransaction } from "../authority/database.js";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import type {
  TargetPerformanceMeasurementRecord, TargetPerformanceVerdictRecord,
} from "./task-flow-measurements.js";
import type { TargetPerformancePhase } from "./task-flow-policy.js";

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  if (typeof row[key] !== "string") throw new AuthorityIntegrityError(`Target performance ${key} is invalid`);
  return row[key];
}
function integer(row: Row, key: string): number {
  if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) throw new AuthorityIntegrityError(`Target performance ${key} is invalid`);
  return Number(row[key]);
}
function decodeMeasurement(row: Row): TargetPerformanceMeasurementRecord {
  const value: TargetPerformanceMeasurementRecord = {
    schema_version: 1, measurement_id: text(row, "measurement_id"), goal_id: text(row, "goal_id"),
    work_cell_id: text(row, "work_cell_id"), performance_contract_sha256: text(row, "performance_contract_sha256"),
    phase: text(row, "phase") as TargetPerformancePhase, operation_id: text(row, "operation_id"),
    command_sha256: text(row, "command_sha256"), output_sha256: text(row, "output_sha256"),
    workload_key: text(row, "workload_key"), metric_key: text(row, "metric_key"), value: Number(row.value),
    unit: text(row, "unit"), environment_sha256: text(row, "environment_sha256"),
    sample_count: integer(row, "sample_count"), created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  const { record_sha256: hash, ...body } = value;
  if (!Number.isFinite(value.value) || canonicalJsonSha256({ domain: "PCH-TARGET-PERFORMANCE-MEASUREMENT-V1", record: body }) !== hash) {
    throw new AuthorityIntegrityError(`Target performance measurement ${value.measurement_id} failed verification`);
  }
  return value;
}
function decodeVerdict(row: Row): TargetPerformanceVerdictRecord {
  const reasons = JSON.parse(text(row, "reasons_json")) as unknown;
  if (!Array.isArray(reasons) || reasons.some((entry) => typeof entry !== "string")) throw new AuthorityIntegrityError("Target performance verdict reasons are invalid");
  const value: TargetPerformanceVerdictRecord = {
    schema_version: 1, verdict_id: text(row, "verdict_id"), goal_id: text(row, "goal_id"),
    work_cell_id: text(row, "work_cell_id"), performance_contract_sha256: text(row, "performance_contract_sha256"),
    phase: text(row, "phase") as TargetPerformancePhase, measurement_root_sha256: text(row, "measurement_root_sha256"),
    baseline_root_sha256: row.baseline_root_sha256 === null ? null : text(row, "baseline_root_sha256"),
    verdict: text(row, "verdict") as "PASS" | "FAIL", reasons,
    created_at_ms: integer(row, "created_at_ms"), record_sha256: text(row, "record_sha256"),
  };
  const { record_sha256: hash, ...body } = value;
  if (canonicalJsonSha256({ domain: "PCH-TARGET-PERFORMANCE-VERDICT-V1", record: body }) !== hash) {
    throw new AuthorityIntegrityError(`Target performance verdict ${value.verdict_id} failed verification`);
  }
  return value;
}

export class TargetPerformanceRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return Number((this.connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name='target_performance_measurements_v1'").get() as Row).count) === 1;
  }

  insertMeasurements(records: readonly TargetPerformanceMeasurementRecord[]): void {
    if (!this.available()) throw new AuthorityIntegrityError("Target performance migration 017 is unavailable");
    runImmediateTransaction(this.connection, () => {
      for (const record of records) {
        const existing = this.connection.prepare("SELECT * FROM target_performance_measurements_v1 WHERE measurement_id=?").get(record.measurement_id) as Row | undefined;
        if (existing) {
          if (decodeMeasurement(existing).record_sha256 !== record.record_sha256) throw new AuthorityIntegrityError("Target performance measurement identity collision");
          continue;
        }
        this.connection.prepare(`INSERT INTO target_performance_measurements_v1(
          measurement_id,goal_id,work_cell_id,performance_contract_sha256,phase,operation_id,command_sha256,
          output_sha256,workload_key,metric_key,value,unit,environment_sha256,sample_count,created_at_ms,record_sha256
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          record.measurement_id, record.goal_id, record.work_cell_id, record.performance_contract_sha256,
          record.phase, record.operation_id, record.command_sha256, record.output_sha256, record.workload_key,
          record.metric_key, record.value, record.unit, record.environment_sha256, record.sample_count,
          record.created_at_ms, record.record_sha256,
        );
      }
    });
  }

  measurements(goalId: string, phase: TargetPerformancePhase): TargetPerformanceMeasurementRecord[] {
    return (this.connection.prepare(`SELECT * FROM target_performance_measurements_v1
      WHERE goal_id=? AND phase=? ORDER BY created_at_ms,measurement_id`).all(goalId, phase) as Row[]).map(decodeMeasurement);
  }

  insertVerdict(record: TargetPerformanceVerdictRecord): void {
    runImmediateTransaction(this.connection, () => {
      const existing = this.connection.prepare("SELECT * FROM target_performance_verdicts_v1 WHERE verdict_id=?").get(record.verdict_id) as Row | undefined;
      if (existing) {
        if (decodeVerdict(existing).record_sha256 !== record.record_sha256) throw new AuthorityIntegrityError("Target performance verdict identity collision");
        return;
      }
      this.connection.prepare(`INSERT INTO target_performance_verdicts_v1(
        verdict_id,goal_id,work_cell_id,performance_contract_sha256,phase,measurement_root_sha256,
        baseline_root_sha256,verdict,reasons_json,created_at_ms,record_sha256
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.verdict_id, record.goal_id, record.work_cell_id, record.performance_contract_sha256,
        record.phase, record.measurement_root_sha256, record.baseline_root_sha256, record.verdict,
        JSON.stringify(record.reasons), record.created_at_ms, record.record_sha256,
      );
    });
  }

  verifyIntegrity(): void {
    if (!this.available()) return;
    for (const row of this.connection.prepare("SELECT * FROM target_performance_measurements_v1").all() as Row[]) decodeMeasurement(row);
    for (const row of this.connection.prepare("SELECT * FROM target_performance_verdicts_v1").all() as Row[]) decodeVerdict(row);
  }
}
