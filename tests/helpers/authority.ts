import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Clock } from "../../src/foundation/clock.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { createId } from "../../src/foundation/ids.js";
import { AuthorityStore, type AuthorityStoreOptions, type CreateGoalCommand } from "../../src/authority/transactions.js";
import type { MemoryMigrationOptions } from "../../src/authority/memory-migrate.js";

export class TestClock implements Clock {
  constructor(public current = 1_800_000_000_000) {}
  now(): number { return this.current; }
  monotonicNow(): number { return this.current; }
  advance(milliseconds: number): void { this.current += milliseconds; }
}

export interface TestAuthority {
  readonly directory: string;
  readonly databasePath: string;
  readonly casPath: string;
  readonly clock: TestClock;
  readonly store: AuthorityStore;
  close(): void;
}

const templateDatabases = new Map<string, string>();
const templateDirectories: string[] = [];
let templateCleanupRegistered = false;

function canonicalMigrationKey(options: AuthorityStoreOptions): string | null {
  const sql = (...parts: string[]): string => resolve("schemas", "sql", ...parts);
  const same = (actual: string | false | undefined, expected: string): boolean => actual === undefined || actual === false || resolve(actual) === expected;
  if (!same(options.migrationPath, sql("001_core.sql"))
    || !same(options.experimentsMigrationPath, sql("002_experiments.sql"))
    || !same(options.taskFlowMigrationPath, sql("011_task_flow_kernel_v1.sql"))
    || !same(options.inputContextMigrationPath, sql("012_input_context_v1.sql"))
    || !same(options.harnessMigrationPath, sql("013_coding_harness_v1.sql"))) return null;
  const memory = options.memoryMigrations;
  const memoryPaths: readonly (readonly [string | undefined, string])[] = memory ? [
    [memory.structuredPath, "003_memory.sql"], [memory.ftsPath, "004_memory_fts.sql"],
    [memory.claimsPath, "005_memory_claims.sql"], [memory.claimsFtsPath, "006_memory_claims_fts.sql"],
    [memory.checkpointPath, "007_memory_checkpoint.sql"], [memory.vaultPath, "008_memory_v3_vault.sql"],
    [memory.lifecyclePath, "009_memory_v3_lifecycle.sql"], [memory.captureV31Path, "010_memory_v3_1_capture.sql"],
  ] : [];
  if (memoryPaths.some(([path, name]) => !same(path, sql(name)))) return null;
  return JSON.stringify({
    experiments: options.experimentsMigrationPath !== false,
    memory: memory ? memory.forceIndexMode ?? null : false,
    taskFlow: options.taskFlowMigrationPath !== undefined && options.taskFlowMigrationPath !== false,
    inputContext: options.inputContextMigrationPath !== undefined && options.inputContextMigrationPath !== false,
    harness: options.harnessMigrationPath !== undefined && options.harnessMigrationPath !== false,
  });
}

function templateDatabase(options: AuthorityStoreOptions): string | null {
  const key = canonicalMigrationKey(options);
  if (key === null) return null;
  const existing = templateDatabases.get(key);
  if (existing) return existing;
  const directory = mkdtempSync(join(tmpdir(), "pch-authority-template-"));
  const databasePath = join(directory, "authority.sqlite3");
  const store = AuthorityStore.open({ ...options, databasePath });
  store.close();
  templateDatabases.set(key, databasePath);
  templateDirectories.push(directory);
  if (!templateCleanupRegistered) {
    templateCleanupRegistered = true;
    process.once("exit", () => {
      for (const path of templateDirectories) rmSync(path, { recursive: true, force: true });
    });
  }
  return databasePath;
}

export function createTestAuthority(options: {
  readonly baseDirectory?: string;
  readonly memoryMigrations?: MemoryMigrationOptions;
  readonly taskFlowMigrationPath?: string;
  readonly inputContextMigrationPath?: string;
  readonly harnessMigrationPath?: string;
} = {}): TestAuthority {
  const baseDirectory = options.baseDirectory ?? tmpdir();
  mkdirSync(baseDirectory, { recursive: true });
  const directory = mkdtempSync(join(baseDirectory, "pch-authority-test-"));
  const databasePath = join(directory, "authority.sqlite3");
  const clock = new TestClock();
  const openOptions: AuthorityStoreOptions = {
    databasePath, migrationPath: resolve("schemas", "sql", "001_core.sql"), clock,
    ...(options.memoryMigrations ? { memoryMigrations: options.memoryMigrations } : {}),
    ...(options.taskFlowMigrationPath ? { taskFlowMigrationPath: options.taskFlowMigrationPath } : {}),
    ...(options.inputContextMigrationPath ? { inputContextMigrationPath: options.inputContextMigrationPath } : {}),
    ...(options.harnessMigrationPath ? { harnessMigrationPath: options.harnessMigrationPath } : {}),
  };
  const template = options.baseDirectory === undefined ? templateDatabase(openOptions) : null;
  if (template) copyFileSync(template, databasePath);
  const store = AuthorityStore.open(openOptions);
  let closed = false;
  return {
    directory,
    databasePath,
    casPath: join(directory, "cas"),
    clock,
    store,
    close: () => {
      if (!closed) store.close();
      closed = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function createGoalCommand(goalId = createId("GOAL")): CreateGoalCommand {
  return {
    type: "CREATE_GOAL",
    goalId,
    workspace: {
      workspaceId: "WS-TEST-001",
      workspaceHmac: sha256Hex("test-workspace"),
      filesystemKind: "LOCAL_TEST",
      localLockingVerified: true,
    },
    originSessionId: "SESSION-TEST-001",
    objective: "Prove durable authority behavior",
    intent: "PLAN_THEN_BUILD",
    requirementProfile: "TASK_SPEC",
    planningDepth: "STANDARD",
    classification: {
      specificationRoute: "TASK_SPEC",
      reasonCodes: ["MULTI_STEP"],
      confidence: "MEDIUM",
      source: "AUTO_STRUCTURAL",
      facts: {
        requiresPersistentWork: true, objectiveClear: true, filesKnown: false, acceptanceClear: true,
        lowRisk: false, expectedSteps: 2, productOrUserFlow: false, crossModule: false,
        highRework: false, highImpactUnknowns: 0, irreversibleOrSensitive: false,
        semanticAssessment: "UNRESOLVED", structuralComplexity: 2,
      },
      additionalModelRequests: 0,
    },
  };
}
