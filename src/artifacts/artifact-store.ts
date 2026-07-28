import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { equalSha256, sha256Hex } from "../foundation/crypto.js";
import { idFromSha256 } from "../foundation/ids.js";
import { ArtifactIntegrityError } from "../foundation/errors.js";
import { assertContained, assertSafeExistingDirectory, prepareSafeRoot, publishAtomicNoReplace } from "./atomic-file.js";
import { assertArtifactProtection, type ArtifactProtection, type DataClassification } from "./classify.js";

const locatorPattern = /^pch-cas:\/\/sha256\/([a-f0-9]{64})$/u;

export interface PutArtifactOptions extends ArtifactProtection {
  readonly mediaType: string;
  readonly retentionClass: string;
}

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly classification: DataClassification;
  readonly locator: string;
  readonly encryptionKeyId: string | null;
  readonly retentionClass: string;
  readonly created: boolean;
}

export interface ArtifactVerification {
  readonly valid: boolean;
  readonly sha256: string;
  readonly byteLength: number;
}

export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = prepareSafeRoot(root);
  }

  put(content: string | Uint8Array, options: PutArtifactOptions): ArtifactRecord {
    assertArtifactProtection(options);
    if (!options.mediaType) throw new TypeError("Artifact media type is required");
    if (!options.retentionClass) throw new TypeError("Artifact retention class is required");
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const hash = sha256Hex(bytes);
    const locator = `pch-cas://sha256/${hash}`;
    const path = this.pathForHash(hash);
    const existing = this.verifyPath(path, hash);
    if (existing !== null) {
      if (!existing.valid || existing.byteLength !== bytes.byteLength) {
        throw new ArtifactIntegrityError(`CAS collision or corruption at ${locator}`);
      }
      return this.record(hash, bytes.byteLength, locator, options, false);
    }
    const publication = publishAtomicNoReplace(this.root, path, bytes);
    const verification = this.verifyPath(path, hash);
    if (verification === null || !verification.valid || verification.byteLength !== bytes.byteLength) {
      throw new ArtifactIntegrityError(`CAS collision or corruption at ${locator}`);
    }
    return this.record(hash, bytes.byteLength, locator, options, publication === "CREATED");
  }

  private record(hash: string, byteLength: number, locator: string, options: PutArtifactOptions, created: boolean): ArtifactRecord {
    return {
      artifactId: idFromSha256("ART", hash),
      sha256: hash,
      byteLength,
      mediaType: options.mediaType,
      classification: options.classification,
      locator,
      encryptionKeyId: options.encryptionKeyId ?? null,
      retentionClass: options.retentionClass,
      created,
    };
  }

  open(locator: string): Uint8Array {
    const hash = this.hashFromLocator(locator);
    const bytes = readFileSync(this.pathForHash(hash));
    const actual = sha256Hex(bytes);
    if (!equalSha256(hash, actual)) throw new ArtifactIntegrityError(`Artifact hash mismatch at ${locator}`);
    return bytes;
  }

  verify(locator: string): ArtifactVerification {
    const hash = this.hashFromLocator(locator);
    return this.verifyPath(this.pathForHash(hash), hash)
      ?? { valid: false, sha256: hash, byteLength: 0 };
  }

  private verifyPath(path: string, hash: string): ArtifactVerification | null {
    try {
      const bytes = readFileSync(path);
      const actual = sha256Hex(bytes);
      return { valid: equalSha256(hash, actual), sha256: actual, byteLength: bytes.byteLength };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  retain(locator: string): ArtifactVerification {
    const verification = this.verify(locator);
    if (!verification.valid) throw new ArtifactIntegrityError(`Cannot retain invalid artifact ${locator}`);
    return verification;
  }

  private hashFromLocator(locator: string): string {
    const match = locatorPattern.exec(locator);
    const hash = match?.[1];
    if (!hash) throw new ArtifactIntegrityError(`Invalid CAS locator: ${locator}`);
    return hash;
  }

  private pathForHash(hash: string): string {
    prepareSafeRoot(this.root);
    const path = join(this.root, hash.slice(0, 2), hash);
    assertContained(this.root, path);
    const directory = dirname(path);
    if (existsSync(directory)) assertSafeExistingDirectory(this.root, directory);
    return path;
  }
}
