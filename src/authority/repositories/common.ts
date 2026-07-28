import type { ArtifactRecord } from "../../artifacts/artifact-store.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import type { AuthorityConnection } from "../database.js";

export type ArtifactMetadata = Omit<ArtifactRecord, "created">;

export function registerArtifact(connection: AuthorityConnection, artifact: ArtifactMetadata, createdAtMs: number): void {
  connection.prepare(`INSERT OR IGNORE INTO artifacts(
    artifact_id, sha256, byte_length, media_type, classification, locator, encryption_key_id, created_at_ms, retention_class
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    artifact.artifactId, artifact.sha256, artifact.byteLength, artifact.mediaType, artifact.classification,
    artifact.locator, artifact.encryptionKeyId, createdAtMs, artifact.retentionClass,
  );
  const row = connection.prepare("SELECT artifact_id, byte_length, media_type, classification, locator, encryption_key_id, retention_class FROM artifacts WHERE sha256 = ?").get(artifact.sha256) as Record<string, unknown> | undefined;
  if (!row
    || row.artifact_id !== artifact.artifactId
    || row.byte_length !== artifact.byteLength
    || row.media_type !== artifact.mediaType
    || row.classification !== artifact.classification
    || row.locator !== artifact.locator
    || (row.encryption_key_id ?? null) !== artifact.encryptionKeyId
    || row.retention_class !== artifact.retentionClass) {
    throw new AuthorityIntegrityError(`Artifact metadata substitution detected for ${artifact.sha256}`);
  }
}
