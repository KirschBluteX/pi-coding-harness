export type CodingHarnessErrorCode =
  | "CAPABILITY_PROBE_FAILED"
  | "CONFIG_INVALID"
  | "CONFIG_READ_FAILED"
  | "AUTHORITY_INTEGRITY_FAILED"
  | "AUTHORITY_NOT_FOUND"
  | "MIGRATION_HASH_MISMATCH"
  | "VERSION_CONFLICT"
  | "LEASE_CONFLICT"
  | "STALE_FENCING_TOKEN"
  | "ARTIFACT_INTEGRITY_FAILED"
  | "PLANNING_VALIDATION_FAILED"
  | "UNSAFE_PATH";

export class CodingHarnessError extends Error {
  readonly code: CodingHarnessErrorCode;
  readonly details: readonly string[];

  constructor(code: CodingHarnessErrorCode, message: string, options?: ErrorOptions & { details?: readonly string[] }) {
    super(message, options);
    this.name = "CodingHarnessError";
    this.code = code;
    this.details = options?.details ?? [];
  }
}

export class ConfigReadError extends CodingHarnessError {
  constructor(path: string, cause: unknown) {
    super("CONFIG_READ_FAILED", `Unable to read Coding Harness configuration: ${path}`, { cause });
    this.name = "ConfigReadError";
  }
}

export class ConfigValidationError extends CodingHarnessError {
  constructor(path: string, details: readonly string[], cause?: unknown) {
    super("CONFIG_INVALID", `Invalid Coding Harness configuration: ${path}; ${details.join("; ")}`, { cause, details });
    this.name = "ConfigValidationError";
  }
}

export class CapabilityProbeError extends CodingHarnessError {
  constructor(message: string, cause?: unknown) {
    super("CAPABILITY_PROBE_FAILED", message, { cause });
    this.name = "CapabilityProbeError";
  }
}

export class AuthorityIntegrityError extends CodingHarnessError {
  constructor(message: string, cause?: unknown) {
    super("AUTHORITY_INTEGRITY_FAILED", message, { cause });
    this.name = "AuthorityIntegrityError";
  }
}

export class AuthorityNotFoundError extends CodingHarnessError {
  constructor(subject: string) {
    super("AUTHORITY_NOT_FOUND", `Authority subject not found: ${subject}`);
    this.name = "AuthorityNotFoundError";
  }
}

export class MigrationHashMismatchError extends CodingHarnessError {
  constructor(version: number, expected: string, actual: string) {
    super("MIGRATION_HASH_MISMATCH", `Migration ${version} hash mismatch: recorded=${expected} actual=${actual}`);
    this.name = "MigrationHashMismatchError";
  }
}

export class VersionConflictError extends CodingHarnessError {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super("VERSION_CONFLICT", `Goal version conflict: expected=${expectedVersion} actual=${actualVersion}`);
    this.name = "VersionConflictError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class LeaseConflictError extends CodingHarnessError {
  constructor(message: string) {
    super("LEASE_CONFLICT", message);
    this.name = "LeaseConflictError";
  }
}

export class StaleFencingTokenError extends CodingHarnessError {
  constructor(message: string) {
    super("STALE_FENCING_TOKEN", message);
    this.name = "StaleFencingTokenError";
  }
}

export class ArtifactIntegrityError extends CodingHarnessError {
  constructor(message: string, cause?: unknown) {
    super("ARTIFACT_INTEGRITY_FAILED", message, { cause });
    this.name = "ArtifactIntegrityError";
  }
}

export class PlanningValidationError extends CodingHarnessError {
  constructor(subject: string, details: readonly string[]) {
    super("PLANNING_VALIDATION_FAILED", `${subject} validation failed: ${details.join("; ")}`, { details });
    this.name = "PlanningValidationError";
  }
}

export class UnsafePathError extends CodingHarnessError {
  constructor(message: string) {
    super("UNSAFE_PATH", message);
    this.name = "UnsafePathError";
  }
}
