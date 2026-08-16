import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuthorityIntegrityError, UnsafePathError } from "../foundation/errors.js";

export interface AuthorityDatabaseOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly readOnly?: boolean;
}

export type AuthorityConnection = DatabaseSync;

function normalizedPath(path: string): string {
  const value = resolve(path).replaceAll("/", "\\");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function openAuthorityConnection(options: AuthorityDatabaseOptions): AuthorityConnection {
  const databasePath = options.path === ":memory:" ? options.path : resolve(options.path);
  if (databasePath !== ":memory:") {
    if (databasePath.startsWith("\\\\")) throw new UnsafePathError("Authority database cannot use a UNC path");
    const directory = dirname(databasePath);
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()
      || normalizedPath(realpathSync(directory)) !== normalizedPath(directory)) {
      throw new UnsafePathError("Authority database directory resolves through a symlink or junction");
    }
    if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
      throw new UnsafePathError("Authority database cannot be a symlink");
    }
  }
  let connection: DatabaseSync | undefined;
  try {
    connection = new DatabaseSync(databasePath, {
      readOnly: options.readOnly ?? false,
      timeout: options.busyTimeoutMs ?? 5_000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    connection.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;");
    if (!options.readOnly) {
      const journal = connection.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode?: unknown } | undefined;
      const journalMode = journal?.journal_mode;
      if (databasePath !== ":memory:" && (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal")) {
        throw new AuthorityIntegrityError("Authority database failed to enter WAL mode");
      }
    }
    return connection;
  } catch (error) {
    if (connection) {
      try { connection.close(); } catch { /* Preserve the initialization failure. */ }
    }
    const rollbackJournalPathLength = databasePath.length + "-journal".length + 1;
    const sqliteCode = error instanceof Error
      ? (error as Error & { code?: unknown }).code
      : undefined;
    if (process.platform === "win32"
      && databasePath !== ":memory:"
      && rollbackJournalPathLength > 260
      && sqliteCode === "ERR_SQLITE_ERROR"
      && error instanceof Error
      && /unable to open database file/u.test(error.message.toLowerCase())) {
      throw new UnsafePathError(
        `Authority database path length ${databasePath.length} cannot safely accommodate SQLite WAL sidecars on Windows; shorten the configured data root or user-home path`,
      );
    }
    throw error;
  }
}

export function closeAuthorityConnection(connection: AuthorityConnection): void {
  try {
    connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch {
    // Read-only handles and crash tests may not own a writable WAL checkpoint.
  } finally {
    connection.close();
  }
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "ERR_SQLITE_ERROR" && /busy|locked/u.test(error.message.toLowerCase());
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function runImmediateTransaction<T>(
  connection: AuthorityConnection,
  action: () => T,
  options: { readonly retryBudgetMs?: number } = {},
): T {
  const budget = options.retryBudgetMs ?? 50;
  const started = performance.now();
  let delay = 1;
  while (true) {
    try {
      connection.exec("BEGIN IMMEDIATE");
      break;
    } catch (error) {
      if (!isBusyError(error) || performance.now() - started + delay > budget) throw error;
      sleepSync(delay);
      delay = Math.min(delay * 2, 16);
    }
  }
  try {
    const result = action();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* Preserve the original transaction failure. */ }
    throw error;
  }
}
