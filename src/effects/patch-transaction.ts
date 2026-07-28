import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { ArtifactMetadata } from "../authority/repositories/common.js";
import type { ArtifactRecord, ArtifactStore } from "../artifacts/artifact-store.js";
import type { PatchEntry, PatchSetRecord } from "../harness/domain.js";
import { sha256Hex } from "../foundation/crypto.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";

export const patchTransactionLimits = {
  maximum_files: 256,
  maximum_file_bytes: 8 * 1024 * 1024,
  maximum_total_postimage_bytes: 64 * 1024 * 1024,
} as const;

export interface PatchTransactionJournalEntry {
  readonly ordinal: number;
  readonly operation: PatchEntry["operation"];
  readonly path: string;
  readonly expected_before_sha256: string | null;
  readonly observed_before_sha256: string | null;
  readonly expected_after_sha256: string | null;
  readonly postimage_locator: string | null;
  readonly preimage_locator: string | null;
  readonly byte_length: number;
}

export interface PatchTransactionJournal {
  readonly schema_version: 1;
  readonly patch_set_id: string;
  readonly patch_sha256: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly shard_id: string;
  readonly preimage_root_sha256: string;
  readonly limits: typeof patchTransactionLimits;
  readonly entries: readonly PatchTransactionJournalEntry[];
  readonly created_directory_paths: readonly string[];
  readonly conflict_paths: readonly string[];
  readonly journal_sha256: string;
}

export interface PreparedPatchTransaction {
  readonly journal: PatchTransactionJournal;
  readonly journalArtifact: ArtifactRecord;
  readonly preimageArtifacts: readonly ArtifactRecord[];
  readonly postimages: ReadonlyMap<string, Buffer | null>;
}

function contained(root: string, candidate: string): boolean {
  const delta = relative(resolve(root), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function normalizedPath(cwd: string, value: string): { readonly path: string; readonly absolute: string } {
  if (!value.trim() || isAbsolute(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)) {
    throw new TypeError("Patch transaction path must be workspace-relative");
  }
  const absolute = resolve(cwd, value);
  if (!contained(cwd, absolute)) throw new TypeError("Patch transaction path escapes the workspace");
  const path = relative(resolve(cwd), absolute).replaceAll("\\", "/").normalize("NFC");
  if (!path || path === ".") throw new TypeError("Patch transaction cannot target the workspace root");
  return { path, absolute };
}

function sha(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be SHA-256`);
  return value;
}

function locator(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^pch-cas:\/\/sha256\/[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a CAS locator`);
  return value;
}

function journalPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value === "." || value.length > 4_096 || isAbsolute(value)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value) || value.includes("\\")) {
    throw new TypeError(`${label} must be a normalized workspace-relative path`);
  }
  const normalized = value.normalize("NFC");
  if (normalized !== value || normalized.startsWith("/") || normalized.endsWith("/") || normalized.includes("//")) {
    throw new TypeError(`${label} is not canonical`);
  }
  return value;
}

function validateJournal(value: unknown): PatchTransactionJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Patch transaction journal must be an object");
  const record = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "schema_version", "patch_set_id", "patch_sha256", "goal_id", "run_id", "shard_id",
    "preimage_root_sha256", "limits", "entries", "created_directory_paths", "conflict_paths", "journal_sha256",
  ]);
  if (Object.keys(record).some((key) => !expectedKeys.has(key)) || Object.keys(record).length !== expectedKeys.size) {
    throw new TypeError("Patch transaction journal shape is invalid");
  }
  if (record.schema_version !== 1) throw new TypeError("Patch transaction journal version is invalid");
  for (const key of ["patch_set_id", "goal_id", "run_id", "shard_id"] as const) {
    if (typeof record[key] !== "string" || record[key].length < 1 || record[key].length > 256) {
      throw new TypeError(`Patch transaction journal ${key} is invalid`);
    }
  }
  sha(record.patch_sha256, "Patch transaction patch_sha256");
  sha(record.preimage_root_sha256, "Patch transaction preimage_root_sha256");
  sha(record.journal_sha256, "Patch transaction journal_sha256");
  if (canonicalJson(record.limits) !== canonicalJson(patchTransactionLimits)) throw new TypeError("Patch transaction limits differ from the runtime contract");
  if (!Array.isArray(record.entries) || record.entries.length < 1 || record.entries.length > patchTransactionLimits.maximum_files) {
    throw new TypeError("Patch transaction entry count is invalid");
  }
  let totalBytes = 0;
  const paths = new Set<string>();
  const preimageConflicts = new Set<string>();
  for (const [ordinal, raw] of record.entries.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("Patch transaction entry is invalid");
    const entry = raw as Record<string, unknown>;
    const keys = ["ordinal", "operation", "path", "expected_before_sha256", "observed_before_sha256", "expected_after_sha256", "postimage_locator", "preimage_locator", "byte_length"];
    if (Object.keys(entry).length !== keys.length || Object.keys(entry).some((key) => !keys.includes(key))) throw new TypeError("Patch transaction entry shape is invalid");
    if (entry.ordinal !== ordinal || !["CREATE", "MODIFY", "DELETE"].includes(String(entry.operation))) throw new TypeError("Patch transaction entry ordinal or operation is invalid");
    const path = journalPath(entry.path, "Patch transaction entry path");
    if (paths.has(path)) throw new TypeError("Patch transaction contains duplicate paths");
    paths.add(path);
    const expectedBefore = sha(entry.expected_before_sha256, "Patch transaction expected_before_sha256", true);
    const observedBefore = sha(entry.observed_before_sha256, "Patch transaction observed_before_sha256", true);
    const expectedAfter = sha(entry.expected_after_sha256, "Patch transaction expected_after_sha256", true);
    const postimage = locator(entry.postimage_locator, "Patch transaction postimage_locator", true);
    const preimage = locator(entry.preimage_locator, "Patch transaction preimage_locator", true);
    if (!Number.isInteger(entry.byte_length) || Number(entry.byte_length) < 0 || Number(entry.byte_length) > patchTransactionLimits.maximum_file_bytes) {
      throw new TypeError("Patch transaction byte_length is invalid");
    }
    totalBytes += Number(entry.byte_length);
    if ((observedBefore === null) !== (preimage === null)) throw new TypeError("Patch transaction preimage locator does not match the observed preimage");
    if (entry.operation === "CREATE") {
      if (expectedBefore !== null) throw new TypeError("CREATE patch declares an expected preimage");
      if (observedBefore !== null) preimageConflicts.add(path);
    } else {
      if (expectedBefore === null) throw new TypeError(`${String(entry.operation)} patch lacks its expected preimage hash`);
      if (observedBefore === null || expectedBefore !== observedBefore) preimageConflicts.add(path);
    }
    if (entry.operation === "DELETE") {
      if (expectedAfter !== null || postimage !== null || entry.byte_length !== 0) throw new TypeError("DELETE patch has a postimage");
    } else if (expectedAfter === null || postimage === null) {
      throw new TypeError(`${String(entry.operation)} patch lacks a postimage`);
    }
  }
  if (totalBytes > patchTransactionLimits.maximum_total_postimage_bytes) throw new TypeError("Patch transaction postimages exceed the total bound");
  for (const ancestor of paths) for (const descendant of paths) {
    if (ancestor !== descendant && descendant.startsWith(`${ancestor}/`)) throw new TypeError("Patch transaction paths overlap by ancestry");
  }
  const parsePaths = (raw: unknown, label: string, limit: number): string[] => {
    if (!Array.isArray(raw) || raw.length > limit) throw new TypeError(`${label} is invalid`);
    const parsed = raw.map((entry) => journalPath(entry, label));
    if (new Set(parsed).size !== parsed.length || [...parsed].sort().some((entry, index) => entry !== parsed[index])) {
      throw new TypeError(`${label} must be unique and sorted`);
    }
    return parsed;
  };
  const createdDirectories = parsePaths(record.created_directory_paths, "Patch transaction created directory path", 4_096);
  if (createdDirectories.some((directory) => ![...paths].some((path) => path.startsWith(`${directory}/`)))) {
    throw new TypeError("Patch transaction created directory is not an ancestor of a target");
  }
  const conflicts = parsePaths(record.conflict_paths, "Patch transaction conflict path", patchTransactionLimits.maximum_files);
  if (conflicts.some((path) => !paths.has(path))) throw new TypeError("Patch transaction conflict path is not a target");
  if ([...preimageConflicts].some((path) => !conflicts.includes(path))) throw new TypeError("Patch transaction omits a preimage conflict");
  const { journal_sha256: claimed, ...body } = record;
  if (canonicalJsonSha256({ domain: "PCH-PATCH-TRANSACTION-JOURNAL-V1", ...body }) !== claimed) {
    throw new TypeError("Patch transaction journal integrity failed");
  }
  return record as unknown as PatchTransactionJournal;
}

function artifactMetadata(artifact: ArtifactRecord): ArtifactMetadata {
  const { created: _created, ...metadata } = artifact;
  void _created;
  return metadata;
}

function safeExistingFile(cwd: string, path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || !contained(cwd, realpathSync(path))) {
    throw new TypeError("Patch transaction target is not a safe regular file");
  }
  if (statSync(path).size > patchTransactionLimits.maximum_file_bytes) {
    throw new TypeError("Patch transaction preimage exceeds the single-file bound");
  }
  return readFileSync(path);
}

function orderEntries(entries: readonly PatchTransactionJournalEntry[]): PatchTransactionJournalEntry[] {
  const pending = [...entries];
  const ordered: PatchTransactionJournalEntry[] = [];
  while (pending.length > 0) {
    const nextIndex = pending.findIndex((candidate) => !pending.some((other) =>
      other !== candidate && other.operation === "DELETE" && candidate.path.startsWith(`${other.path}/`)));
    if (nextIndex < 0) throw new TypeError("Patch transaction path dependencies are cyclic");
    ordered.push(pending.splice(nextIndex, 1)[0]!);
  }
  return ordered.map((entry, ordinal) => ({ ...entry, ordinal }));
}

export function preparePatchTransaction(input: {
  readonly cwd: string;
  readonly goalId: string;
  readonly preimageRootSha256: string;
  readonly patchSet: PatchSetRecord;
  readonly artifacts: ArtifactStore;
}): PreparedPatchTransaction {
  if (input.patchSet.entries.length < 1 || input.patchSet.entries.length > patchTransactionLimits.maximum_files) {
    throw new TypeError(`Patch transaction requires 1..${patchTransactionLimits.maximum_files} files`);
  }
  const paths = new Set<string>();
  const conflicts = new Set<string>();
  const createdDirectories = new Set<string>();
  const preimageArtifacts: ArtifactRecord[] = [];
  const postimages = new Map<string, Buffer | null>();
  let postimageBytes = 0;
  const entries = input.patchSet.entries.map((entry, ordinal): PatchTransactionJournalEntry => {
    const target = normalizedPath(input.cwd, entry.path);
    if (paths.has(target.path)) throw new TypeError("Patch transaction contains duplicate normalized paths");
    paths.add(target.path);
    let before: Buffer | null;
    try { before = safeExistingFile(input.cwd, target.absolute); }
    catch { conflicts.add(target.path); before = null; }
    const observedBefore = before === null ? null : sha256Hex(before);
    if ((entry.operation === "CREATE" && before !== null)
      || (entry.operation !== "CREATE" && before === null)
      || observedBefore !== entry.before_sha256) conflicts.add(target.path);

    let postimage: Buffer | null = null;
    if (entry.content_locator !== null) {
      postimage = Buffer.from(input.artifacts.open(entry.content_locator));
      if (postimage.byteLength !== entry.byte_length || sha256Hex(postimage) !== entry.after_sha256) {
        throw new TypeError("Patch transaction postimage artifact does not match the PatchSet");
      }
      if (postimage.byteLength > patchTransactionLimits.maximum_file_bytes) {
        throw new TypeError("Patch transaction postimage exceeds the single-file bound");
      }
      postimageBytes += postimage.byteLength;
      if (postimageBytes > patchTransactionLimits.maximum_total_postimage_bytes) {
        throw new TypeError("Patch transaction exceeds the total postimage bound");
      }
    }
    postimages.set(target.path, postimage);
    const preimage = before === null ? null : input.artifacts.put(before, {
      mediaType: "application/octet-stream", classification: "INTERNAL", retentionClass: "GOAL",
    });
    if (preimage) preimageArtifacts.push(preimage);
    return {
      ordinal, operation: entry.operation, path: target.path,
      expected_before_sha256: entry.before_sha256, observed_before_sha256: observedBefore,
      expected_after_sha256: entry.after_sha256, postimage_locator: entry.content_locator,
      preimage_locator: preimage?.locator ?? null, byte_length: entry.byte_length,
    };
  });

  for (const ancestor of entries) for (const descendant of entries) {
    if (ancestor === descendant || !descendant.path.startsWith(`${ancestor.path}/`)) continue;
    conflicts.add(ancestor.path); conflicts.add(descendant.path);
  }
  for (const entry of entries) {
    let parent = dirname(resolve(input.cwd, entry.path));
    while (contained(input.cwd, parent) && resolve(parent) !== resolve(input.cwd)) {
      if (existsSync(parent)) {
        const info = lstatSync(parent);
        if (info.isSymbolicLink()) conflicts.add(entry.path);
        else if (!info.isDirectory() || !contained(input.cwd, realpathSync(parent))) conflicts.add(entry.path);
      } else createdDirectories.add(relative(input.cwd, parent).replaceAll("\\", "/").normalize("NFC"));
      parent = dirname(parent);
    }
  }

  const ordered = orderEntries(entries);
  const body = {
    schema_version: 1 as const, patch_set_id: input.patchSet.patch_set_id, patch_sha256: input.patchSet.patch_sha256,
    goal_id: input.goalId, run_id: input.patchSet.run_id, shard_id: input.patchSet.shard_id,
    preimage_root_sha256: input.preimageRootSha256, limits: patchTransactionLimits,
    entries: ordered, created_directory_paths: [...createdDirectories].sort(), conflict_paths: [...conflicts].sort(),
  };
  const journal: PatchTransactionJournal = {
    ...body, journal_sha256: canonicalJsonSha256({ domain: "PCH-PATCH-TRANSACTION-JOURNAL-V1", ...body }),
  };
  const journalArtifact = input.artifacts.put(canonicalJson(journal), {
    mediaType: "application/vnd.pch.patch-transaction+json", classification: "INTERNAL", retentionClass: "GOAL",
  });
  return { journal, journalArtifact, preimageArtifacts, postimages };
}

export function readPatchTransactionJournal(artifacts: ArtifactStore, locator: string): PatchTransactionJournal {
  const bytes = Buffer.from(artifacts.open(locator));
  return validateJournal(JSON.parse(bytes.toString("utf8")));
}

export function patchTransactionArtifacts(prepared: PreparedPatchTransaction): readonly ArtifactMetadata[] {
  return [prepared.journalArtifact, ...prepared.preimageArtifacts].map(artifactMetadata);
}

export function applyPatchFile(path: string, operation: PatchEntry["operation"], content: Buffer | null): void {
  if (operation === "DELETE") { unlinkSync(path); return; }
  if (content === null) throw new TypeError(`${operation} patch requires content`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.pch.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve the primary error. */ }
    throw error;
  }
}

export function journalExpectedHash(entry: PatchTransactionJournalEntry): string {
  return entry.operation === "DELETE" ? sha256Hex("PCH-ABSENT-V1") : entry.expected_after_sha256!;
}

export function journalPreimage(
  artifacts: ArtifactStore, entry: PatchTransactionJournalEntry,
): Buffer | null {
  return entry.preimage_locator === null ? null : Buffer.from(artifacts.open(entry.preimage_locator));
}

export function removePatchCreatedDirectories(cwd: string, journal: PatchTransactionJournal): readonly string[] {
  const failed: string[] = [];
  const deepestFirst = [...journal.created_directory_paths]
    .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
  for (const path of deepestFirst) {
    const target = normalizedPath(cwd, path);
    if (!existsSync(target.absolute)) continue;
    const info = lstatSync(target.absolute);
    if (info.isSymbolicLink() || !info.isDirectory() || !contained(cwd, realpathSync(target.absolute))) {
      failed.push(path); continue;
    }
    try { rmdirSync(target.absolute); }
    catch { failed.push(path); }
  }
  return failed.sort();
}

export interface PatchTransactionRecoveryResult {
  readonly outcome: "RESTORED" | "OUTCOME_UNKNOWN";
  readonly restored_paths: readonly string[];
  readonly uncertain_paths: readonly string[];
}

export function restorePatchTransactionPreimage(input: {
  readonly cwd: string;
  readonly journal: PatchTransactionJournal;
  readonly artifacts: ArtifactStore;
  readonly withMutationFence?: (effect: () => void) => void;
  readonly afterRestore?: (path: string) => void;
}): PatchTransactionRecoveryResult {
  const withMutationFence = input.withMutationFence ?? ((effect: () => void): void => effect());
  const preimages = new Map<string, Buffer | null>();
  const uncertain = new Set<string>();
  for (const entry of input.journal.entries) {
    try {
      const target = normalizedPath(input.cwd, entry.path);
      const before = journalPreimage(input.artifacts, entry);
      if ((before === null ? null : sha256Hex(before)) !== entry.observed_before_sha256) throw new TypeError("Preimage artifact mismatch");
      if (entry.postimage_locator !== null) {
        const after = Buffer.from(input.artifacts.open(entry.postimage_locator));
        if (after.byteLength !== entry.byte_length || sha256Hex(after) !== entry.expected_after_sha256) throw new TypeError("Postimage artifact mismatch");
      }
      preimages.set(entry.path, before);
      const current = safeExistingFile(input.cwd, target.absolute);
      const currentHash = current === null ? sha256Hex("PCH-ABSENT-V1") : sha256Hex(current);
      const preimageHash = entry.observed_before_sha256 ?? sha256Hex("PCH-ABSENT-V1");
      if (currentHash !== preimageHash && currentHash !== journalExpectedHash(entry)) uncertain.add(entry.path);
    } catch { uncertain.add(entry.path); }
  }
  if (uncertain.size > 0) return { outcome: "OUTCOME_UNKNOWN", restored_paths: [], uncertain_paths: [...uncertain].sort() };

  const restored: string[] = [];
  for (const entry of [...input.journal.entries].reverse()) {
    const target = normalizedPath(input.cwd, entry.path);
    const before = preimages.get(entry.path) ?? null;
    const preimageHash = entry.observed_before_sha256 ?? sha256Hex("PCH-ABSENT-V1");
    try {
      let changed = false;
      withMutationFence(() => {
        const current = safeExistingFile(input.cwd, target.absolute);
        const currentHash = current === null ? sha256Hex("PCH-ABSENT-V1") : sha256Hex(current);
        if (currentHash === preimageHash) return;
        if (currentHash !== journalExpectedHash(entry)) throw new AuthorityIntegrityError("Patch recovery postimage changed before restore");
        const inverse: PatchEntry["operation"] = before === null ? "DELETE" : current === null ? "CREATE" : "MODIFY";
        applyPatchFile(target.absolute, inverse, before);
        const observed = safeExistingFile(input.cwd, target.absolute);
        if ((observed === null ? sha256Hex("PCH-ABSENT-V1") : sha256Hex(observed)) !== preimageHash) {
          throw new AuthorityIntegrityError("Patch recovery preimage verification failed");
        }
        changed = true;
      });
      if (changed) {
        restored.push(entry.path);
        input.afterRestore?.(entry.path);
      }
    } catch { uncertain.add(entry.path); break; }
  }
  let directoryFailures: readonly string[] = [];
  withMutationFence(() => { directoryFailures = removePatchCreatedDirectories(input.cwd, input.journal); });
  for (const path of directoryFailures) uncertain.add(path);
  return uncertain.size > 0
    ? { outcome: "OUTCOME_UNKNOWN", restored_paths: restored.sort(), uncertain_paths: [...uncertain].sort() }
    : { outcome: "RESTORED", restored_paths: restored.sort(), uncertain_paths: [] };
}
