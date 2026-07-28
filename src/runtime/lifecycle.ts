import { backup, DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeAuthorityConnection, openAuthorityConnection, type AuthorityConnection } from "../authority/database.js";
import { sqliteWalRuntimeSupport } from "../authority/sqlite-runtime.js";
import { migrateExperimentStore } from "../authority/experiment-migrate.js";
import { migrateMemoryStore } from "../authority/memory-migrate.js";
import {
  assertSupportedMigrationVersion, migrateCoreStore, SUPPORTED_MIGRATION_VERSION, type MigrationResult,
} from "../authority/migrate.js";
import { verifyAuthorityIntegrity } from "../authority/projections.js";
import { migrateInputContextStore } from "../input-context/migrate.js";
import { InputContextRepository } from "../input-context/repository.js";
import { migrateTaskFlowStore } from "../task-flow/migrate.js";
import { TaskFlowRepository } from "../task-flow/repository.js";
import { migrateHarnessStore } from "../harness/migrate.js";
import { migrateHarnessPostStore } from "../harness/post-migrate.js";
import { HarnessRepository } from "../harness/repository.js";
import { HarnessCompactionRepository } from "../context/compaction-v21/repository.js";
import { CacheV2Repository } from "../cache-v2/repository.js";
import { TargetPerformanceRepository } from "../performance/task-flow-repository.js";
import { canonicalJson } from "../authority/canonical-json.js";
import { AuthorityIntegrityError, UnsafePathError } from "../foundation/errors.js";
import { equalSha256, hmacSha256Hex, sha256Hex } from "../foundation/crypto.js";

export type LifecycleOperation = "INSTALL" | "DOCTOR" | "UPGRADE" | "UNINSTALL";
export type LifecycleStatus = "PASS" | "FAIL" | "BLOCKED" | "PLANNED";

const lifecycleMigrationNames = [
  "core", "experiments", "memory", "memory_fts", "memory_claims", "memory_claims_fts",
  "memory_checkpoint", "memory_v3_vault", "memory_v3_lifecycle", "memory_v3_1_capture",
  "task_flow_kernel_v1", "input_context_v1", "coding_harness_v1", "cache_v2",
  "compaction_v2_1", "provider_turn_ledger_v2", "target_performance_receipts",
  "control_plane_v2", "patch_transaction_v1",
] as const;
const installMarkerName = "install.marker.json";

export interface LifecycleOptions {
  readonly packageRoot: string;
  readonly dataRoot: string;
  readonly whatIf?: boolean;
  readonly exportPath?: string;
  readonly deleteData?: boolean;
  readonly operationId?: string;
  readonly now?: () => Date;
  readonly onFault?: (point: "after-backup" | "after-migration") => void;
}

export interface LifecycleAuthorityState {
  readonly path: string;
  migrationVersion: number;
  pendingEffects: number;
  integrity: "PASS" | "FAIL" | "NOT_INITIALIZED";
  backupPath: string | null;
}

export interface LifecycleAction {
  readonly code: string;
  readonly target: string;
  readonly mutation: boolean;
  readonly detail: string;
  readonly status: "PASS" | "FAIL" | "BLOCKED" | "PLANNED" | "SKIPPED";
}

export interface LifecycleManifest {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly operation: LifecycleOperation;
  readonly status: LifecycleStatus;
  readonly what_if: boolean;
  readonly package_root: string;
  readonly data_root: string;
  readonly runtime_supported_migration_version: number;
  readonly started_at: string;
  readonly completed_at: string;
  readonly registration_command: readonly string[] | null;
  readonly actions: readonly LifecycleAction[];
  readonly authorities: readonly LifecycleAuthorityState[];
  readonly failures: readonly string[];
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function normalized(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function contained(path: string, root: string): boolean {
  const delta = relative(resolve(root), resolve(path));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function assertLocalSafePath(path: string): void {
  const absolute = resolve(path);
  if (absolute.startsWith("\\\\")) throw new UnsafePathError(`Lifecycle path must be local: ${absolute}`);
  let cursor = absolute;
  while (true) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new UnsafePathError(`Lifecycle path cannot traverse a symlink or junction: ${absolute}`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    if (existsSync(path)) unlinkSync(path);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve publication failure. */ }
    throw error;
  }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name=?").get(name) as { count?: unknown } | undefined;
  return Number(row?.count ?? 0) === 1;
}

function scalarCount(database: DatabaseSync, sql: string): number {
  return Number((database.prepare(sql).get() as { count?: unknown } | undefined)?.count ?? 0);
}

function pendingEffectCount(database: DatabaseSync): number {
  let count = 0;
  if (tableExists(database, "effects") && tableExists(database, "effect_outcomes")) {
    count += scalarCount(database, `SELECT count(*) AS count FROM effects e
      LEFT JOIN effect_outcomes o ON o.effect_id=e.effect_id WHERE o.effect_id IS NULL`);
  }
  if (tableExists(database, "operation_heads_v1")) {
    count += scalarCount(database, `SELECT count(*) AS count FROM operation_heads_v1
      WHERE state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')`);
  }
  if (tableExists(database, "shard_lease_heads_v1")) {
    count += scalarCount(database, `SELECT count(*) AS count FROM shard_lease_heads_v1
      WHERE worker_run_id IS NOT NULL AND released_at_ms IS NULL`);
  }
  return count;
}

function inspectDatabase(path: string): LifecycleAuthorityState {
  const database = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true });
  try {
    if (!tableExists(database, "schema_migrations")) {
      return { path, migrationVersion: 0, pendingEffects: 0, integrity: "NOT_INITIALIZED", backupPath: null };
    }
    const migrationVersion = assertSupportedMigrationVersion(database);
    const integrity = integrityCheck(database) === "ok"
      ? "PASS" as const : "FAIL" as const;
    return { path, migrationVersion, pendingEffects: pendingEffectCount(database), integrity, backupPath: null };
  } finally { database.close(); }
}

function integrityCheck(database: DatabaseSync): string {
  const value = (database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined)?.integrity_check;
  return typeof value === "string" ? value : "";
}

function authorityPaths(dataRoot: string): string[] {
  const workspaces = join(dataRoot, "workspaces");
  if (!existsSync(workspaces) || !statSync(workspaces).isDirectory()) return [];
  return readdirSync(workspaces, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => resolve(workspaces, entry.name, "authority.sqlite"))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .sort((left, right) => left.localeCompare(right));
}

function validatePackage(packageRoot: string): void {
  if (lifecycleMigrationNames.length !== SUPPORTED_MIGRATION_VERSION) {
    throw new AuthorityIntegrityError("Lifecycle migration filename registry differs from runtime support");
  }
  const required = [
    "package.json", "package-lock.json", "config/default.json", "src/index.ts",
    ...lifecycleMigrationNames.map((name, index) => {
      const prefix = String(index + 1).padStart(3, "0");
      return `schemas/sql/${prefix}_${name}.sql`;
    }),
  ];
  for (const file of required) {
    if (!existsSync(join(packageRoot, file))) throw new AuthorityIntegrityError(`Lifecycle package file is missing: ${file}`);
  }
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  const pi = pkg.pi as { extensions?: unknown } | undefined;
  if (pkg.name !== "pi-coding-harness" || !Array.isArray(pi?.extensions) || !pi.extensions.includes("./src/index.ts")) {
    throw new AuthorityIntegrityError("Lifecycle package manifest is not a Pi Coding Harness package");
  }
}

function installMarkerCore(dataRoot: string) {
  return {
    schema_version: 1 as const,
    product: "pi-coding-harness" as const,
    data_root_sha256: sha256Hex(normalized(dataRoot)),
  };
}

function createInstallKey(dataRoot: string): Uint8Array {
  const keyPath = join(dataRoot, "install.key");
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  if (lstatSync(keyPath).isSymbolicLink() || !lstatSync(keyPath).isFile()) {
    throw new AuthorityIntegrityError("Coding Harness install key is invalid");
  }
  const key = readFileSync(keyPath);
  if (key.byteLength !== 32) throw new AuthorityIntegrityError("Coding Harness install key is invalid");
  return key;
}

function createInstallMarker(dataRoot: string, key: Uint8Array): void {
  const path = join(dataRoot, installMarkerName);
  const core = installMarkerCore(dataRoot);
  const expected = { ...core, key_hmac: hmacSha256Hex(key, canonicalJson(core)) };
  if (!existsSync(path)) writeAtomicJson(path, expected);
  assertOwnedDataRoot(dataRoot);
}

function assertOwnedDataRoot(dataRoot: string): void {
  assertLocalSafePath(dataRoot);
  if (!existsSync(dataRoot) || !lstatSync(dataRoot).isDirectory() || lstatSync(dataRoot).isSymbolicLink()) {
    throw new UnsafePathError("Coding Harness data root is not a local owned directory");
  }
  const keyPath = join(dataRoot, "install.key");
  const markerPath = join(dataRoot, installMarkerName);
  if (!existsSync(keyPath) || !existsSync(markerPath)
    || lstatSync(keyPath).isSymbolicLink() || !lstatSync(keyPath).isFile()
    || lstatSync(markerPath).isSymbolicLink() || !lstatSync(markerPath).isFile()) {
    throw new UnsafePathError("Refusing lifecycle mutation without the Coding Harness ownership marker");
  }
  const key = readFileSync(keyPath);
  if (key.byteLength !== 32) throw new UnsafePathError("Coding Harness ownership key is invalid");
  let marker: Record<string, unknown>;
  try { marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>; }
  catch { throw new UnsafePathError("Coding Harness ownership marker is invalid"); }
  const core = installMarkerCore(dataRoot);
  const keys = Object.keys(marker).sort();
  if (keys.join("\0") !== ["data_root_sha256", "key_hmac", "product", "schema_version"].join("\0")
    || marker.schema_version !== core.schema_version || marker.product !== core.product
    || marker.data_root_sha256 !== core.data_root_sha256 || typeof marker.key_hmac !== "string"
    || !equalSha256(marker.key_hmac, hmacSha256Hex(key, canonicalJson(core)))) {
    throw new UnsafePathError("Coding Harness ownership marker does not bind this data root");
  }
}

function migrationPath(packageRoot: string, name: string): string {
  return join(packageRoot, "schemas", "sql", name);
}

function applyMigrations(path: string, packageRoot: string): readonly MigrationResult[] {
  const connection = openAuthorityConnection({ path });
  try {
    assertSupportedMigrationVersion(connection);
    const results: MigrationResult[] = [
      migrateCoreStore(connection, migrationPath(packageRoot, "001_core.sql")),
      migrateExperimentStore(connection, migrationPath(packageRoot, "002_experiments.sql")),
    ];
    const memory = migrateMemoryStore(connection, {
      structuredPath: migrationPath(packageRoot, "003_memory.sql"),
      ftsPath: migrationPath(packageRoot, "004_memory_fts.sql"),
      claimsPath: migrationPath(packageRoot, "005_memory_claims.sql"),
      claimsFtsPath: migrationPath(packageRoot, "006_memory_claims_fts.sql"),
      checkpointPath: migrationPath(packageRoot, "007_memory_checkpoint.sql"),
      vaultPath: migrationPath(packageRoot, "008_memory_v3_vault.sql"),
      lifecyclePath: migrationPath(packageRoot, "009_memory_v3_lifecycle.sql"),
      captureV31Path: migrationPath(packageRoot, "010_memory_v3_1_capture.sql"),
    });
    results.push(memory.structured, ...(memory.fts ? [memory.fts] : []), memory.claims,
      ...(memory.claimsFts ? [memory.claimsFts] : []), memory.checkpoint, memory.vault, memory.lifecycle, memory.captureV31);
    results.push(migrateTaskFlowStore(connection, migrationPath(packageRoot, "011_task_flow_kernel_v1.sql")));
    results.push(migrateInputContextStore(connection, migrationPath(packageRoot, "012_input_context_v1.sql")));
    results.push(migrateHarnessStore(connection, migrationPath(packageRoot, "013_coding_harness_v1.sql")));
    results.push(...migrateHarnessPostStore(connection, join(packageRoot, "schemas", "sql")));
    verifyMigratedAuthority(connection, path);
    return results;
  } finally { closeAuthorityConnection(connection); }
}

function verifyMigratedAuthority(connection: AuthorityConnection, path: string): void {
  verifyAuthorityIntegrity(connection);
  new TaskFlowRepository(connection).verifyIntegrity();
  new InputContextRepository(connection).verifyIntegrity();
  new HarnessRepository(connection).verifyIntegrity();
  new HarnessCompactionRepository(connection).verifyIntegrity();
  new CacheV2Repository(connection).verifyIntegrity();
  new TargetPerformanceRepository(connection).verifyIntegrity();
  if (integrityCheck(connection) !== "ok") {
    throw new AuthorityIntegrityError(`Authority integrity failed: ${path}`);
  }
}

function verifyCurrentAuthority(path: string): void {
  const connection = openAuthorityConnection({ path });
  try {
    if (assertSupportedMigrationVersion(connection) !== SUPPORTED_MIGRATION_VERSION) {
      throw new AuthorityIntegrityError(`Authority schema is not current: ${path}`);
    }
    verifyMigratedAuthority(connection, path);
  } finally { closeAuthorityConnection(connection); }
}

function backupPath(dataRoot: string, operationId: string, databasePath: string): string {
  return join(dataRoot, "backups", operationId, `${basename(dirname(databasePath))}.authority.sqlite`);
}

async function createBackup(sourcePath: string, destinationPath: string): Promise<void> {
  mkdirSync(dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try { await backup(source, destinationPath); } finally { source.close(); }
  const check = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    if (integrityCheck(check) !== "ok") {
      throw new AuthorityIntegrityError(`Backup integrity failed: ${destinationPath}`);
    }
  } finally { check.close(); }
}

function restoreBackup(databasePath: string, sourceBackup: string, operationId: string): void {
  const failedPath = `${databasePath}.failed-${operationId}`;
  const restorePath = `${databasePath}.restore-${operationId}`;
  copyFileSync(sourceBackup, restorePath);
  renameSync(databasePath, failedPath);
  renameSync(restorePath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(`${databasePath}${suffix}`); } catch { /* Sidecar may not exist. */ }
  }
}

export class LifecycleManager {
  private readonly packageRoot: string;
  private readonly dataRoot: string;
  private readonly now: () => Date;
  private readonly operationId: string;
  private readonly actions: LifecycleAction[] = [];
  private readonly failures: string[] = [];

  constructor(private readonly options: LifecycleOptions) {
    this.packageRoot = resolve(options.packageRoot);
    this.dataRoot = expandHome(options.dataRoot);
    this.now = options.now ?? (() => new Date());
    this.operationId = options.operationId ?? `LIFECYCLE-${this.now().toISOString().replace(/[^0-9]/gu, "")}`;
  }

  async run(operation: LifecycleOperation): Promise<LifecycleManifest> {
    const startedAt = this.now().toISOString();
    let status: LifecycleStatus = this.options.whatIf ? "PLANNED" : "PASS";
    let authorities: LifecycleAuthorityState[] = [];
    try {
      const sqlite = sqliteWalRuntimeSupport();
      this.add("CHECK_SQLITE_RUNTIME", process.version, false,
        `Embedded SQLite ${sqlite.version ?? "unavailable"}; requires ${sqlite.requirement}`, sqlite.safe ? "PASS" : "FAIL");
      if (!sqlite.safe) throw new AuthorityIntegrityError(
        `Embedded SQLite ${sqlite.version ?? "unavailable"} is affected by the WAL-reset corruption risk; ${sqlite.requirement} is required`,
      );
      validatePackage(this.packageRoot);
      assertLocalSafePath(this.packageRoot);
      assertLocalSafePath(this.dataRoot);
      authorities = authorityPaths(this.dataRoot).map(inspectDatabase);
      if (authorities.some((state) => state.integrity === "FAIL")) throw new AuthorityIntegrityError("An authority database failed integrity_check");
      if (operation === "INSTALL") await this.install(authorities);
      else if (operation === "DOCTOR") this.doctor(authorities);
      else if (operation === "UPGRADE") await this.upgrade(authorities);
      else this.uninstall(authorities);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.push(message);
      status = /pending effect|reconcil/iu.test(message) ? "BLOCKED" : "FAIL";
    }
    if (this.actions.some((action) => action.status === "BLOCKED")) status = "BLOCKED";
    if (this.actions.some((action) => action.status === "FAIL")) status = "FAIL";
    return {
      schema_version: 1, operation_id: this.operationId, operation, status,
      what_if: this.options.whatIf ?? false, package_root: this.packageRoot, data_root: this.dataRoot,
      runtime_supported_migration_version: SUPPORTED_MIGRATION_VERSION,
      started_at: startedAt, completed_at: this.now().toISOString(),
      registration_command: operation === "UNINSTALL" ? ["pi", "remove", this.packageRoot]
        : operation === "INSTALL" || operation === "UPGRADE" ? ["pi", "install", this.packageRoot] : null,
      actions: this.actions, authorities, failures: this.failures,
    };
  }

  private add(code: string, target: string, mutation: boolean, detail: string, status: LifecycleAction["status"] = "PASS"): void {
    this.actions.push({ code, target, mutation, detail, status: this.options.whatIf && mutation ? "PLANNED" : status });
  }

  private async install(authorities: LifecycleAuthorityState[]): Promise<void> {
    this.add("VALIDATE_PACKAGE", this.packageRoot, false, "Pi Coding Harness package and migration closure verified");
    if (!this.options.whatIf) {
      mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 });
      accessSync(this.dataRoot, constants.R_OK | constants.W_OK);
      createInstallMarker(this.dataRoot, createInstallKey(this.dataRoot));
    }
    this.add("PREPARE_DATA_ROOT", this.dataRoot, true, "Create private data root and install-key marker");
    if (authorities.length > 0) await this.upgrade(authorities);
    else this.add("REGISTER_LOCAL_PACKAGE", this.packageRoot, true, "Register the verified local package with Pi");
  }

  private doctor(authorities: LifecycleAuthorityState[]): void {
    this.add("VALIDATE_PACKAGE", this.packageRoot, false, "Pi Coding Harness package and migration closure verified");
    if (existsSync(this.dataRoot)) {
      accessSync(this.dataRoot, constants.R_OK | constants.W_OK);
      assertOwnedDataRoot(this.dataRoot);
    }
    this.add("CHECK_DATA_ROOT", this.dataRoot, false, existsSync(this.dataRoot) ? "Data root is readable and writable" : "Data root is not created yet");
    for (const authority of authorities) {
      this.add("CHECK_AUTHORITY", authority.path, false,
        authority.pendingEffects > 0 ? `${authority.pendingEffects} unresolved effects require reconciliation`
          : `schema ${authority.migrationVersion} integrity ${authority.integrity}`,
        authority.pendingEffects > 0 ? "BLOCKED" : authority.integrity === "PASS" ? "PASS" : "FAIL");
    }
  }

  private async upgrade(authorities: LifecycleAuthorityState[]): Promise<void> {
    const pending = authorities.filter((state) => state.pendingEffects > 0);
    if (pending.length > 0) {
      for (const authority of pending) this.add("RECONCILE_PENDING_EFFECTS", authority.path, false, `${authority.pendingEffects} pending effects`, "BLOCKED");
      throw new AuthorityIntegrityError("Upgrade requires pending effect reconciliation before migration");
    }
    for (const authority of authorities) {
      if (authority.migrationVersion === SUPPORTED_MIGRATION_VERSION) {
        if (!this.options.whatIf) verifyCurrentAuthority(authority.path);
        this.add("VERIFY_CURRENT_AUTHORITY", authority.path, false, `Schema ${SUPPORTED_MIGRATION_VERSION} is current and semantically valid`);
        continue;
      }
      const destination = backupPath(this.dataRoot, this.operationId, authority.path);
      authority.backupPath = destination;
      this.add("BACKUP_AUTHORITY", destination, true, `Consistent backup of ${authority.path}`);
      if (this.options.whatIf) {
        this.add("APPLY_FORWARD_MIGRATIONS", authority.path, true, `Apply migrations through ${SUPPORTED_MIGRATION_VERSION}`);
        continue;
      }
      await createBackup(authority.path, destination);
      this.options.onFault?.("after-backup");
      try {
        const migrations = applyMigrations(authority.path, this.packageRoot);
        this.options.onFault?.("after-migration");
        const applied = migrations.filter((result) => result.applied).map((result) => result.version);
        this.add("APPLY_FORWARD_MIGRATIONS", authority.path, true, applied.length ? `Applied versions ${applied.join(",")}` : "Already current");
        Object.assign(authority, inspectDatabase(authority.path), { backupPath: destination });
      } catch (error) {
        restoreBackup(authority.path, destination, this.operationId);
        this.add("RESTORE_AUTHORITY", authority.path, true, "Migration failed; verified backup restored and failed image retained", "FAIL");
        throw error;
      }
    }
    this.add("REGISTER_LOCAL_PACKAGE", this.packageRoot, true, "Refresh Pi local-package registration");
  }

  private uninstall(authorities: LifecycleAuthorityState[]): void {
    const pending = authorities.filter((state) => state.pendingEffects > 0);
    if (pending.length > 0) {
      for (const authority of pending) this.add("RECONCILE_PENDING_EFFECTS", authority.path, false, `${authority.pendingEffects} pending effects`, "BLOCKED");
      throw new AuthorityIntegrityError("Uninstall requires pending effect reconciliation before package removal");
    }
    this.add("UNREGISTER_LOCAL_PACKAGE", this.packageRoot, true, "Remove Pi local-package registration");
    if (this.options.exportPath) {
      const exportPath = resolve(this.options.exportPath);
      assertLocalSafePath(exportPath);
      if (contained(exportPath, this.dataRoot) || contained(this.dataRoot, exportPath)) {
        throw new UnsafePathError("Export path and data root cannot contain one another");
      }
      this.add("EXPORT_DATA", exportPath, true, `Export authority and CAS from ${this.dataRoot}`);
    }
    if (this.options.deleteData) {
      assertOwnedDataRoot(this.dataRoot);
      this.add("DELETE_DATA", this.dataRoot, true, "Explicit data deletion requested");
    } else this.add("PRESERVE_DATA", this.dataRoot, false, "Authority and CAS retained by default", "SKIPPED");
  }
}

function parseCli(argv: readonly string[]): { readonly operation: LifecycleOperation; readonly reportPath: string; readonly options: LifecycleOptions } {
  const operation = argv[0]?.toUpperCase();
  if (!operation || !["INSTALL", "DOCTOR", "UPGRADE", "UNINSTALL"].includes(operation)) {
    throw new TypeError("Lifecycle operation must be INSTALL, DOCTOR, UPGRADE or UNINSTALL");
  }
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new TypeError(`Unexpected lifecycle argument: ${key ?? ""}`);
    if (["--what-if", "--delete-data"].includes(key)) switches.add(key);
    else {
      const value = argv[index + 1];
      if (!value) throw new TypeError(`Missing value for ${key}`);
      values.set(key, value); index += 1;
    }
  }
  const packageRoot = values.get("--package-root");
  const dataRoot = values.get("--data-root");
  const reportPath = values.get("--report");
  if (!packageRoot || !dataRoot || !reportPath) throw new TypeError("--package-root, --data-root and --report are required");
  const exportPath = values.get("--export");
  const operationId = values.get("--operation-id");
  return {
    operation: operation as LifecycleOperation, reportPath: resolve(reportPath),
    options: {
      packageRoot, dataRoot, whatIf: switches.has("--what-if"), deleteData: switches.has("--delete-data"),
      ...(exportPath ? { exportPath } : {}), ...(operationId ? { operationId } : {}),
    },
  };
}

async function main(): Promise<void> {
  try {
    const args = parseCli(process.argv.slice(2));
    const manifest = await new LifecycleManager(args.options).run(args.operation);
    writeAtomicJson(args.reportPath, manifest);
    process.stdout.write(`${canonicalJson(manifest)}\n`);
    if (manifest.status === "FAIL" || manifest.status === "BLOCKED") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? normalized(process.argv[1]) : "";
if (invokedPath === normalized(fileURLToPath(import.meta.url))) await main();
