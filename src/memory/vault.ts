import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync,
} from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, relative, resolve } from "node:path";
import { assertContained, assertSafeExistingDirectory, prepareSafeRoot, publishAtomicNoReplace } from "../artifacts/atomic-file.js";
import { canonicalJson, canonicalJsonBytes, parseCanonicalJson, type CanonicalJson } from "../authority/canonical-json.js";
import { AuthorityIntegrityError, UnsafePathError } from "../foundation/errors.js";
import { equalSha256, sha256Hex } from "../foundation/crypto.js";

const formatVersion = 1 as const;
const shaPattern = /^[a-f0-9]{64}$/u;
const claimPattern = /^[A-Z][A-Z0-9_-]{2,127}$/u;

export interface MemoryVaultIdentity {
  readonly workspaceId: string;
  readonly claimId: string;
  readonly version: number;
}

export interface MemoryVaultPrepareInput extends MemoryVaultIdentity {
  readonly authorityMetadata: CanonicalJson;
  readonly body: CanonicalJson;
}

export interface MemoryVaultPrepared extends MemoryVaultIdentity {
  readonly formatVersion: 1;
  readonly authorityMetadataSha256: string;
  readonly bodySha256: string;
  readonly vaultRefSha256: string;
  readonly keyRefSha256: string;
  readonly ciphertextSha256: string;
  readonly wrappedKeySha256: string;
  readonly reused: boolean;
}

export interface MemoryVaultRecord extends MemoryVaultPrepared {
  readonly reused: boolean;
}

export interface MemoryVaultInspection {
  readonly body: "PRESENT" | "MISSING";
  readonly key: "PRESENT" | "MISSING";
}

export interface MemoryVaultReconcileResult {
  readonly quarantinedRefSha256: readonly string[];
  readonly removedQuarantineCount: number;
  readonly deferredCount: number;
  readonly scannedCount: number;
  readonly truncated: boolean;
}

interface VaultRefs {
  readonly objectRelative: string;
  readonly keyRelative: string;
  readonly objectPath: string;
  readonly keyPath: string;
  readonly vaultRefSha256: string;
  readonly keyRefSha256: string;
}

interface StableFile {
  readonly bytes: Buffer;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CipherEnvelope {
  readonly schema_version: 1;
  readonly record_type: "PCH_MEMORY_VAULT_CIPHERTEXT";
  readonly workspace_id: string;
  readonly claim_id: string;
  readonly version: number;
  readonly authority_metadata_sha256: string;
  readonly body_sha256: string;
  readonly nonce_base64: string;
  readonly ciphertext_base64: string;
  readonly auth_tag_base64: string;
}

interface KeyEnvelope {
  readonly schema_version: 1;
  readonly record_type: "PCH_MEMORY_VAULT_WRAPPED_KEY";
  readonly workspace_id: string;
  readonly claim_id: string;
  readonly version: number;
  readonly authority_metadata_sha256: string;
  readonly body_sha256: string;
  readonly ciphertext_sha256: string;
  readonly nonce_base64: string;
  readonly wrapped_dek_base64: string;
  readonly auth_tag_base64: string;
}

function normalizedPath(path: string): string {
  const value = resolve(path).replaceAll("/", "\\");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function requireIdentity(value: MemoryVaultIdentity): void {
  if (!claimPattern.test(value.workspaceId) || !claimPattern.test(value.claimId)
    || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new TypeError("Memory Vault identity is invalid");
  }
}

function requireSha256(value: string, name: string): void {
  if (!shaPattern.test(value)) throw new TypeError(`Memory Vault ${name} is not SHA-256`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw new AuthorityIntegrityError(`Memory Vault ${name} has unexpected fields`);
  }
}

function base64(value: unknown, bytes: number | null, name: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new AuthorityIntegrityError(`Memory Vault ${name} is invalid base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (bytes !== null && decoded.byteLength !== bytes)) {
    throw new AuthorityIntegrityError(`Memory Vault ${name} has an invalid length or encoding`);
  }
  return decoded;
}

function cipherAad(identity: MemoryVaultIdentity, authorityMetadataSha256: string, bodySha256: string): Buffer {
  return Buffer.from(canonicalJson({
    domain: "PCH-MEMORY-VAULT-CIPHERTEXT-AAD-V1", formatVersion,
    workspaceId: identity.workspaceId, claimId: identity.claimId, version: identity.version,
    authorityMetadataSha256, bodySha256,
  }), "utf8");
}

function keyAad(
  identity: MemoryVaultIdentity,
  authorityMetadataSha256: string,
  bodySha256: string,
  ciphertextSha256: string,
): Buffer {
  return Buffer.from(canonicalJson({
    domain: "PCH-MEMORY-VAULT-KEY-AAD-V1", formatVersion,
    workspaceId: identity.workspaceId, claimId: identity.claimId, version: identity.version,
    authorityMetadataSha256, bodySha256, ciphertextSha256,
  }), "utf8");
}

function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
} {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

function unseal(key: Uint8Array, nonce: Buffer, ciphertext: Buffer, tag: Buffer, aad: Uint8Array): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new AuthorityIntegrityError("Memory Vault authentication failed", error);
  }
}

function parseRecord(bytes: Buffer, maximumBytes: number, name: string): Record<string, unknown> {
  if (bytes.byteLength > maximumBytes) throw new AuthorityIntegrityError(`Memory Vault ${name} exceeds its size limit`);
  let value: CanonicalJson;
  try { value = parseCanonicalJson(bytes.toString("utf8")); }
  catch (error) { throw new AuthorityIntegrityError(`Memory Vault ${name} is not canonical JSON`, error); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthorityIntegrityError(`Memory Vault ${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function identityMatches(record: Record<string, unknown>, identity: MemoryVaultIdentity): boolean {
  return record.workspace_id === identity.workspaceId && record.claim_id === identity.claimId
    && record.version === identity.version;
}

export class MemoryVault {
  readonly root: string;
  private readonly installKey: Buffer;

  constructor(
    workspaceDataRoot: string,
    installKey: Uint8Array,
    private readonly maximumBodyBytes = 16_777_216,
  ) {
    if (installKey.byteLength !== 32) throw new TypeError("Memory Vault install key must contain exactly 32 bytes");
    if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1_024 || maximumBodyBytes > 67_108_864) {
      throw new RangeError("Memory Vault body limit is invalid");
    }
    const workspaceRoot = prepareSafeRoot(workspaceDataRoot);
    this.root = prepareSafeRoot(resolve(workspaceRoot, "memory-vault-v1"));
    assertContained(workspaceRoot, this.root);
    privateDirectory(this.root);
    this.installKey = Buffer.from(installKey);
  }

  prepare(input: MemoryVaultPrepareInput): MemoryVaultPrepared {
    requireIdentity(input);
    const bodyBytes = Buffer.from(canonicalJsonBytes(input.body));
    if (bodyBytes.byteLength > this.maximumBodyBytes) throw new RangeError("Memory Vault body exceeds max_payload_bytes");
    const bodySha256 = sha256Hex(bodyBytes);
    const authorityMetadataSha256 = sha256Hex(canonicalJsonBytes(input.authorityMetadata));
    const refs = this.refs(input);
    this.ensureStorageRoots(refs);

    if (existsSync(refs.objectPath) || existsSync(refs.keyPath)) {
      if (!existsSync(refs.objectPath) || !existsSync(refs.keyPath)) {
        throw new AuthorityIntegrityError("Memory Vault contains a partial prepared version");
      }
      const existing = this.openExisting(input, authorityMetadataSha256, bodySha256, refs);
      if (!existing.bodyBytes.equals(bodyBytes)) {
        throw new AuthorityIntegrityError("Memory Vault identity was reused for different content");
      }
      return { ...input, formatVersion, authorityMetadataSha256, bodySha256,
        vaultRefSha256: refs.vaultRefSha256, keyRefSha256: refs.keyRefSha256,
        ciphertextSha256: existing.ciphertextSha256, wrappedKeySha256: existing.wrappedKeySha256, reused: true };
    }

    const dek = randomBytes(32);
    let objectCreated = false;
    let keyCreated = false;
    try {
      const bodySealed = seal(dek, bodyBytes, cipherAad(input, authorityMetadataSha256, bodySha256));
      const cipherEnvelope: CipherEnvelope = {
        schema_version: formatVersion, record_type: "PCH_MEMORY_VAULT_CIPHERTEXT",
        workspace_id: input.workspaceId, claim_id: input.claimId, version: input.version,
        authority_metadata_sha256: authorityMetadataSha256, body_sha256: bodySha256,
        nonce_base64: bodySealed.nonce.toString("base64"),
        ciphertext_base64: bodySealed.ciphertext.toString("base64"),
        auth_tag_base64: bodySealed.tag.toString("base64"),
      };
      const cipherBytes = Buffer.from(canonicalJson(cipherEnvelope), "utf8");
      const ciphertextSha256 = sha256Hex(cipherBytes);
      const wrapped = seal(this.installKey, dek, keyAad(input, authorityMetadataSha256, bodySha256, ciphertextSha256));
      const keyEnvelope: KeyEnvelope = {
        schema_version: formatVersion, record_type: "PCH_MEMORY_VAULT_WRAPPED_KEY",
        workspace_id: input.workspaceId, claim_id: input.claimId, version: input.version,
        authority_metadata_sha256: authorityMetadataSha256, body_sha256: bodySha256,
        ciphertext_sha256: ciphertextSha256, nonce_base64: wrapped.nonce.toString("base64"),
        wrapped_dek_base64: wrapped.ciphertext.toString("base64"), auth_tag_base64: wrapped.tag.toString("base64"),
      };
      const keyBytes = Buffer.from(canonicalJson(keyEnvelope), "utf8");
      const wrappedKeySha256 = sha256Hex(keyBytes);
      objectCreated = publishAtomicNoReplace(this.root, refs.objectPath, cipherBytes) === "CREATED";
      keyCreated = publishAtomicNoReplace(this.root, refs.keyPath, keyBytes) === "CREATED";
      if (!objectCreated || !keyCreated) {
        const existing = this.openExisting(input, authorityMetadataSha256, bodySha256, refs);
        if (!existing.bodyBytes.equals(bodyBytes)) throw new AuthorityIntegrityError("Concurrent Vault publication disagrees");
        return { ...input, formatVersion, authorityMetadataSha256, bodySha256,
          vaultRefSha256: refs.vaultRefSha256, keyRefSha256: refs.keyRefSha256,
          ciphertextSha256: existing.ciphertextSha256, wrappedKeySha256: existing.wrappedKeySha256, reused: true };
      }
      return { ...input, formatVersion, authorityMetadataSha256, bodySha256,
        vaultRefSha256: refs.vaultRefSha256, keyRefSha256: refs.keyRefSha256,
        ciphertextSha256, wrappedKeySha256, reused: false };
    } catch (error) {
      if (keyCreated) this.unlinkExpected(refs.keyPath, null);
      if (objectCreated) this.unlinkExpected(refs.objectPath, null);
      throw error;
    } finally {
      dek.fill(0);
      bodyBytes.fill(0);
    }
  }

  open(record: MemoryVaultRecord): CanonicalJson {
    this.validateRecord(record);
    const refs = this.refs(record);
    if (refs.vaultRefSha256 !== record.vaultRefSha256 || refs.keyRefSha256 !== record.keyRefSha256) {
      throw new AuthorityIntegrityError("Memory Vault reference hash does not match its identity");
    }
    const existing = this.openExisting(record, record.authorityMetadataSha256, record.bodySha256, refs, record);
    try { return parseCanonicalJson(existing.bodyBytes.toString("utf8")); }
    catch (error) { throw new AuthorityIntegrityError("Memory Vault body is not canonical JSON", error); }
    finally { existing.bodyBytes.fill(0); }
  }

  inspect(record: Pick<MemoryVaultRecord, keyof MemoryVaultIdentity | "vaultRefSha256" | "keyRefSha256">): MemoryVaultInspection {
    requireIdentity(record);
    const refs = this.refs(record);
    if (refs.vaultRefSha256 !== record.vaultRefSha256 || refs.keyRefSha256 !== record.keyRefSha256) {
      throw new AuthorityIntegrityError("Memory Vault reference hash does not match its identity");
    }
    return { body: existsSync(refs.objectPath) ? "PRESENT" : "MISSING", key: existsSync(refs.keyPath) ? "PRESENT" : "MISSING" };
  }

  destroyKey(record: Pick<MemoryVaultRecord, keyof MemoryVaultIdentity | "keyRefSha256" | "wrappedKeySha256">): "DESTROYED" | "ALREADY_ABSENT" {
    requireIdentity(record);
    requireSha256(record.keyRefSha256, "key_ref_sha256");
    requireSha256(record.wrappedKeySha256, "wrapped_key_sha256");
    const refs = this.refs(record);
    if (refs.keyRefSha256 !== record.keyRefSha256) throw new AuthorityIntegrityError("Memory Vault key reference hash is invalid");
    if (!existsSync(refs.keyPath)) return "ALREADY_ABSENT";
    this.unlinkExpected(refs.keyPath, record.wrappedKeySha256);
    if (existsSync(refs.keyPath)) throw new AuthorityIntegrityError("Memory Vault wrapped key remains after destruction");
    return "DESTROYED";
  }

  discardPrepared(record: MemoryVaultPrepared): void {
    this.validateRecord(record);
    const refs = this.refs(record);
    if (refs.keyRefSha256 !== record.keyRefSha256 || refs.vaultRefSha256 !== record.vaultRefSha256) {
      throw new AuthorityIntegrityError("Memory Vault prepared references are invalid");
    }
    if (existsSync(refs.keyPath)) this.unlinkExpected(refs.keyPath, record.wrappedKeySha256);
    if (existsSync(refs.objectPath)) this.unlinkExpected(refs.objectPath, record.ciphertextSha256);
  }

  reconcileOrphans(
    referencedVaultRefSha256: ReadonlySet<string>,
    referencedKeyRefSha256: ReadonlySet<string>,
    nowMs: number,
    graceMs = 300_000,
    maximumEntries = 2_000,
  ): MemoryVaultReconcileResult {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(graceMs) || graceMs < 0
      || !Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new TypeError("Memory Vault reconcile limits are invalid");
    const quarantined: string[] = [];
    let scanned = 0;
    let deferred = 0;
    let truncated = false;
    const quarantineRoot = resolve(this.root, "quarantine");
    privateDirectory(quarantineRoot);
    assertSafeExistingDirectory(this.root, quarantineRoot);
    for (const [kind, references] of [["objects", referencedVaultRefSha256], ["keys", referencedKeyRefSha256]] as const) {
      const kindRoot = resolve(this.root, kind);
      if (!existsSync(kindRoot)) continue;
      for (const path of this.boundedFiles(kindRoot, maximumEntries - scanned)) {
        scanned += 1;
        if (scanned >= maximumEntries) truncated = true;
        const ref = relative(this.root, path).replaceAll("\\", "/");
        const refSha256 = sha256Hex(ref);
        if (references.has(refSha256)) continue;
        const age = nowMs - Math.trunc(statSync(path).mtimeMs);
        if (age < graceMs) { deferred += 1; continue; }
        const target = resolve(quarantineRoot, `${kind}-${basename(path)}-${randomUUID()}`);
        assertContained(this.root, target);
        renameSync(path, target);
        const quarantineTime = new Date(nowMs);
        utimesSync(target, quarantineTime, quarantineTime);
        quarantined.push(refSha256);
      }
      if (truncated) break;
    }
    let removedQuarantineCount = 0;
    for (const path of this.boundedFiles(quarantineRoot, Math.max(1, maximumEntries - scanned))) {
      const age = nowMs - Math.trunc(statSync(path).mtimeMs);
      if (age < graceMs) continue;
      this.unlinkExpected(path, null);
      removedQuarantineCount += 1;
    }
    return { quarantinedRefSha256: quarantined, removedQuarantineCount, deferredCount: deferred,
      scannedCount: scanned, truncated };
  }

  private refs(identity: MemoryVaultIdentity): VaultRefs {
    requireIdentity(identity);
    const storageId = sha256Hex(canonicalJson({
      domain: "PCH-MEMORY-VAULT-LOCATOR-V1", workspaceId: identity.workspaceId,
      claimId: identity.claimId, version: identity.version,
    }));
    const objectRelative = `objects/${storageId.slice(0, 2)}/${storageId}.ciphertext.v1`;
    const keyRelative = `keys/${storageId.slice(0, 2)}/${storageId}.key.v1`;
    return {
      objectRelative, keyRelative, objectPath: resolve(this.root, objectRelative), keyPath: resolve(this.root, keyRelative),
      vaultRefSha256: sha256Hex(objectRelative), keyRefSha256: sha256Hex(keyRelative),
    };
  }

  private ensureStorageRoots(refs: VaultRefs): void {
    for (const directory of [dirname(refs.objectPath), dirname(refs.keyPath)]) {
      privateDirectory(directory);
      assertSafeExistingDirectory(this.root, directory);
    }
  }

  private validateRecord(record: MemoryVaultPrepared): void {
    requireIdentity(record);
    if (record.formatVersion !== formatVersion) throw new AuthorityIntegrityError("Memory Vault format version is unsupported");
    for (const [name, value] of Object.entries({
      authority_metadata_sha256: record.authorityMetadataSha256, body_sha256: record.bodySha256,
      vault_ref_sha256: record.vaultRefSha256, key_ref_sha256: record.keyRefSha256,
      ciphertext_sha256: record.ciphertextSha256, wrapped_key_sha256: record.wrappedKeySha256,
    })) requireSha256(value, name);
  }

  private openExisting(
    identity: MemoryVaultIdentity,
    authorityMetadataSha256: string,
    bodySha256: string,
    refs: VaultRefs,
    expected?: Pick<MemoryVaultPrepared, "ciphertextSha256" | "wrappedKeySha256">,
  ): { readonly bodyBytes: Buffer; readonly ciphertextSha256: string; readonly wrappedKeySha256: string } {
    const cipherFile = this.stableRead(refs.objectPath, this.maximumBodyBytes * 2 + 8_192);
    const keyFile = this.stableRead(refs.keyPath, 16_384);
    const ciphertextSha256 = sha256Hex(cipherFile.bytes);
    const wrappedKeySha256 = sha256Hex(keyFile.bytes);
    if (expected && (!equalSha256(ciphertextSha256, expected.ciphertextSha256)
      || !equalSha256(wrappedKeySha256, expected.wrappedKeySha256))) {
      throw new AuthorityIntegrityError("Memory Vault file hash does not match authority");
    }
    const cipher = parseRecord(cipherFile.bytes, this.maximumBodyBytes * 2 + 8_192, "ciphertext");
    const key = parseRecord(keyFile.bytes, 16_384, "wrapped key");
    exactKeys(cipher, ["schema_version", "record_type", "workspace_id", "claim_id", "version",
      "authority_metadata_sha256", "body_sha256", "nonce_base64", "ciphertext_base64", "auth_tag_base64"], "ciphertext");
    exactKeys(key, ["schema_version", "record_type", "workspace_id", "claim_id", "version",
      "authority_metadata_sha256", "body_sha256", "ciphertext_sha256", "nonce_base64", "wrapped_dek_base64",
      "auth_tag_base64"], "wrapped key");
    if (cipher.schema_version !== formatVersion || cipher.record_type !== "PCH_MEMORY_VAULT_CIPHERTEXT"
      || key.schema_version !== formatVersion || key.record_type !== "PCH_MEMORY_VAULT_WRAPPED_KEY"
      || !identityMatches(cipher, identity) || !identityMatches(key, identity)
      || cipher.authority_metadata_sha256 !== authorityMetadataSha256 || key.authority_metadata_sha256 !== authorityMetadataSha256
      || cipher.body_sha256 !== bodySha256 || key.body_sha256 !== bodySha256
      || key.ciphertext_sha256 !== ciphertextSha256) {
      throw new AuthorityIntegrityError("Memory Vault envelope binding does not match authority");
    }
    const keyNonce = base64(key.nonce_base64, 12, "key nonce");
    const wrappedDek = base64(key.wrapped_dek_base64, 32, "wrapped DEK");
    const keyTag = base64(key.auth_tag_base64, 16, "key tag");
    const dek = unseal(this.installKey, keyNonce, wrappedDek, keyTag,
      keyAad(identity, authorityMetadataSha256, bodySha256, ciphertextSha256));
    try {
      if (dek.byteLength !== 32) throw new AuthorityIntegrityError("Memory Vault DEK length is invalid");
      const nonce = base64(cipher.nonce_base64, 12, "cipher nonce");
      const encrypted = base64(cipher.ciphertext_base64, null, "ciphertext");
      const tag = base64(cipher.auth_tag_base64, 16, "cipher tag");
      const bodyBytes = unseal(dek, nonce, encrypted, tag, cipherAad(identity, authorityMetadataSha256, bodySha256));
      if (!equalSha256(sha256Hex(bodyBytes), bodySha256)) {
        bodyBytes.fill(0);
        throw new AuthorityIntegrityError("Memory Vault body hash does not match authority");
      }
      return { bodyBytes, ciphertextSha256, wrappedKeySha256 };
    } finally { dek.fill(0); }
  }

  private stableRead(path: string, maximumBytes: number): StableFile {
    assertContained(this.root, path);
    const initial = lstatSync(path, { bigint: true });
    if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1n) {
      throw new UnsafePathError("Memory Vault entry must be a single-link regular file");
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = openSync(path, constants.O_RDONLY | noFollow);
    try {
      const before = fstatSync(handle, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) {
        throw new AuthorityIntegrityError("Memory Vault entry type or size is invalid");
      }
      if (before.dev !== initial.dev || before.ino !== initial.ino) {
        throw new AuthorityIntegrityError("Memory Vault entry changed before open");
      }
      const bytes = readFileSync(handle);
      const after = fstatSync(handle, { bigint: true });
      const rebound = lstatSync(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || after.dev !== rebound.dev || after.ino !== rebound.ino
        || !samePath(realpathSync(path), path)) {
        throw new AuthorityIntegrityError("Memory Vault entry changed during stable read");
      }
      if (process.platform !== "win32" && (Number(after.mode) & 0o077) !== 0) {
        throw new UnsafePathError("Memory Vault entry permissions are not owner-only");
      }
      return { bytes, dev: after.dev, ino: after.ino, size: Number(after.size), mtimeMs: Number(after.mtimeMs) };
    } finally { closeSync(handle); }
  }

  private unlinkExpected(path: string, expectedSha256: string | null): void {
    if (!existsSync(path)) return;
    const stable = this.stableRead(path, this.maximumBodyBytes * 2 + 16_384);
    if (expectedSha256 !== null && !equalSha256(sha256Hex(stable.bytes), expectedSha256)) {
      throw new AuthorityIntegrityError("Memory Vault refused to delete a replaced file");
    }
    const rebound = lstatSync(path, { bigint: true });
    if (rebound.dev !== stable.dev || rebound.ino !== stable.ino || Number(rebound.size) !== stable.size) {
      throw new AuthorityIntegrityError("Memory Vault file changed before deletion");
    }
    unlinkSync(path);
  }

  private boundedFiles(root: string, maximum: number): string[] {
    if (maximum <= 0) return [];
    assertSafeExistingDirectory(this.root, root);
    const output: string[] = [];
    const visit = (directory: string, depth: number): void => {
      if (output.length >= maximum) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (output.length >= maximum) return;
        const path = resolve(directory, entry.name);
        assertContained(this.root, path);
        if (entry.isSymbolicLink()) throw new UnsafePathError("Memory Vault scan encountered a link");
        if (entry.isDirectory()) {
          if (depth >= 2) throw new UnsafePathError("Memory Vault scan exceeded the expected directory depth");
          assertSafeExistingDirectory(this.root, path);
          visit(path, depth + 1);
        } else if (entry.isFile()) output.push(path);
        else throw new UnsafePathError("Memory Vault scan encountered an unsupported entry type");
      }
    };
    visit(root, 0);
    return output;
  }
}
