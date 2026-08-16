import { isAbsolute } from "node:path";
import type { ArtifactMetadata } from "../../authority/repositories/common.js";
import { canonicalJsonSha256 } from "../../authority/canonical-json.js";
import type { PreparedPatchTransaction } from "../../effects/patch-transaction.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const casPattern = /^pch-cas:\/\/sha256\/[a-f0-9]{64}$/u;

export interface PreparedExecutionIntegrationPreimageV2 {
  readonly ordinal: number;
  readonly path: string;
  readonly operation: "CREATE" | "MODIFY" | "DELETE";
  readonly expected_before_sha256: string | null;
  readonly observed_before_sha256: string | null;
  readonly expected_after_sha256: string | null;
  readonly byte_length: number;
  readonly preimage_artifact: ArtifactMetadata | null;
}

export interface PreparedExecutionIntegrationJournalV2 {
  readonly schema_version: 2;
  readonly journal_sha256: string;
  readonly journal_record_sha256: string;
  readonly journal_artifact: ArtifactMetadata;
  readonly entries: readonly PreparedExecutionIntegrationPreimageV2[];
}

export interface ExecutionIntegrationPreimageV2 extends PreparedExecutionIntegrationPreimageV2 {
  readonly integration_attempt_id: string;
  readonly record_sha256: string;
}

export interface ExecutionIntegrationJournalV2 {
  readonly schema_version: 2;
  readonly integration_attempt_id: string;
  readonly journal_sha256: string;
  readonly journal_record_sha256: string;
  readonly journal_artifact: ArtifactMetadata;
  readonly entries: readonly ExecutionIntegrationPreimageV2[];
  readonly record_sha256: string;
}

function metadata(record: PreparedPatchTransaction["journalArtifact"]): ArtifactMetadata {
  const { created: _created, ...value } = record;
  void _created;
  return value;
}

function normalizedPath(value: string): boolean {
  return value.length >= 1 && value.length <= 4_096 && value === value.normalize("NFC")
    && !isAbsolute(value) && !value.includes("\\") && !value.startsWith("/") && !value.endsWith("/")
    && !value.includes("//") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function assertArtifact(value: ArtifactMetadata, label: string): void {
  if (!value.artifactId || !sha256Pattern.test(value.sha256) || value.byteLength < 0
    || !Number.isSafeInteger(value.byteLength) || !casPattern.test(value.locator)
    || value.locator !== `pch-cas://sha256/${value.sha256}` || value.classification === "SECRET"
    || !value.mediaType || !value.retentionClass) {
    throw new TypeError(`${label} metadata is invalid`);
  }
}

function assertPreparedEntry(entry: PreparedExecutionIntegrationPreimageV2, ordinal: number): void {
  if (entry.ordinal !== ordinal || !normalizedPath(entry.path)
    || !["CREATE", "MODIFY", "DELETE"].includes(entry.operation)
    || !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0 || entry.byte_length > 8 * 1024 * 1024) {
    throw new TypeError("Execution integration preimage entry is invalid");
  }
  for (const value of [entry.expected_before_sha256, entry.observed_before_sha256, entry.expected_after_sha256]) {
    if (value !== null && !sha256Pattern.test(value)) throw new TypeError("Execution integration preimage hash is invalid");
  }
  if ((entry.operation === "CREATE" && (entry.expected_before_sha256 !== null || entry.expected_after_sha256 === null))
    || (entry.operation === "MODIFY" && (entry.expected_before_sha256 === null || entry.expected_after_sha256 === null))
    || (entry.operation === "DELETE" && (entry.expected_before_sha256 === null
      || entry.expected_after_sha256 !== null || entry.byte_length !== 0))) {
    throw new TypeError("Execution integration preimage operation contract is invalid");
  }
  if ((entry.observed_before_sha256 === null) !== (entry.preimage_artifact === null)) {
    throw new TypeError("Execution integration preimage artifact presence is invalid");
  }
  if (entry.preimage_artifact) {
    assertArtifact(entry.preimage_artifact, "Execution integration preimage artifact");
    if (entry.preimage_artifact.sha256 !== entry.observed_before_sha256) {
      throw new TypeError("Execution integration preimage artifact hash differs from its observation");
    }
  }
}

export function prepareExecutionIntegrationJournalV2(
  prepared: PreparedPatchTransaction,
): PreparedExecutionIntegrationJournalV2 {
  const preimages = new Map(prepared.preimageArtifacts.map((artifact) => [artifact.locator, metadata(artifact)]));
  const value: PreparedExecutionIntegrationJournalV2 = {
    schema_version: 2,
    journal_sha256: prepared.journalArtifact.sha256,
    journal_record_sha256: prepared.journal.journal_sha256,
    journal_artifact: metadata(prepared.journalArtifact),
    entries: prepared.journal.entries.map((entry) => ({
      ordinal: entry.ordinal,
      path: entry.path,
      operation: entry.operation,
      expected_before_sha256: entry.expected_before_sha256,
      observed_before_sha256: entry.observed_before_sha256,
      expected_after_sha256: entry.expected_after_sha256,
      byte_length: entry.byte_length,
      preimage_artifact: entry.preimage_locator === null ? null : preimages.get(entry.preimage_locator) ?? null,
    })),
  };
  assertPreparedExecutionIntegrationJournalV2(value);
  return value;
}

export function assertPreparedExecutionIntegrationJournalV2(
  value: PreparedExecutionIntegrationJournalV2,
): void {
  if (value.schema_version !== 2 || !sha256Pattern.test(value.journal_sha256)
    || !sha256Pattern.test(value.journal_record_sha256)
    || value.entries.length < 1 || value.entries.length > 256) {
    throw new TypeError("Execution integration journal preparation is invalid");
  }
  assertArtifact(value.journal_artifact, "Execution integration journal artifact");
  if (value.journal_artifact.sha256 !== value.journal_sha256
    || value.journal_artifact.mediaType !== "application/vnd.pch.patch-transaction+json") {
    throw new TypeError("Execution integration journal artifact binding is invalid");
  }
  const paths = new Set<string>();
  value.entries.forEach((entry, ordinal) => {
    assertPreparedEntry(entry, ordinal);
    if (paths.has(entry.path)) throw new TypeError("Execution integration journal contains a duplicate path");
    paths.add(entry.path);
  });
}

export function finalizeExecutionIntegrationJournalV2(input: {
  readonly integration_attempt_id: string;
  readonly prepared: PreparedExecutionIntegrationJournalV2;
}): ExecutionIntegrationJournalV2 {
  if (!input.integration_attempt_id || input.integration_attempt_id.length > 256) {
    throw new TypeError("Execution integration journal attempt ID is invalid");
  }
  assertPreparedExecutionIntegrationJournalV2(input.prepared);
  const entries = input.prepared.entries.map((entry): ExecutionIntegrationPreimageV2 => ({
    ...entry,
    integration_attempt_id: input.integration_attempt_id,
    record_sha256: canonicalJsonSha256({
      domain: "PCH-EXECUTION-INTEGRATION-PREIMAGE-V2",
      integration_attempt_id: input.integration_attempt_id,
      ...entry,
    }),
  }));
  const body = {
    schema_version: 2 as const,
    integration_attempt_id: input.integration_attempt_id,
    journal_sha256: input.prepared.journal_sha256,
    journal_record_sha256: input.prepared.journal_record_sha256,
    journal_artifact: input.prepared.journal_artifact,
    entries,
  };
  return {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-EXECUTION-INTEGRATION-JOURNAL-V2", ...body }),
  };
}

export function assertExecutionIntegrationJournalV2(value: ExecutionIntegrationJournalV2): void {
  const prepared: PreparedExecutionIntegrationJournalV2 = {
    schema_version: value.schema_version,
    journal_sha256: value.journal_sha256,
    journal_record_sha256: value.journal_record_sha256,
    journal_artifact: value.journal_artifact,
    entries: value.entries.map((entry) => {
      const { integration_attempt_id: _attemptId, record_sha256: _recordSha256, ...preparedEntry } = entry;
      void _attemptId;
      void _recordSha256;
      return preparedEntry;
    }),
  };
  const expected = finalizeExecutionIntegrationJournalV2({
    integration_attempt_id: value.integration_attempt_id,
    prepared,
  });
  if (expected.record_sha256 !== value.record_sha256
    || expected.entries.some((entry, ordinal) => entry.record_sha256 !== value.entries[ordinal]?.record_sha256)) {
    throw new TypeError("Execution integration journal integrity failed");
  }
}
