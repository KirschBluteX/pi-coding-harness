import { ArtifactIntegrityError } from "../foundation/errors.js";

export type DataClassification = "PUBLIC" | "INTERNAL" | "SENSITIVE" | "SECRET";

export interface ArtifactProtection {
  readonly classification: DataClassification;
  readonly encrypted?: boolean;
  readonly encryptionKeyId?: string;
}

export function assertArtifactProtection(protection: ArtifactProtection): void {
  if (protection.classification !== "SECRET") return;
  if (!protection.encrypted || !protection.encryptionKeyId) {
    throw new ArtifactIntegrityError("SECRET artifact bytes require caller-provided encryption and an encryption key ID");
  }
}
