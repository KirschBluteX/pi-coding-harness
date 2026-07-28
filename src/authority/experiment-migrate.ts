import { resolve } from "node:path";
import type { AuthorityConnection } from "./database.js";
import { applyForwardMigration, type MigrationResult } from "./migrate.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";

export function migrateExperimentStore(
  connection: AuthorityConnection,
  migrationPath = resolve("schemas", "sql", "002_experiments.sql"),
  nowMs = Date.now(),
): MigrationResult {
  const core = connection.prepare("SELECT name FROM schema_migrations WHERE version=1").get() as { name?: unknown } | undefined;
  if (core?.name !== "001_core.sql") throw new AuthorityIntegrityError("Experiment migration requires the verified core migration");
  return applyForwardMigration(connection, 2, migrationPath, nowMs);
}
